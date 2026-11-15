import { createHash } from "crypto";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { gunzipSync, gzipSync } from "zlib";

// Three-level cache: in-memory (per lambda instance) → JSON files in the OS temp dir → a
// read-only SEED shipped with the deployment (data/seed, gzipped JSON).
// Every expensive thing (scrapes, PDF text, LLM calls) goes through here, keyed by content, so
// we never pay twice for the same filing or transcript.
//
// The seed is what makes a cold serverless instance fast and cheap: anything that is a pure
// function of an immutable input (the text of a filing PDF, a model's answer to an exact prompt,
// the checked numbers of a results filing) is computed once before deploy and travels with the
// code. Callers mark those keys `immutable`; live data (prices, the filings list) never is.
// Concurrent callers of the same key share one in-flight promise (the research and narrative
// routes are hit together by the UI and both need the same screener page).
type Entry = { at: number; v: unknown; k?: string };
const mem = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();
const DIR = path.join(os.tmpdir(), "finn-cache");
const SEED = path.join(process.cwd(), "data/seed");

export function hash(s: string) {
  return createHash("sha256").update(s).digest("hex").slice(0, 24);
}

// The kind of thing a key holds ("llm", "pdf", "results"…): stored with the entry so the seed
// builder can pick what is worth shipping without knowing the key.
const kindOf = (key: string) => key.slice(0, key.search(/[:\s]|$/)).slice(0, 24);

async function readSeed(k: string): Promise<Entry | null> {
  try {
    return JSON.parse(gunzipSync(await fs.readFile(path.join(SEED, k + ".json.gz"))).toString("utf8")) as Entry;
  } catch {
    return null;
  }
}

export const cacheStats = { mem: 0, disk: 0, seed: 0, miss: 0 };

// Building the seed: run the app once with FINN_SEED_RECORD=data/seed and open what a visitor
// would (scripts/warm.mjs does). Every immutable value that run touches — fresh or already cached —
// is written to the seed folder, gzipped. Nothing else ever writes there.
const RECORD = process.env.FINN_SEED_RECORD ? path.resolve(process.env.FINN_SEED_RECORD) : null;
const recorded = new Set<string>();
// FINN_SEED_DEEP=1 (with FINN_SEED_RECORD): rebuild each assembled answer (a results card, a
// narrative, a management sheet) once instead of reusing the cached one, so the pieces under it —
// PDF text, model answers — are touched and land in the seed too. Costs no model calls when
// those pieces are already cached locally.
const DEEP = !!RECORD && process.env.FINN_SEED_DEEP === "1";
const ASSEMBLED = /^(results|narr|people|filed):/;
const rebuilt = new Set<string>();
async function record(k: string, e: Entry) {
  if (!RECORD || recorded.has(k)) return;
  recorded.add(k);
  try {
    await fs.mkdir(RECORD, { recursive: true });
    await fs.writeFile(path.join(RECORD, k + ".json.gz"), gzipSync(JSON.stringify({ at: e.at, v: e.v, k: e.k })));
  } catch {}
}

export async function cached<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
  keep: (v: T) => boolean = () => true, // only persist values worth keeping (e.g. complete results)
  opts: { immutable?: boolean } = {}, // the value can never change for this key: a seeded copy of any age is valid
): Promise<T> {
  const k = hash(key);
  const now = Date.now();
  const rebuild = DEEP && ASSEMBLED.test(key) && !rebuilt.has(k);
  const m = mem.get(k);
  if (m && now - m.at < ttlMs && !rebuild) { cacheStats.mem++; if (opts.immutable) void record(k, m); return m.v as T; }
  const file = path.join(DIR, k + ".json");
  try {
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as Entry;
    if (now - raw.at < ttlMs && !rebuild) {
      mem.set(k, raw);
      cacheStats.disk++;
      if (opts.immutable) void record(k, raw);
      return raw.v as T;
    }
  } catch {}
  if (opts.immutable && !rebuild) {
    const s = await readSeed(k);
    if (s) {
      // Re-stamped in memory only: valid for this instance's lifetime, never rewritten to disk.
      mem.set(k, { at: now, v: s.v, k: s.k });
      cacheStats.seed++;
      return s.v as T;
    }
  }
  const running = inflight.get(k);
  if (running) return running as Promise<T>;
  cacheStats.miss++;
  const p = (async () => {
    try {
      const v = await fn();
      if (keep(v)) {
        rebuilt.add(k);
        const entry: Entry = { at: Date.now(), v, k: `${opts.immutable ? "!" : ""}${kindOf(key)}` };
        mem.set(k, entry);
        if (opts.immutable) void record(k, entry);
        try {
          await fs.mkdir(DIR, { recursive: true });
          await fs.writeFile(file, JSON.stringify(entry));
        } catch {}
      }
      return v;
    } finally {
      inflight.delete(k);
    }
  })();
  inflight.set(k, p);
  return p;
}

// Drop a cached value (used when a stored value turns out to be unusable).
export async function forget(key: string) {
  const k = hash(key);
  mem.delete(k);
  try {
    await fs.unlink(path.join(DIR, k + ".json"));
  } catch {}
}

export const HOUR = 3600_000;
export const DAY = 24 * HOUR;
