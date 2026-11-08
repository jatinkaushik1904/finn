import * as cheerio from "cheerio";
import { cached, HOUR } from "./cache";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export type Table = { headers: string[]; rows: Record<string, (number | null)[]> };
export type Fundamentals = {
  symbol: string;
  name: string;
  about: string;
  sector?: string;
  industry?: string;
  ratios: Record<string, string>;
  quarters: Table;
  annual: Table;
  balance: Table;
  cash: Table;
  ratioTable: Table;
  concalls: { month: string; transcript?: string; ppt?: string }[];
  annualReports: { title: string; url: string }[];
  basis: "consolidated" | "standalone";
  source: string;
};

const num = (s: string): number | null => {
  const t = s.replace(/[,%₹\s]/g, "").trim();
  if (!t || t === "-") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

function parseTable($: cheerio.CheerioAPI, sectionId: string): Table {
  const sec = $(`section#${sectionId}`).first();
  const table = sec.find("table.data-table").first();
  const headers = table.find("thead th").toArray().slice(1).map((th) => $(th).text().trim());
  const rows: Record<string, (number | null)[]> = {};
  table.find("tbody tr").each((_, tr) => {
    const tds = $(tr).find("td");
    if (!tds.length) return;
    const label = $(tds[0]).text().replace(/ /g, " ").replace(/\+/g, "").trim();
    if (!label || label.toLowerCase().startsWith("raw pdf")) return;
    rows[label] = tds.toArray().slice(1).map((td) => num($(td).text()));
  });
  return { headers, rows };
}

async function fetchPage(symbol: string, consolidated: boolean) {
  const url = `https://www.screener.in/company/${encodeURIComponent(symbol)}/${consolidated ? "consolidated/" : ""}`;
  const html = await cached("scr:" + url, 12 * HOUR, async () => {
    const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`screener ${r.status} for ${symbol}`);
    return r.text();
  });
  return { url, html };
}

export async function fundamentals(symbolIn: string): Promise<Fundamentals> {
  const symbol = symbolIn.toUpperCase().trim();
  let { url, html } = await fetchPage(symbol, true);
  let $ = cheerio.load(html);
  let basis: Fundamentals["basis"] = "consolidated";
  // Banks report, guide and get judged on standalone numbers (consolidated folds in insurance and
  // AMC subsidiaries, which wrecks NII and margins). Everyone else: consolidated when available.
  const isBank = /\bbank/i.test($('a[title="Industry"]').first().text());
  if (isBank || Object.keys(parseTable($, "quarters").rows).length === 0) {
    const alt = await fetchPage(symbol, false).catch(() => null);
    const $alt = alt ? cheerio.load(alt.html) : null;
    if (alt && $alt && Object.keys(parseTable($alt, "quarters").rows).length > 0) {
      ({ url, html } = alt);
      $ = $alt;
      basis = "standalone";
    }
  }
  const ratios: Record<string, string> = {};
  $("#top-ratios li").each((_, li) => {
    const k = $(li).find(".name").text().trim();
    const v = $(li).find(".value").text().replace(/\s+/g, " ").trim();
    if (k) ratios[k] = v;
  });
  const concalls: Fundamentals["concalls"] = [];
  $("#documents .concalls li").each((_, li) => {
    const month = $(li).find("div").first().text().trim();
    const transcript = $(li).find('a[title="Raw Transcript"]').attr("href");
    const ppt = $(li).find("a.button-chip").filter((_, a) => $(a).text().trim() === "PPT").attr("href");
    if (month) concalls.push({ month, transcript, ppt });
  });
  const annualReports: Fundamentals["annualReports"] = [];
  $("#documents .annual-reports li a").each((_, a) => {
    const href = $(a).attr("href");
    if (href) annualReports.push({ title: $(a).text().trim(), url: href });
  });
  const about = $(".company-profile .about p").first().text().replace(/\s+/g, " ").trim() ||
    $(".about p").first().text().replace(/\s+/g, " ").trim();
  return {
    symbol,
    name: $("h1").first().text().trim() || symbol,
    about,
    sector: $('a[title="Sector"]').first().text().trim() || undefined,
    industry: $('a[title="Industry"]').first().text().trim() || undefined,
    ratios,
    quarters: parseTable($, "quarters"),
    annual: parseTable($, "profit-loss"),
    balance: parseTable($, "balance-sheet"),
    cash: parseTable($, "cash-flow"),
    ratioTable: parseTable($, "ratios"),
    concalls,
    annualReports,
    basis,
    source: url,
  };
}

// Screener lays banks/NBFCs out differently ("Financing Profit" instead of "Operating Profit").
export function isFinancialCo(f: Fundamentals) {
  return !!(row(f.quarters, "Financing Profit") || row(f.annual, "Financing Profit")) ||
    /\b(bank|nbfc|non banking|housing finance)/i.test(f.industry ?? "");
}

// Pick a row by any of several candidate labels (banks/NBFCs use different names).
export function row(t: Table, ...names: string[]): (number | null)[] | undefined {
  for (const n of names) {
    const k = Object.keys(t.rows).find((r) => r.toLowerCase() === n.toLowerCase());
    if (k) return t.rows[k];
  }
  for (const n of names) {
    const k = Object.keys(t.rows).find((r) => r.toLowerCase().startsWith(n.toLowerCase()));
    if (k) return t.rows[k];
  }
  return undefined;
}

export type Headline = {
  period: string;
  prevPeriod: string;
  yoyPeriod: string;
  lines: { label: string; value: number | null; qoq: number | null; yoy: number | null }[];
  ebitdaLabel: string;
};

const pct = (a: number | null | undefined, b: number | null | undefined) =>
  a == null || b == null || b === 0 ? null : ((a - b) / Math.abs(b)) * 100;

// Revenue / EBITDA / PBT / PAT for the latest quarter, QoQ and YoY.
export function headline(f: Fundamentals): Headline | null {
  const q = f.quarters;
  const n = q.headers.length;
  if (n < 5) return null;
  const rev = row(q, "Sales", "Revenue");
  const fin = isFinancialCo(f);
  // Lenders: EBITDA is meaningless; net interest income (interest earned − interest expended) is the line that matters.
  const intExp = row(q, "Interest");
  const op = fin ? rev?.map((x, j) => (x != null && intExp?.[j] != null ? x - (intExp[j] as number) : null)) : row(q, "Operating Profit");
  const pbt = row(q, "Profit before tax");
  const pat = row(q, "Net Profit");
  const i = n - 1;
  const mk = (label: string, r?: (number | null)[]) => ({
    label,
    value: r?.[i] ?? null,
    qoq: pct(r?.[i], r?.[i - 1]),
    yoy: pct(r?.[i], r?.[i - 4]),
  });
  return {
    period: q.headers[i],
    prevPeriod: q.headers[i - 1],
    yoyPeriod: q.headers[i - 4],
    ebitdaLabel: fin ? "NII" : "EBITDA",
    lines: [mk(fin ? "Interest earned" : "Revenue", rev), mk(fin ? "NII" : "EBITDA", op), mk("PBT", pbt), mk("PAT", pat)],
  };
}
