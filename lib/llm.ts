import { cached, DAY, forget } from "./cache";

// Model routing. Two tiers only:
//   fast  — bulk extraction (bio from a filing, guidance statements from a transcript chunk)
//   smart — the one reasoning step that matters (promised vs delivered, bull/bear)
// Provider is picked from whichever key is present. Every call is cached by prompt hash,
// so the same filing/transcript is never paid for twice. Only parseable JSON is cached.

type Tier = "fast" | "smart";

export function provider(): "gemini" | "anthropic" | null {
  if (process.env.GEMINI_API_KEY) return "gemini";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  return null;
}

function model(tier: Tier) {
  if (provider() === "gemini")
    return tier === "fast" ? process.env.GEMINI_FAST ?? "gemini-3.1-flash-lite" : process.env.GEMINI_SMART ?? "gemini-3-flash-preview";
  return tier === "fast" ? process.env.CLAUDE_FAST ?? "claude-haiku-5-5" : process.env.CLAUDE_SMART ?? "claude-sonnet-5-5";
}

// If the primary model is out of quota (free tiers cap some models at ~20 requests/day) or
// overloaded, walk down a chain instead of failing. The answer is cached under the primary key.
function chain(tier: Tier): string[] {
  const list = (v?: string) => (v ? v.split(",").map((x) => x.trim()).filter(Boolean) : []);
  const c = provider() === "gemini"
    ? tier === "smart"
      ? [model("smart"), ...list(process.env.GEMINI_SMART_FALLBACK ?? "gemini-3.5-flash"), model("fast")]
      : [model("fast"), ...list(process.env.GEMINI_FAST_FALLBACK ?? "gemini-3.5-flash-lite")]
    : tier === "smart" ? [model("smart"), model("fast")] : [model("fast")];
  return [...new Set(c)];
}

export function modelInfo() {
  const p = provider();
  return p ? { provider: p, fast: model("fast"), smart: model("smart") } : null;
}

// Gemini 3 / 2.5 models "think" by default and thinking tokens count against maxOutputTokens —
// left unchecked they silently truncate the JSON. Fast tier: no thinking. Smart tier: a little.
function thinking(m: string, tier: Tier) {
  if (/gemini-3/.test(m)) return { thinkingLevel: tier === "fast" ? "minimal" : "low" };
  if (/gemini-2\.5/.test(m)) return { thinkingBudget: tier === "fast" ? (/pro/.test(m) ? 128 : 0) : 1024 };
  return undefined;
}

class LLMError extends Error {
  constructor(msg: string, public retryable = false) {
    super(msg);
  }
}

async function call(m: string, tier: Tier, system: string, prompt: string, maxTokens: number): Promise<string> {
  const p = provider();
  if (p === "gemini") {
    const think = thinking(m, tier);
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY! },
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          // Headroom for thinking tokens so the visible answer is never cut short.
          maxOutputTokens: maxTokens + (think ? (tier === "smart" ? 4096 : 1024) : 0),
          responseMimeType: "application/json",
          ...(think ? { thinkingConfig: think } : {}),
        },
      }),
    });
    if (!r.ok) throw new LLMError(`gemini ${m} ${r.status}: ${(await r.text()).replace(/\s+/g, " ").slice(0, 140)}`, r.status === 429 || r.status === 404 || r.status >= 500);
    const j = await r.json();
    const cand = j.candidates?.[0];
    if (cand?.finishReason === "MAX_TOKENS") throw new LLMError("gemini: output truncated (MAX_TOKENS)");
    return cand?.content?.parts?.map((x: { text?: string; thought?: boolean }) => (x.thought ? "" : x.text ?? "")).join("") ?? "";
  }
  if (p === "anthropic") {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY!,
        "anthropic-version": "2023-06-01",
      },
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({
        model: m,
        max_tokens: maxTokens,
        system: system + "\nRespond with JSON only, no prose, no code fences.",
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!r.ok) throw new LLMError(`anthropic ${m} ${r.status}: ${(await r.text()).replace(/\s+/g, " ").slice(0, 140)}`, r.status === 429 || r.status === 404 || r.status >= 500);
    const j = await r.json();
    if (j.stop_reason === "max_tokens") throw new LLMError("anthropic: output truncated (max_tokens)");
    return j.content?.map((x: { text?: string }) => x.text ?? "").join("") ?? "";
  }
  throw new LLMError("no LLM key configured");
}

function parse<T>(raw: string): T {
  const s = raw.replace(/^```(json)?/m, "").replace(/```\s*$/m, "").trim();
  const start = s.search(/[[{]/);
  if (start < 0) throw new Error("no JSON in model output");
  return JSON.parse(s.slice(start)) as T;
}


export type LLMResult<T> = { value: T | null; model: string; ms: number; cached: boolean; promptChars: number; error?: string };

// Full-detail variant: value plus model, latency, cache hit and prompt size (for the efficiency
// readout). `timeoutMs` caps how long the CALLER waits; the request keeps running in the
// background and lands in the cache, so the next view is complete even if this one wasn't.
export async function llm<T>(
  tier: Tier,
  system: string,
  prompt: string,
  maxTokens = 1500,
  opts: { timeoutMs?: number } = {},
): Promise<LLMResult<T>> {
  const t0 = Date.now();
  const m = model(tier);
  const base = { model: m, promptChars: system.length + prompt.length };
  if (!provider()) return { ...base, value: null, ms: 0, cached: false, error: "no LLM key configured" };
  const key = `llm:${m}:${system}:${prompt}`;
  let fresh = false;
  let used = m;
  type Entry = string | { raw: string; model: string }; // older builds cached the bare string
  const work = async (): Promise<Entry> => {
    fresh = true;
    let lastErr: unknown;
    for (const mm of chain(tier)) {
      try {
        const raw = await call(mm, tier, system, prompt, maxTokens);
        parse(raw); // throws on malformed JSON, so a bad answer is never cached
        return { raw, model: mm };
      } catch (e) {
        lastErr = e;
        console.error(`llm ${tier} ${mm} failed:`, (e as Error).message.slice(0, 160));
        // Quota / overload / missing model: next model. Bad JSON or truncation: retry once on the next one too.
      }
    }
    throw lastErr;
  };
  const open = (e: Entry) => { if (typeof e !== "string") used = e.model; return parse<T>(typeof e === "string" ? e : e.raw); };
  const run = (async () => {
    const e = await cached<Entry>(key, 30 * DAY, work);
    try {
      return open(e);
    } catch {
      // A malformed answer cached by an older build: drop it and ask once more.
      await forget(key);
      return open(await cached<Entry>(key, 30 * DAY, work));
    }
  })();
  run.catch((e) => console.error(`llm ${tier} failed`, (e as Error).message));
  const TIMEOUT = Symbol("timeout");
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const value = opts.timeoutMs
      ? await Promise.race([run, new Promise<typeof TIMEOUT>((r) => (timer = setTimeout(() => r(TIMEOUT), Math.max(0, opts.timeoutMs!))))])
      : await run;
    clearTimeout(timer);
    if (value === TIMEOUT) throw new Error(`timed out after ${opts.timeoutMs}ms (still running; will be cached)`);
    return { ...base, model: used, value: value as T, ms: Date.now() - t0, cached: !fresh };
  } catch (e) {
    return { ...base, value: null, ms: Date.now() - t0, cached: false, error: (e as Error).message };
  }
}

export async function llmJSON<T>(tier: Tier, system: string, prompt: string, maxTokens = 1500, opts: { timeoutMs?: number } = {}): Promise<T | null> {
  return (await llm<T>(tier, system, prompt, maxTokens, opts)).value;
}
