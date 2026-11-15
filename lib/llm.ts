import { cached, DAY, forget, HOUR } from "./cache";

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
  constructor(msg: string, public retryable = false, public retryInMs?: number) {
    super(msg);
  }
}

// ---------------------------------------------------------------- rate limiting
// Free tiers meter requests per minute, per model (measured on this key: 15/min for
// gemini-3.1-flash-lite, quota id GenerateRequestsPerMinutePerProjectPerModel-FreeTier) and,
// for the stronger models, per day (20/day for gemini-3-flash-preview).
// A sliding one-minute window per model keeps a burst — a 30-day brief reading 16 results
// filings — under the limit instead of burning calls on 429s. When a model has no slot, work
// spills to the next model in the chain (each has its own quota); only when every model is
// full does it wait. A 429's own retry delay is honoured.
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const rpmOf = (m: string) =>
  provider() === "anthropic" ? Number(process.env.LLM_RPM) || 40
  : /lite/.test(m) ? Number(process.env.LLM_RPM_LITE) || 12
  : Number(process.env.LLM_RPM_FLASH) || 6;
const stamps = new Map<string, number[]>();
const backoff = new Map<string, number>(); // model → don't call before this time (from a 429)
/** ms until `m` has a free slot (0 = now). */
function slotIn(m: string, now = Date.now()) {
  const s = (stamps.get(m) ?? []).filter((t) => now - t < 60_000);
  stamps.set(m, s);
  return Math.max(0, (backoff.get(m) ?? 0) - now, s.length >= rpmOf(m) ? s[0] + 60_000 - now : 0);
}
const take = (m: string) => stamps.set(m, [...(stamps.get(m) ?? []), Date.now()]);
/** What the limiter is holding back right now (for /api/health). */
export const llmLoad = () => Object.fromEntries([...stamps].map(([m, s]) => [m, { lastMinute: s.filter((t) => Date.now() - t < 60_000).length, perMinute: rpmOf(m), waitMs: slotIn(m) }]));

async function fail(provider: string, m: string, r: Response): Promise<never> {
  const text = await r.text();
  let retryInMs: number | undefined;
  let quota = "";
  if (r.status === 429) {
    try {
      const details = (JSON.parse(text).error?.details ?? []) as { "@type"?: string; retryDelay?: string; violations?: { quotaId?: string; quotaValue?: string }[] }[];
      const d = details.find((x) => x.retryDelay)?.retryDelay;
      if (d) retryInMs = Math.ceil(parseFloat(d) * 1000);
      const v = details.flatMap((x) => x.violations ?? [])[0];
      if (v?.quotaId) quota = ` [${v.quotaId}${v.quotaValue ? ` = ${v.quotaValue}` : ""}${d ? `, retry in ${d}` : ""}]`;
    } catch {}
    retryInMs ??= (Number(r.headers.get("retry-after")) || 20) * 1000;
  } else if (r.status >= 500) retryInMs = 4000; // overloaded: give it a moment, use the next model meanwhile
  throw new LLMError(`${provider} ${m} ${r.status}${quota}: ${text.replace(/\s+/g, " ").slice(0, 140)}`, r.status === 429 || r.status === 404 || r.status >= 500, retryInMs);
}

// A PDF the model reads itself — for filings with no usable text layer (scans), where text
// extraction has nothing to give. Gemini takes it inline up to ~14 MB (base64 inflates by a third
// against the 20 MB request cap) and through the Files API above that; Claude takes a base64
// "document" block up to the 32 MB request cap.
const GEMINI_INLINE_MAX = 14 * 1024 * 1024;
const CLAUDE_INLINE_MAX = 22 * 1024 * 1024;
const b64 = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("base64");
// Several page images travel as one byte array (concatenated PNGs) so they load and hash as one.
function splitPngs(b: Uint8Array): Uint8Array[] {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const starts: number[] = [];
  for (let i = 0; i + 8 <= b.length; i++) if (sig.every((v, k) => b[i + k] === v) && (i === 0 || (b[i - 8] === 0x49 && b[i - 7] === 0x45 && b[i - 6] === 0x4e && b[i - 5] === 0x44))) starts.push(i);
  return starts.map((s, k) => b.subarray(s, starts[k + 1] ?? b.length));
}

