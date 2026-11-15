import { cached, HOUR } from "./cache";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// NSE moved its public site from www.nseindia.com to www.nseindia.in in November 2026 (the old
// host now answers every path with a 301 to the new one). FINN talks to the new host directly and
// still follows redirects, so a future move degrades to one extra hop instead of an outage.
export const NSE_ORIGIN = (process.env.NSE_ORIGIN ?? "https://www.nseindia.in").replace(/\/$/, "");
/** Static archives (filing PDFs, bhavcopy, RSS) live on the sibling host. */
export const NSE_ARCHIVES = NSE_ORIGIN.replace("//www.", "//nsearchives.");

let cookie = "";
let cookieAt = 0;

// Every outbound call has a hard timeout — a stalled exchange endpoint must
// degrade to the snapshot, never hang the user's brief.
export const T = { session: 8_000, api: 12_000, pdf: 25_000 };

// A browser-style session: the cookies the site's home page sets. Only fetched when a plain
// request is refused (see nseGet), and reused for 10 minutes.
async function session(force = false) {
  if (!force && cookie && Date.now() - cookieAt < 10 * 60_000) return cookie;
  try {
    const r = await fetch(`${NSE_ORIGIN}/`, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      signal: AbortSignal.timeout(T.session),
    });
    const set = r.headers.getSetCookie?.() ?? [];
    if (r.ok && set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
  } catch {}
  cookieAt = Date.now();
  return cookie;
}

// The JSON API answers a plain request. If it refuses one (it used to want the home page's
// cookies first), open a session the way a browser would and ask once more.
async function nseGet<T>(pathAndQuery: string): Promise<T> {
  const url = `${NSE_ORIGIN}${pathAndQuery}`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const c = attempt === 0 ? cookie : await session(true);
    try {
      const r = await fetch(url, {
        headers: { "User-Agent": UA, Referer: `${NSE_ORIGIN}/`, Accept: "application/json", ...(c ? { Cookie: c } : {}) },
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
  const url = `/api/corporate-announcements?index=equities&symbol=${encodeURIComponent(
    symbol,
  )}&from_date=${fmt(from)}&to_date=${fmt(to)}`;
  return cached("ann:" + url, 2 * HOUR, () => nseGet<RawAnn[]>(url));
}

export type Bar = { date: string; close: number; prev: number; volume: number };

export async function eod(symbol: string, days = 60): Promise<Bar[]> {
  const to = new Date();
  const from = new Date(Date.now() - days * 86400_000);
  const url = `/api/historicalOR/generateSecurityWiseHistoricalData?from=${fmt(from)}&to=${fmt(
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

const MAX_PDF = 40 * 1024 * 1024; // a board-meeting outcome with every annexure runs to ~20 MB

/**
 * Download a filing PDF, whole. A connection cut mid-stream still returns bytes — HDFC Bank's
 * results PDF once arrived 983,040 of 1,193,121 bytes and failed to parse ("Invalid Root
 * reference") — so the length is checked against Content-Length (or, without one, the %%EOF
 * marker) and a short read is retried once, never cached.
 */
export async function fetchPdf(urlIn: string, timeoutMs = T.pdf): Promise<Uint8Array> {
  // Some companies link a transcript through a viewer page ("/pdf-viewer?pdf=%2Fcontent%2F…%2Fcall.pdf",
  // "viewer.html?file=…"): the PDF is the parameter, on the same site.
  let url = urlIn;
  try {
    const u = new URL(urlIn);
    const inner = ["pdf", "file", "url", "src"].map((k) => u.searchParams.get(k)).find((v) => v && /\.pdf($|[?#])/i.test(v));
    if (inner && !/\.pdf$/i.test(u.pathname)) url = new URL(inner, u.origin).toString();
  } catch {}
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url, {
        headers: { "User-Agent": UA, Referer: `${NSE_ORIGIN}/` },
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) throw new Error("pdf " + r.status);
      const len = Number(r.headers.get("content-length") || 0);
      if (len > MAX_PDF) throw new Error("pdf too large");
      const buf = new Uint8Array(await r.arrayBuffer());
      if (buf.length > MAX_PDF) throw new Error("pdf too large");
      if (String.fromCharCode(...buf.slice(0, 5)) !== "%PDF-") throw new Error("not a pdf");
      const tail = Buffer.from(buf.buffer, buf.byteOffset + Math.max(0, buf.length - 4096), Math.min(4096, buf.length)).toString("latin1");
      if (len && !r.headers.get("content-encoding") ? buf.length !== len : !tail.includes("%%EOF")) throw new Error(`pdf truncated (${buf.length}${len ? ` of ${len}` : ""} bytes)`);
      return buf;
    } catch (e) {
      lastErr = e;
      if (/too large|not a pdf|pdf 4\d\d/.test((e as Error).message)) break; // retrying won't help
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function pdfText(url: string, maxPages = 40): Promise<string> {
  return cached(`pdf:${maxPages}:${url}`, 30 * 24 * HOUR, async () => {
    const buf = await fetchPdf(url);
    const { getDocumentProxy } = await import("unpdf");
    const doc = await getDocumentProxy(buf);
    // Parse only the pages we will read (an annual report can run to 400 pages).
    const pages: string[] = [];
    try {
      for (let i = 1; i <= Math.min(doc.numPages, maxPages); i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        pages.push(
          (content.items as { str?: string; hasEOL?: boolean }[])
            .filter((it) => it.str != null)
            .map((it) => it.str + (it.hasEOL ? "\n" : ""))
            .join(""),
        );
      }
    } finally {
      doc.destroy().catch(() => {});
    }
    return pages.join("\n");
  }, undefined, { immutable: true });
}
