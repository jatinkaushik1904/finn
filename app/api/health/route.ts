import { promises as fs } from "fs";
import path from "path";
import { NextRequest } from "next/server";
import { announcements, eod, NSE_ARCHIVES, NSE_ORIGIN } from "@/lib/nse";
import { llm, llmLoad, provider } from "@/lib/llm";
import { cacheStats } from "@/lib/cache";
import { pushConfigured, pushDurable } from "@/lib/push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

async function probe(name: string, fn: () => Promise<string>) {
  const t = Date.now();
  try {
    return { name, ok: true, detail: await fn(), ms: Date.now() - t };
  } catch (e) {
    return { name, ok: false, detail: (e as Error).message.slice(0, 160), ms: Date.now() - t };
  }
}

const get = async (url: string, headers: Record<string, string> = {}) => {
  const r = await fetch(url, { headers: { "User-Agent": UA, ...headers }, redirect: "follow", signal: AbortSignal.timeout(12_000) });
  const b = await r.arrayBuffer();
  if (!r.ok) throw new Error(`HTTP ${r.status} (${b.byteLength} bytes)`);
  return `HTTP ${r.status}, ${b.byteLength} bytes`;
};

function lastWeekday(d = new Date()) {
  const x = new Date(d.getTime() + 5.5 * 3600_000); // IST
  do x.setUTCDate(x.getUTCDate() - 1); while ([0, 6].includes(x.getUTCDay()));
  return `${String(x.getUTCDate()).padStart(2, "0")}${String(x.getUTCMonth() + 1).padStart(2, "0")}${x.getUTCFullYear()}`;
}

// Operational health: which upstreams this deployment can actually reach, from where.
export async function GET(req: NextRequest) {
  const withLLM = req.nextUrl.searchParams.get("llm") === "1";
  const to = new Date(), from = new Date(Date.now() - 10 * 86400_000);
  const probes = await Promise.all([
    probe("nse.home", () => get(`${NSE_ORIGIN}/`, { Accept: "text/html" })),
    probe("nse.api.announcements", async () => `${(await announcements("TITAN", from, to)).length} filings`),
    probe("nse.api.eod", async () => `${(await eod("TITAN", 30)).length} bars`),
    probe("nse.archive.bhavcopy", () => get(`${NSE_ARCHIVES}/products/content/sec_bhavdata_full_${lastWeekday()}.csv`)),
    probe("nse.archive.rss", () => get(`${NSE_ARCHIVES}/content/RSS/Online_announcements.xml`)),
    probe("nse.archive.pdf", () => get(`${NSE_ARCHIVES}/corporate/kavinavora_06112026191022_Pre_CLSA_SE_06112026.pdf`)),
    probe("bse.pdf", () => get("https://www.bseindia.com/stockinfo/AnnPdfOpen.aspx?Pname=8e997741-4d35-4188-933a-cf020fb9c816.pdf")),
    probe("screener.page", () => get("https://www.screener.in/company/ASIANPAINT/consolidated/")),
    probe("screener.chart", () => get("https://www.screener.in/api/company/2726/chart/?q=Price-Volume&days=30")),
    probe("snapshots", async () => `${(await fs.readdir(path.join(process.cwd(), "data/snapshot"))).length} files`),
    probe("seed", async () => `${(await fs.readdir(path.join(process.cwd(), "data/seed"))).length} pre-read filings, transcripts and model answers`),
    ...(withLLM && provider()
      ? [probe("llm.fast", async () => { const r = await llm<{ ok: boolean }>("fast", "Reply in JSON.", `Return {"ok":true} (${Date.now()})`, 50); if (!r.value) throw new Error(r.error ?? "no value"); return `${r.model} ${r.ms}ms`; })]
      : []),
  ]);
  return Response.json({
    region: process.env.VERCEL_REGION ?? "local", llm: provider() ?? "none", nse: NSE_ORIGIN, at: new Date().toISOString(),
    push: { webPush: pushConfigured(), storedDurably: pushDurable(), telegram: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID), webhook: !!process.env.WEBHOOK_URL },
    cache: cacheStats, llmLoad: llmLoad(), probes,
  });
}
