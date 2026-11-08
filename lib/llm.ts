import { cached, DAY } from "./cache";

// Model routing. Two tiers only:
//   fast  — bulk extraction (bio from a filing, guidance statements from a transcript chunk)
//   smart — the one reasoning step that matters (promised vs delivered, bull/bear)
// Provider is picked from whichever key is present. Every call is cached by prompt hash,
// so the same filing/transcript is never paid for twice.

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

export function modelInfo() {
  const p = provider();
  return p ? { provider: p, fast: model("fast"), smart: model("smart") } : null;
}

async function call(tier: Tier, system: string, prompt: string, maxTokens: number): Promise<string> {
  const p = provider();
  if (p === "gemini") {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model(tier)}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY! },
        signal: AbortSignal.timeout(60_000),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: maxTokens, responseMimeType: "application/json" },
        }),
      },
    );
    if (!r.ok) throw new Error(`gemini ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    return j.candidates?.[0]?.content?.parts?.map((x: { text?: string }) => x.text ?? "").join("") ?? "";
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
        model: model(tier),
        max_tokens: maxTokens,
        system: system + "\nRespond with JSON only, no prose, no code fences.",
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!r.ok) throw new Error(`anthropic ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    return j.content?.map((x: { text?: string }) => x.text ?? "").join("") ?? "";
  }
  throw new Error("no LLM key configured");
}

export async function llmJSON<T>(tier: Tier, system: string, prompt: string, maxTokens = 1500): Promise<T | null> {
  if (!provider()) return null;
  try {
    const raw = await cached(`llm:${model(tier)}:${system}:${prompt}`, 30 * DAY, () => call(tier, system, prompt, maxTokens));
    const s = raw.replace(/^```(json)?/m, "").replace(/```\s*$/m, "").trim();
    const start = s.search(/[[{]/);
    return JSON.parse(s.slice(start)) as T;
  } catch (e) {
    console.error("llm failed", (e as Error).message);
    return null;
  }
}
