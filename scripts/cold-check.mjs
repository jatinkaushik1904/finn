#!/usr/bin/env node
// Does the shipped seed really cover a cold start? Run against a server whose temp cache is
// empty (a fresh deploy, or locally: move $TMPDIR/finn-cache aside and `next start`).
// Passes when every digest window and every warmed company answers without one model call.
//   node scripts/cold-check.mjs https://your-deployment
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const BASE = (process.argv[2] || "http://localhost:3000").replace(/\/$/, "");
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const universe = readFileSync(path.join(root, "data/universe.ts"), "utf8");
const portfolio = [...universe.matchAll(/symbol:\s*"([A-Z0-9&-]+)"/g)].map((m) => m[1]);
const picks = (universe.match(/RESEARCH_PICKS\s*=\s*\[([^\]]+)\]/)?.[1] ?? "").split(",").map((s) => s.replace(/[^A-Z0-9&-]/g, "")).filter(Boolean);
const symbols = [...new Set([...picks, ...portfolio])];
const get = async (p) => { const t = Date.now(); const r = await fetch(BASE + p, { signal: AbortSignal.timeout(100_000) }); return { j: await r.json(), ms: Date.now() - t }; };
const calls = async () => Object.values((await get("/api/health")).j.llmLoad ?? {}).reduce((a, m) => a + (m.lastMinute ?? 0), 0);
let bad = 0;
const before = await calls();
for (const h of [24, 72, 168, 720]) {
  const { j, ms } = await get(`/api/brief?hours=${h}`);
  const res = (j.items ?? []).filter((x) => x.category === "results" && !x.collapsedInto && x.priority >= 45);
  const fromFiling = res.filter((x) => x.results?.from === "filing").length;
  const ok = j.source === "live" && fromFiling === res.length && ms < 15_000;
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} brief ${h}h ${(ms / 1000).toFixed(1)}s source=${j.source} results from the filing ${fromFiling}/${res.length}`);
}
let slow = 0, partial = 0;
for (const s of symbols) {
  for (const kind of ["research", "narrative", "people"]) {
    const { j, ms } = await get(`/api/${kind}/${s}`);
    if (j.error || j.partial || j.snapshot) { partial++; console.log(`FAIL ${kind} ${s}: ${j.error ?? (j.partial ? "partial" : "snapshot")}`); }
    if (ms > 6000) { slow++; console.log(`slow ${kind} ${s}: ${(ms / 1000).toFixed(1)}s`); }
  }
}
const made = (await calls()) - before;
console.log(`${symbols.length} companies × 3 views: ${partial} not complete, ${slow} slower than 6s`);
console.log(`model calls made while answering: ${made}`);
if (bad || partial || made > 0) { console.log("COLD CHECK FAILED"); process.exit(1); }
console.log("COLD CHECK PASSED");
