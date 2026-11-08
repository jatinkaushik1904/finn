import { cached, HOUR } from "./cache";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

let cookie = "";
let cookieAt = 0;

// Every outbound call has a hard timeout — a stalled exchange endpoint must
// degrade to the snapshot, never hang the user's brief.
export const T = { session: 8_000, api: 12_000, pdf: 25_000 };

async function session(force = false) {
  if (!force && cookie && Date.now() - cookieAt < 10 * 60_000) return cookie;
  try {
    const r = await fetch("https://www.nseindia.com/", {
      headers: { "User-Agent": UA, Accept: "text/html" },
      signal: AbortSignal.timeout(T.session),
    });
    const set = r.headers.getSetCookie?.() ?? [];
    if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
  } catch {}
  cookieAt = Date.now();
  return cookie;
}

async function nseGet<T>(url: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const c = await session(attempt > 0);
    try {
      const r = await fetch(url, {
        headers: { "User-Agent": UA, Referer: "https://www.nseindia.com/", Accept: "application/json", Cookie: c },
        signal: AbortSignal.timeout(T.api),
      });
      if (r.ok) return (await r.json()) as T;
      lastErr = new Error(`NSE ${r.status}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

const fmt = (d: Date) =>
  `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${d.getFullYear()}`;

export type RawAnn = {
  symbol: string;
  sm_name: string;
  desc: string;
  an_dt: string; // "06-Nov-2026 19:10:58"
  sort_date: string; // "2026-11-06 19:10:58"
  attchmntText: string;
  attchmntFile: string;
  seq_id: string;
};

export async function announcements(symbol: string, from: Date, to: Date): Promise<RawAnn[]> {
  const url = `https://www.nseindia.com/api/corporate-announcements?index=equities&symbol=${encodeURIComponent(
    symbol,
  )}&from_date=${fmt(from)}&to_date=${fmt(to)}`;
  return cached("ann:" + url, 2 * HOUR, () => nseGet<RawAnn[]>(url));
}

export type Bar = { date: string; close: number; prev: number; volume: number };

export async function eod(symbol: string, days = 60): Promise<Bar[]> {
  const to = new Date();
  const from = new Date(Date.now() - days * 86400_000);
  const url = `https://www.nseindia.com/api/historicalOR/generateSecurityWiseHistoricalData?from=${fmt(from)}&to=${fmt(
    to,
  )}&symbol=${encodeURIComponent(symbol)}&type=priceVolumeDeliverable&series=EQ`;
  const res = await cached("eod:" + url, 6 * HOUR, () =>
    nseGet<{ data: { mTIMESTAMP: string; CH_CLOSING_PRICE: number; CH_PREVIOUS_CLS_PRICE: number; CH_TOT_TRADED_QTY: number }[] }>(url),
  );
  return (res.data || [])
    .map((d) => ({
      date: new Date(d.mTIMESTAMP + " UTC").toISOString().slice(0, 10),
      close: d.CH_CLOSING_PRICE,
      prev: d.CH_PREVIOUS_CLS_PRICE,
      volume: d.CH_TOT_TRADED_QTY,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// Run async tasks with limited concurrency (be polite to the exchange).
export async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<(R | null)[]> {
  const out: (R | null)[] = new Array(items.length).fill(null);
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const idx = i++;
        try {
          out[idx] = await fn(items[idx]);
        } catch (e) {
          console.error("pool task failed", (e as Error).message);
        }
      }
    }),
  );
  return out;
}

export async function pdfText(url: string, maxPages = 40): Promise<string> {
  return cached("pdf:" + url, 30 * 24 * HOUR, async () => {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Referer: "https://www.nseindia.com/" },
      redirect: "follow",
      signal: AbortSignal.timeout(T.pdf),
    });
    if (!r.ok) throw new Error("pdf " + r.status);
    const buf = new Uint8Array(await r.arrayBuffer());
    const { extractText, getDocumentProxy } = await import("unpdf");
    const doc = await getDocumentProxy(buf);
    const { text } = await extractText(doc, { mergePages: false });
    return (text as string[]).slice(0, maxPages).join("\n");
  });
}
