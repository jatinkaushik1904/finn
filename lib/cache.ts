import { createHash } from "crypto";
import { promises as fs } from "fs";
import os from "os";
import path from "path";

// Two-level cache: in-memory (per lambda instance) + JSON files in the OS temp dir.
// Every expensive thing (scrapes, PDF text, LLM calls) goes through here, keyed by
// content, so we never pay twice for the same filing or transcript.
// Concurrent callers of the same key share one in-flight promise (the research and
// narrative routes are hit together by the UI and both need the same screener page).
const mem = new Map<string, { at: number; v: unknown }>();
const inflight = new Map<string, Promise<unknown>>();
const DIR = path.join(os.tmpdir(), "finn-cache");

export function hash(s: string) {
  return createHash("sha256").update(s).digest("hex").slice(0, 24);
}

export async function cached<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
  keep: (v: T) => boolean = () => true, // only persist values worth keeping (e.g. complete results)
): Promise<T> {
  const k = hash(key);
  const now = Date.now();
  const m = mem.get(k);
  if (m && now - m.at < ttlMs) return m.v as T;
  const file = path.join(DIR, k + ".json");
  try {
    const raw = JSON.parse(await fs.readFile(file, "utf8"));
    if (now - raw.at < ttlMs) {
      mem.set(k, raw);
      return raw.v as T;
    }
  } catch {}
  const running = inflight.get(k);
  if (running) return running as Promise<T>;
  const p = (async () => {
    try {
      const v = await fn();
      if (keep(v)) {
        const entry = { at: Date.now(), v };
        mem.set(k, entry);
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