// Gemini Files API (resumable upload, two requests). Uploaded files live 48h: the URI is cached
// for 46h by content hash, so the same filing is uploaded once.
async function geminiFile(pdf: Uint8Array, sha: string): Promise<string> {
  return cached(`gemini-file:${sha}`, 46 * HOUR, async () => {
    const key = process.env.GEMINI_API_KEY!;
    const start = await fetch("https://generativelanguage.googleapis.com/upload/v1beta/files", {
      method: "POST",
      headers: {
        "x-goog-api-key": key,
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(pdf.byteLength),
        "X-Goog-Upload-Header-Content-Type": "application/pdf",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ file: { display_name: `filing-${sha.slice(0, 12)}.pdf` } }),
      signal: AbortSignal.timeout(20_000),
    });
    const url = start.headers.get("x-goog-upload-url");
    if (!start.ok || !url) throw new LLMError(`gemini upload start ${start.status}`, start.status === 429 || start.status >= 500);
    const up = await fetch(url, {
      method: "POST",
      headers: { "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize", "Content-Type": "application/pdf" },
      body: new Blob([new Uint8Array(pdf)], { type: "application/pdf" }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!up.ok) throw new LLMError(`gemini upload ${up.status}`, up.status === 429 || up.status >= 500);
    let f = (await up.json()).file as { name: string; uri: string; state?: string };
    for (let i = 0; f.state === "PROCESSING" && i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/${f.name}`, { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(10_000) });
      if (r.ok) f = await r.json();
    }
    if (f.state && f.state !== "ACTIVE") throw new LLMError(`gemini file ${f.state}`);
    return f.uri;
  });
}

type Media = { pdf?: { bytes: Uint8Array; sha: string }; images?: Uint8Array[] };

async function call(m: string, tier: Tier, system: string, prompt: string, maxTokens: number, media: Media = {}): Promise<string> {
  const { pdf, images = [] } = media;
  const p = provider();
  if (p === "gemini") {
    const think = thinking(m, tier);
    const doc = !pdf ? [] : pdf.bytes.byteLength <= GEMINI_INLINE_MAX
      ? [{ inline_data: { mime_type: "application/pdf", data: b64(pdf.bytes) } }]
      : [{ file_data: { mime_type: "application/pdf", file_uri: await geminiFile(pdf.bytes, pdf.sha) } }];
    const pics = images.map((b) => ({ inline_data: { mime_type: "image/png", data: b64(b) } }));
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY! },
      signal: AbortSignal.timeout(pdf || images.length ? 90_000 : tier === "smart" ? 40_000 : 30_000),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [...doc, ...pics, { text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          // Headroom for thinking tokens so the visible answer is never cut short.
          maxOutputTokens: maxTokens + (think ? (tier === "smart" ? 4096 : 1024) : 0),
          responseMimeType: "application/json",
          ...(think ? { thinkingConfig: think } : {}),
        },
      }),
    });
    if (!r.ok) await fail("gemini", m, r);
    const j = await r.json();
    const cand = j.candidates?.[0];
    if (cand?.finishReason === "MAX_TOKENS") throw new LLMError("gemini: output truncated (MAX_TOKENS)");
    return cand?.content?.parts?.map((x: { text?: string; thought?: boolean }) => (x.thought ? "" : x.text ?? "")).join("") ?? "";
  }
  if (p === "anthropic") {
    if (pdf && pdf.bytes.byteLength > CLAUDE_INLINE_MAX) throw new LLMError(`anthropic: PDF of ${Math.round(pdf.bytes.byteLength / 1e6)} MB exceeds the inline document limit`);
    const content = pdf || images.length
      ? [
          ...(pdf ? [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: b64(pdf.bytes) } }] : []),
          ...images.map((b) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: b64(b) } })),
          { type: "text", text: prompt },
        ]
      : prompt;
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY!,
        "anthropic-version": "2023-06-01",
      },
      signal: AbortSignal.timeout(pdf || images.length ? 90_000 : tier === "smart" ? 40_000 : 30_000),
      body: JSON.stringify({
        model: m,
        max_tokens: maxTokens,
        system: system + "\nRespond with JSON only, no prose, no code fences.",
        messages: [{ role: "user", content }],
      }),
    });
    if (!r.ok) await fail("anthropic", m, r);
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
  // `pdf`: the model reads this PDF (identified by its SHA-256) alongside the prompt. The bytes
  // are loaded only on a cache miss, and the cache key carries the hash, never the bytes.
  // `images`: PNG page images the model reads (scans whose text layer can't be trusted), same idea.
  opts: {
    timeoutMs?: number;
    pdf?: { sha: string; load: () => Promise<Uint8Array> };
    images?: { sha: string; load: () => Promise<Uint8Array> };
    // The caller's shape check. An answer that fails it is treated like malformed JSON: not
    // cached, and the next model in the chain is asked.
    accept?: (value: unknown) => boolean;
  } = {},
): Promise<LLMResult<T>> {
  const t0 = Date.now();
  const m = model(tier);
  const base = { model: m, promptChars: system.length + prompt.length };
  if (!provider()) return { ...base, value: null, ms: 0, cached: false, error: "no LLM key configured" };
  const key = `llm:${m}:${system}:${prompt}${opts.pdf ? `:pdf:${opts.pdf.sha}` : ""}${opts.images ? `:img:${opts.images.sha}` : ""}`;
  let fresh = false;
  let used = m;
  type Entry = string | { raw: string; model: string }; // older builds cached the bare string
  const work = async (): Promise<Entry> => {
    fresh = true;
    let lastErr: unknown;
    const media: Media = {
      pdf: opts.pdf ? { bytes: await opts.pdf.load(), sha: opts.pdf.sha } : undefined,
      images: opts.images ? splitPngs(await opts.images.load()) : undefined,
    };
    // Up to three passes over the chain, inside a budget that may outlive the caller's own timeout
    // (the answer still lands in the cache). A model with no free slot is skipped, not waited on;
    // a model that gave a malformed or truncated answer is not asked the same thing again.
    const models = chain(tier);
    const giveUp = Date.now() + 110_000;
    const dead = new Set<string>();
    for (let pass = 0; pass < 3; pass++) {
      for (const mm of models) {
        if (dead.has(mm) || slotIn(mm) > 0) continue;
        take(mm);
        try {
          const raw = await call(mm, tier, system, prompt, maxTokens, media);
          const parsed = parse(raw); // throws on malformed JSON, so a bad answer is never cached
          if (opts.accept && !opts.accept(parsed)) throw new LLMError(`${mm}: answer is not in the shape asked for`);
          return { raw, model: mm };
        } catch (e) {
          lastErr = e;
          const err = e as LLMError;
          const transient = err.retryable === true || err.name === "TimeoutError" || err.name === "AbortError";
          // A per-minute limit says "retry in 40s"; a per-day one says "retry in 22h" (measured: the
          // free tier allows gemini-3-flash-preview 20 requests a day). Either way, leave that model
          // alone until then (capped at 6h, and only for this instance) and use the next in the chain.
          if (err.retryInMs) backoff.set(mm, Date.now() + Math.min(err.retryInMs, 6 * 3600_000));
          // A model that hung once will probably hang again: skip it for two minutes.
          if (err.name === "TimeoutError" || err.name === "AbortError") backoff.set(mm, Date.now() + 120_000);
          if (!transient) dead.add(mm);
          console.error(`llm ${tier} ${mm} failed:`, String(err.message).slice(0, 220));
        }
      }
      const live = models.filter((mm) => !dead.has(mm));
      if (!live.length) break;
      const wait = Math.min(...live.map((mm) => slotIn(mm)));
      if (Date.now() + wait + 2000 > giveUp) break;
      await sleep(wait + 50 + Math.random() * 200);
    }
    throw lastErr ?? new LLMError("rate limited: no model had a free slot in time", true);
  };
  const open = (e: Entry) => {
    if (typeof e !== "string") used = e.model;
    const v = parse<T>(typeof e === "string" ? e : e.raw);
    if (opts.accept && !opts.accept(v)) throw new Error("cached answer is not in the shape asked for");
    return v;
  };
  const run = (async () => {
    const e = await cached<Entry>(key, 30 * DAY, work, undefined, { immutable: true });
    try {
      return open(e);
    } catch {
      // A malformed answer cached by an older build: drop it and ask once more.
      await forget(key);
      return open(await cached<Entry>(key, 30 * DAY, work, undefined, { immutable: true }));
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

export async function llmJSON<T>(tier: Tier, system: string, prompt: string, maxTokens = 1500, opts: Parameters<typeof llm>[4] = {}): Promise<T | null> {
  return (await llm<T>(tier, system, prompt, maxTokens, opts)).value;
}
