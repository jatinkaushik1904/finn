#!/usr/bin/env node
// Warm a running FINN and (with FINN_SEED_RECORD set on the server) record the seed cache.
//
//   FINN_SEED_RECORD=data/seed npm run dev          # terminal 1: every immutable value touched is saved
//   node scripts/warm.mjs http://localhost:3000     # terminal 2: open what a visitor would open
//
// It asks for each digest window, then research, promised-vs-delivered and management for the
// demo picks and every holding, one company at a time (free LLM tiers allow ~15 requests/minute;
// the server queues the rest). Re-running is cheap: everything already read is a cache hit.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const BASE = (process.argv[2] || "http://localhost:3000").replace(/\/$/, "");
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const universe = readFileSync(path.join(root, "data/universe.ts"), "utf8");
const portfolio = [...universe.matchAll(/symbol:\s*"([A-Z0-9&-]+)"/g)].map((m) => m[1]);
const picks = (universe.match(/RESEARCH_PICKS\s*=\s*\[([^\]]+)\]/)?.[1] ?? "").split(",").map((s) => s.replace(/[^A-Z0-9&-]/g, "")).filter(Boolean);
const only = process.argv[3] ? process.argv[3].split(",") : null;
const symbols = only ?? [...new Set([...picks, ...portfolio])];

const get = async (p, timeoutMs = 120_000) => {
  const t = Date.now();
  try {
    const r = await fetch(BASE + p, { signal: AbortSignal.timeout(timeoutMs) });
    return { j: await r.json().catch(() => ({ error: `HTTP ${r.status}` })), s: ((Date.now() - t) / 1000).toFixed(1) };
  } catch (e) {
    return { j: { error: String(e.message).slice(0, 80) }, s: ((Date.now() - t) / 1000).toFixed(1) };
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tally = (vs) => Object.entries((vs ?? []).reduce((a, v) => ((a[v.verdict] = (a[v.verdict] ?? 0) + 1), a), {})).map(([k, n]) => `${n} ${k}`).join(", ") || "no verdicts";

const h = await get("/api/health?llm=1");
console.log(`health ${h.s}s`, (h.j.probes ?? []).map((p) => `${p.name}:${p.ok ? "ok" : p.optional ? "blocked(optional)" : "FAIL"}`).join(" "));

if (!only) for (const hours of [24, 72, 168, 720]) {
  for (let i = 0; i < 10; i++) {
    const { j, s } = await get(`/api/brief?hours=${hours}`);
    if (j.error) { console.log(`brief ${hours}h ${s}s ERROR ${j.error}`); break; }
    const res = j.items.filter((x) => x.results && !x.collapsedInto);
    const pending = res.filter((x) => x.results.pending).length;
    console.log(`brief ${hours}h ${s}s source=${j.source} filings=${j.stats.total} material=${j.stats.material} results=${res.filter((x) => x.results.from === "filing").length}/${res.length} from the filing${pending ? `, ${pending} still being read` : ""} people=${j.items.filter((x) => x.person).length}`);
    if (!pending) break;
    await sleep(8000);
  }
}

for (const sym of symbols) {
  const r = await get(`/api/research/${sym}`);
  console.log(`${sym} research ${r.s}s`, r.j.error ? `ERROR ${r.j.error}` : `${r.j.name}${r.j.snapshot ? " (snapshot)" : ""}`);
  if (r.j.error) continue;
  for (let i = 0; i < 4; i++) {
    const n = await get(`/api/narrative/${sym}`);
    console.log(`${sym} narrative ${n.s}s`, n.j.error ? `ERROR ${n.j.error}` : `${n.j.partial ? "PARTIAL " : ""}${(n.j.calls ?? []).length} calls · ${tally(n.j.verdicts)}`);
    if (!n.j.partial && !n.j.error) break;
    await sleep(15_000);
  }
  for (let i = 0; i < 4; i++) {
    const p = await get(`/api/people/${sym}`);
    console.log(`${sym} people ${p.s}s`, p.j.error ? `ERROR ${p.j.error}` : `${p.j.partial ? "PARTIAL " : ""}${(p.j.people ?? []).length} people (${(p.j.people ?? []).filter((x) => x.bio).length} with a filed profile) · ${(p.j.askAbout ?? []).length} things to ask`);
    if (!p.j.partial && !p.j.error) break;
    await sleep(12_000);
  }
}
console.log("done");
