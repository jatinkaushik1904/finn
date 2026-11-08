import { createHash } from "crypto";
import { promises as fs } from "fs";
import os from "os";
import path from "path";

// Two-level cache: in-memory (per lambda instance) + JSON files in the OS temp dir.
// Every expensive thing (scrapes, PDF text, LLM calls) goes through here, keyed by
// content, so we never pay twice for the same filing or transcript.
const mem = new Map<string, { at: number; v: unknown }>();
const DIR = path.join(os.tmpdir(), "finn-cache");

export function hash(s: string) {
  return createHash("sha256").update(s).digest("hex").slice(0, 24);
}

export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
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
  const v = await fn();
  const entry = { at: now, v };
  mem.set(k, entry);
  try {
    await fs.mkdir(DIR, { recursive: true });
    await fs.writeFile(file, JSON.stringify(entry));
  } catch {}
  return v;
}

export const HOUR = 3600_000;
export const DAY = 24 * HOUR;
