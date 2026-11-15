import { fundamentals, Fundamentals, isFinancialCo, row } from "./screener";
import { announcements, pdfText, pool, RawAnn } from "./nse";
import { pdfPages, PdfDoc } from "./pdf";
import { llm, modelInfo } from "./llm";
import { cached, DAY, HOUR } from "./cache";
import { leadsForCompany } from "./network";

const cagr = (a?: number | null, b?: number | null, yrs = 3) =>
  a && b && a > 0 && b > 0 ? (Math.pow(b / a, 1 / yrs) - 1) * 100 : null;
const last = <T,>(a: T[] | undefined, n: number) => (a ? a.slice(-n) : []);
const sub = (a?: (number | null)[], b?: (number | null)[]) =>
  a && b ? a.map((x, i) => (x != null && b[i] != null ? Math.round(x - (b[i] as number)) : null)) : undefined;

// Screener's annual tables end with a "TTM" column; drop it for year-on-year maths.
function annualOnly(f: Fundamentals) {
  const h = f.annual.headers;
  const ttm = h[h.length - 1]?.toUpperCase() === "TTM";
  const cut = <T,>(r?: T[]) => (r ? (ttm ? r.slice(0, -1) : r) : []);
  return { headers: ttm ? h.slice(0, -1) : h, cut, ttm };
}

export class NotFound extends Error {}

// ---------- Indian fiscal periods ----------
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const QEND = [5, 8, 11, 2]; // Q1..Q4 of an Indian FY end in Jun, Sep, Dec, Mar
const pad2 = (n: number) => String(((n % 100) + 100) % 100).padStart(2, "0");

// "Sep 2026" -> "Q2 FY27"
export function fyLabel(period: string) {
  const [m, y] = period.split(" ");
  const mi = MONTHS.indexOf(m?.toLowerCase().slice(0, 3));
  const yr = Number(y);
  if (mi < 0 || !yr) return period;
  const qn = QEND.indexOf(mi) + 1;
  if (!qn) return period;
  const fy = qn === 4 ? yr : yr + 1;
  return `Q${qn} FY${String(fy).slice(-2)}`;
}
// "May 2026" -> "27" (the Indian fiscal year that month falls in)
function fyOfMonth(month: string) {
  const [m, y] = month.split(" ");
  const mi = MONTHS.indexOf(m?.toLowerCase().slice(0, 3));
  return mi < 0 || !Number(y) ? null : String(mi >= 3 ? Number(y) + 1 : Number(y)).slice(-2);
}
const periodOf = (qn: number, fy: number) => `${MON[QEND[qn - 1]]} ${qn === 4 ? fy : fy - 1}`;
const idx = (period: string) => {
  const [m, y] = (period ?? "").split(" ");
  const mi = MONTHS.indexOf(m?.toLowerCase().slice(0, 3));
  return mi < 0 || !Number(y) ? null : Number(y) * 12 + mi;
};
const fy2 = (x: string) => (x.length === 4 ? Number(x) : 2000 + Number(x));

// Fiscal-period labels used by the measurement code: "Q2 FY27", "H1 FY27", "H2 FY26", "9M FY27", "FY26".
type PL = { k: "Q" | "H1" | "H2" | "9M" | "FY"; n: number; fy: number };
function pl(s: string): PL | null {
  const m = String(s ?? "").trim().match(/^(?:(Q)\s?([1-4])|(H)\s?([12])|(9M))?\s*FY\s*'?(\d{4}|\d{2})$/i);
  if (!m) return null;
  const fy = Number(m[6]) % 100;
  if (m[1]) return { k: "Q", n: +m[2], fy };
  if (m[3]) return { k: m[4] === "1" ? "H1" : "H2", n: 0, fy };
  if (m[5]) return { k: "9M", n: 0, fy };
  return { k: "FY", n: 0, fy };
}
const qL = (n: number, fy: number) => `Q${n} FY${pad2(fy)}`;
const plText = (p: PL) => (p.k === "Q" ? qL(p.n, p.fy) : p.k === "FY" ? `FY${pad2(p.fy)}` : `${p.k} FY${pad2(p.fy)}`);
const plQuarters = (p: PL): number[] => (p.k === "Q" ? [p.n] : p.k === "H1" ? [1, 2] : p.k === "H2" ? [3, 4] : p.k === "9M" ? [1, 2, 3] : [1, 2, 3, 4]);
const quartersOf = (p: PL) => plQuarters(p).map((n) => qL(n, p.fy));
const yearBefore = (p: PL): PL => ({ ...p, fy: p.fy - 1 });
const qOrd = (label: string) => { const p = pl(label); return p && p.k === "Q" ? p.fy * 4 + p.n : null; };
const prevQuarter = (label: string) => { const p = pl(label)!; return p.n === 1 ? qL(4, p.fy - 1) : qL(p.n - 1, p.fy); };
const nextQuarter = (label: string) => { const p = pl(label)!; return p.n === 4 ? qL(1, p.fy + 1) : qL(p.n + 1, p.fy); };
const ytdText = (fy: number, n: number) => (n === 1 ? qL(1, fy) : n === 2 ? `H1 FY${pad2(fy)}` : n === 3 ? `9M FY${pad2(fy)}` : `FY${pad2(fy)}`);
const endPeriod = (p: PL) => periodOf(plQuarters(p).at(-1)!, 2000 + p.fy); // "Mar 2026"

// "September 30, 2026" | "30th June 2026" | "30-Jun-2026" | "30.06.2026" | "Jun 30, 2025" -> "Sep 2026"
export function periodFromText(s: string): string | null {
  const t = String(s ?? "");
  let m = t.match(/\b\d{1,2}(?:st|nd|rd|th)?[\s\-\/.,]*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?[\s\-\/.,]*(20\d{2})\b/i);
  if (m) return `${MON[MONTHS.indexOf(m[1].toLowerCase())]} ${m[2]}`;
  m = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+(20\d{2})\b/i);
  if (m) return `${MON[MONTHS.indexOf(m[1].toLowerCase())]} ${m[2]}`;
  m = t.match(/\b\d{1,2}[.\-\/](\d{1,2})[.\-\/](20\d{2})\b/);
  if (m && +m[1] >= 1 && +m[1] <= 12) return `${MON[+m[1] - 1]} ${m[2]}`;
  return null;
}

// ---------- Results filings: the company's own segment table, capex and (lenders) balance sheet ----------
//
// screener.in shows segment names for free but the numbers are premium-only, so they come from
// the primary source instead: the quarterly results filing on NSE (SEBI requires the segment
// table in it). Per filing, rules pick the segment page, the cash-flow capex line and the
// lender's balance-sheet lines; the fast tier COPIES the numbers; code maps columns to fiscal
// periods (SEBI's fixed column order), converts units and checks that segments add up to the
// printed Total — a column that doesn't add up is dropped, never guessed.

export type Basis = "consolidated" | "standalone";
type ResultsFiling = { period: string; url: string; filed: string; explicit: boolean };

const DAYMS = 86400_000;
const parseNseDate = (s: string) => new Date(String(s ?? "").replace(" ", "T") + "+05:30");

/** All NSE announcements for the symbol over ~25 months (one cached call, shared with people()). */
export async function recentAnnouncements(symbol: string): Promise<RawAnn[]> {
  const to = new Date();
  const from = new Date(to.getTime() - 760 * DAYMS);
  return announcements(symbol, from, to);
}

function quarterEndBefore(d: Date, minDays: number, maxDays: number): string | null {
  for (let back = 0; back < 6; back++) {
    const probe = new Date(d.getFullYear(), d.getMonth() - back, 1);
    const m = probe.getMonth();
    if (!QEND.includes(m)) continue;
    const end = new Date(probe.getFullYear(), m + 1, 0);
    const days = (d.getTime() - end.getTime()) / DAYMS;
    if (days >= minDays && days <= maxDays) return `${MON[m]} ${end.getFullYear()}`;
  }
  return null;
}

export function resultsFilingsFrom(anns: RawAnn[]): ResultsFiling[] {
  const best = new Map<string, ResultsFiling & { rank: number }>();
  for (const a of anns ?? []) {
    const url = a.attchmntFile ?? "";
    if (!/\.pdf$/i.test(url)) continue;
    if (!/^(outcome of board meeting|financial results?|integrated filing.{0,4}financial)/i.test(a.desc ?? "")) continue;
    const text = (a.attchmntText ?? "").replace(/\s+/g, " ").trim();
    if (/newspaper|press release|presentation|intimation of (?:the )?(?:board )?meeting|prior intimation|trading window|postal ballot/i.test(text)) continue;
    const rx = text.match(/financial results?\b.{0,140}?\b(?:period|quarter|half[- ]?year|year|months)\s+ended\s+(?:on\s+)?(.{6,40})/i);
    let period = rx ? periodFromText(rx[1]) : null;
    if (period && !QEND.includes(MONTHS.indexOf(period.slice(0, 3).toLowerCase()))) period = null;
    let rank = period ? 0 : 2;
    if (!period) {
      // A board-meeting outcome that doesn't say what it approved ("Outcome of the Board Meeting"):
      // the quarter that ended 10–75 days earlier. The PDF is checked for a results statement later.
      if (!/financial results?/i.test(text) && !/^outcome of (?:the )?board meeting\.?$/i.test(text)) continue;
      period = quarterEndBefore(parseNseDate(a.sort_date), 10, 75);
      if (!period) continue;
    }
    if (/^integrated filing/i.test(a.desc ?? "")) rank += 1;
    const cur = best.get(period);
    if (!cur || rank < cur.rank || (rank === cur.rank && a.sort_date < cur.filed)) best.set(period, { period, url, filed: a.sort_date, explicit: rank === 0, rank });
  }
  return [...best.values()].sort((a, b) => (idx(b.period) ?? 0) - (idx(a.period) ?? 0)).map(({ rank: _r, ...f }) => f);
}

// SEBI's results format fixes the column order; the filing's quarter tells us which columns exist.
function resultCols(label: string, n: number): string[] | null {
  const p = pl(label);
  if (!p || p.k !== "Q") return null;
  const f = p.fy, q = p.n, F = (y: number) => `FY${pad2(y)}`;
  const full: Record<number, string[]> = {
    1: [qL(1, f), qL(4, f - 1), qL(1, f - 1), F(f - 1)],
    2: [qL(2, f), qL(1, f), qL(2, f - 1), `H1 FY${pad2(f)}`, `H1 FY${pad2(f - 1)}`, F(f - 1)],
    3: [qL(3, f), qL(2, f), qL(3, f - 1), `9M FY${pad2(f)}`, `9M FY${pad2(f - 1)}`, F(f - 1)],
    4: [qL(4, f), qL(3, f), qL(4, f - 1), F(f), F(f - 1)],
  };
  const c = full[q];
  if (n === c.length) return c;
  if (n === 3) return c.slice(0, 3);
  if ((q === 2 || q === 3) && n === 5) return c.slice(0, 5);
  if (q === 4 && n === 2) return [F(f), F(f - 1)];
  return null;
}
function cashCols(label: string, n: number): string[] | null {
  const p = pl(label);
  if (!p || p.k !== "Q") return null;
  const f = p.fy;
  const cur = p.n === 1 ? qL(1, f) : ytdText(f, p.n), prev = p.n === 1 ? qL(1, f - 1) : ytdText(f - 1, p.n);
  if (n === 2) return [cur, prev];
  if (n === 3 && p.n !== 4) return [cur, prev, `FY${pad2(f - 1)}`];
  return null;
}
function asAtCols(period: string, n: number): string[] | null {
  const [m, y] = period.split(" ");
  const yr = Number(y);
  if (!yr) return null;
  if (m === "Mar") return n === 2 ? [period, `Mar ${yr - 1}`] : null;
  if (n === 3) return [period, `${m} ${yr - 1}`, `Mar ${yr}`]; // half-year end, a year earlier, last March
  if (n === 2) return [period, `${m} ${yr - 1}`];
  return null;
}

const UNIT_RX: [RegExp, number][] = [[/crore/i, 1], [/lakh|lac/i, 0.01], [/million|\bmn\b/i, 0.1], [/billion|\bbn\b/i, 100], [/thousand|'000/i, 1e-4]];
const unitMult = (u: string) => { for (const [re, k] of UNIT_RX) if (re.test(u)) return k; return null; };
const squeeze = (s: string) => s.replace(/[ \t]{3,}/g, "  ").replace(/^[ \t]+/gm, "").replace(/\n{2,}/g, "\n");

// The statement title says which basis a page is ("STATEMENT OF CONSOLIDATED … RESULTS", "Standalone Segment information").
function titleBasis(p: string): Basis | null {
  const head = p.split("\n").slice(0, 14).join(" ").toLowerCase().replace(/\s+/g, " ");
  const m = head.match(/statement of (?:the )?(?:un-?audited |audited |reviewed )*(consolidated|standalone)|(consolidated|standalone)\s+(?:un-?audited |audited )?(?:segment|financial results|statement|cash ?flows?|balance sheet)/);
  const w = (m?.[1] ?? m?.[2]) as Basis | undefined;
  return w ?? null;
}
const pageBasis = (d: PdfDoc, i: number) => {
  for (let j = i; j >= Math.max(0, i - 2); j--) { const b = titleBasis(d.pages[j]); if (b) return b; }
  return null;
};
const countNums = (p: string) => (p.match(/\(?\d[\d,]*(?:\.\d+)?\)?/g) ?? []).length;

// "The Company operates in a single segment — Electronics Goods" / exempt from Ind AS 108.
function segmentNote(all: string): string | null {
  const t = all.replace(/\s+/g, " ");
  let m = t.match(/single (?:primary )?(?:operating|reportable|business) segment[^.;]{0,40}?(?:namely|i\.e\.?,?|viz\.?|being|of)\s*[‘'"“]?([A-Za-z][A-Za-z &-]{2,40}?)[’'"”]?(?:[;.,]|\s+which|\s+and|\s+in\b)/i)
    ?? t.match(/operates? (?:only )?in (?:one|a single|only one) (?:business |reportable |operating |primary )?segment[^.;]{0,20}?(?:i\.e\.?,?|namely|viz\.?|being)?\s*[‘'"“]?([A-Za-z][A-Za-z &-]{2,40}?)[’'"”]?(?:[;.,]|\s+which|\s+and|\s+in\b)/i);
  if (m) return `single segment: ${m[1].trim()}`;
  if (/exempted[^.]{0,200}Ind AS 108|Ind AS 108[^.]{0,120}(?:not applicable|exempt)/i.test(t)) return "exempt from segment reporting (Ind AS 108)";
  if (/single (?:primary )?(?:operating|reportable|business) segment|only one (?:business |reportable )?segment/i.test(t)) return "single segment";
  return null;
}

function pickSegmentPage(d: PdfDoc, basis: Basis): { i: number; basis: Basis | null } | null {
  let best: { i: number; basis: Basis | null; score: number } | null = null;
  d.pages.forEach((p, i) => {
    const t = p.toLowerCase();
    if (!/segment\s*(?:information|revenue|results?|wise|reporting)|segment-?wise|segmental|business segments?/.test(t)) return;
    if (!/revenue|income/.test(t) || !/result|profit/.test(t) || countNums(p) < 20) return;
    const b = pageBasis(d, i);
    const score = (b === basis ? 3 : b ? -3 : 0) + (/segment\s*revenue/.test(t) ? 1 : 0) + (/segment\s*results?|from segments/.test(t) ? 1 : 0);
    if (!best || score > best.score) best = { i, basis: b, score };
  });
  return best;
}
function segmentText(page: string): { text: string; resultLabel: string | null } {
  const lines = squeeze(page).split("\n");
  const at = lines.findIndex((l) => /segment/i.test(l));
  const from = Math.max(0, at - 10);
  let to = lines.length;
  for (let j = at + 3; j < lines.length; j++) if (/segment\s*assets|segment\s*liabilit|capital\s*employed/i.test(lines[j])) { to = j; break; }
  const resLine = lines.slice(at, to).find((l) => /segment\s*results?|from\s+segments|segment\s*profit/i.test(l));
  return { text: lines.slice(from, to).join("\n").slice(0, 5000), resultLabel: resLine ? resLine.replace(/^[\s\dA-Za-z][).}]\s*/, "").replace(/[\d(),.\s-]+$/, "").replace(/\s+/g, " ").trim().slice(0, 110) : null };
}
function cashText(d: PdfDoc, basis: Basis): string {
  let best: { s: string; score: number } | null = null;
  d.pages.forEach((p, i) => {
    if (!/cash\s*flows?/i.test(p.split("\n").slice(0, 14).join(" ")) || !/investing\s+activities/i.test(p)) return;
    const lines = squeeze(p).split("\n");
    const at = lines.findIndex((l) => /investing\s+activities/i.test(l));
    const capex = lines.slice(at, at + 16).filter((l, k, arr) => /purchase|acquisition|capital expenditure|payments? (?:for|towards)|property,? plant/i.test(l) || (k > 0 && /purchase|acquisition|capital expenditure|payments? (?:for|towards)/i.test(arr[k - 1]) && /\d/.test(l)));
    if (!capex.length) return;
    const head = lines.slice(0, 14).filter((l) => /ended|as at|year|months/i.test(l)).slice(0, 3);
    const b = pageBasis(d, i);
    const score = (b === basis ? 3 : b ? -3 : 0);
    if (!best || score > best.score) best = { s: [...head, ...capex.slice(0, 6)].join("\n"), score };
  });
  return best ? (best as { s: string }).s.slice(0, 1500) : "";
}
function bankText(d: PdfDoc, basis: Basis): { bs: string; roa: string } {
  let bs: { s: string; score: number } | null = null, roa: { s: string; score: number } | null = null;
  d.pages.forEach((p, i) => {
    const lines = squeeze(p).split("\n");
    const b = pageBasis(d, i);
    const score = b === basis ? 3 : b ? -3 : 0;
    if (/assets\s+and\s+liabilities|balance\s+sheet/i.test(p)) {
      const ls = lines.filter((l) => /^\s*(?:[a-z0-9]{1,3}[.)]\s*)?(advances|deposits)\b\s*[\d(]/i.test(l));
      if (ls.length && (!bs || score > bs.score)) bs = { s: [...lines.slice(0, 12).filter((l) => /as at|unaudited|audited/i.test(l)).slice(0, 2), ...ls.slice(0, 4)].join("\n"), score };
    }
    const r = lines.filter((l) => /return on assets/i.test(l));
    if (r.length && (!roa || score > roa.score)) roa = { s: r.slice(0, 2).join("\n"), score };
  });
  return { bs: bs ? (bs as { s: string }).s : "", roa: roa ? (roa as { s: string }).s : "" };
}

const toNum = (x: unknown): number | null => {
  if (typeof x === "number") return Number.isFinite(x) ? x : null;
  if (typeof x !== "string") return null;
  const t = x.trim();
  if (!t || /^[-–—.]+$/.test(t)) return null;
  const neg = /^\(.*\)$/.test(t) || /^-/.test(t);
  const v = Number(t.replace(/[(),\s₹]/g, "").replace(/^-/, ""));
  return Number.isFinite(v) ? (neg ? -v : v) : null;
};
const nums = (a: unknown): (number | null)[] => (Array.isArray(a) ? a.map(toNum) : []);

export type FilingFacts = {
  url: string; period: string; label: string; filed: string;
  basis: Basis | null; note: string | null; unit: string | null; resultLabel: string | null;
  cols: string[];
  segments: { name: string; revenue: (number | null)[]; result: (number | null)[] }[];
  checked: { revenue: boolean[]; result: boolean[] };
  capex: { period: string; value: number }[];
  bank: { asAt: string; advances: number | null; deposits: number | null }[];
  roa: { period: string; value: number }[];
  llm: { model: string; promptChars: number; ms: number; cached: boolean; error?: string } | null;
  error?: string;
};

const FILING_SYS =
  "You copy numbers from an Indian listed company's quarterly results filing. Copy figures exactly as printed, column by column, left to right (numbers in brackets are negative; a blank or '-' cell is null). Never add up, compute, estimate or use outside knowledge.";

async function filingFacts(f: ResultsFiling, basis: Basis, fin: boolean, qRev: number | null): Promise<FilingFacts> {
  const label = fyLabel(f.period);
  const out: FilingFacts = {
    url: f.url, period: f.period, label, filed: f.filed, basis: null, note: null, unit: null, resultLabel: null,
    cols: [], segments: [], checked: { revenue: [], result: [] }, capex: [], bank: [], roa: [], llm: null,
  };
  let d: PdfDoc;
  try { d = await pdfPages(f.url); } catch (e) { return { ...out, error: `pdf: ${(e as Error).message}` }; }
  const all = d.pages.join("\n");
  if (!/revenue\s*from\s*operations|interest\s*earned|income\s*from\s*operations/i.test(all)) return { ...out, error: "not a results statement" };
  out.note = segmentNote(all);
  const seg = out.note ? null : pickSegmentPage(d, basis);
  const st = seg ? segmentText(d.pages[seg.i]) : null;
  const cash = cashText(d, basis);
  const bk = fin ? bankText(d, basis) : { bs: "", roa: "" };
  out.basis = seg?.basis ?? null;
  out.resultLabel = st?.resultLabel ?? null;
  if (!st && !cash && !bk.bs && !bk.roa) return out;
  const blocks = [
    st ? `SEGMENT TABLE (page ${seg!.i + 1}):\n${st.text}` : "",
    cash ? `CASH FLOW, investing activities:\n${cash}` : "",
    bk.bs ? `STATEMENT OF ASSETS AND LIABILITIES (lines):\n${bk.bs}` : "",
    bk.roa ? `RATIO LINE:\n${bk.roa}` : "",
  ].filter(Boolean).join("\n\n");
  const prompt =
    `Results filing for the quarter ended ${f.period} (${label}).\n` +
    `Return JSON {"unit":"as printed, e.g. '₹ in crore', 'Rs. in lakhs', 'INR million'",` +
    (st ? `"segments":[{"name":"segment name as printed","revenue":[every column],"result":[every column]}],"totalRevenue":[the 'Total' line of segment revenue, every column],"totalResult":[the 'Total' line of segment results, every column],` : "") +
    (cash ? `"capex":[every column of the purchase/acquisition of property, plant and equipment (capital expenditure) line],` : "") +
    (bk.bs ? `"advances":[every column],"deposits":[every column],` : "") +
    (bk.roa ? `"roa":[every column of the return-on-assets line],` : "") +
    `}\n` +
    (st ? `Segments: the top-level segment rows of the segment revenue and segment result blocks, including 'Unallocated'/'Corporate' rows that are part of the Total; skip sub-rows ((i), (ii)), 'Less: inter-segment' lines and anything below the Total. Use the same order of segments in both lists.\n` : "") +
    `\n${blocks}`;
  const res = await llm<Record<string, unknown>>("fast", FILING_SYS, prompt, 1800, { timeoutMs: 45_000 });
  out.llm = { model: res.model, promptChars: res.promptChars, ms: res.ms, cached: res.cached, ...(res.error ? { error: res.error } : {}) };
  const x = res.value;
  if (!x) return { ...out, error: res.error ?? "no answer" };
  const pageText = `${st?.text ?? ""}\n${cash}\n${bk.bs}`;
  const mult = unitMult(String(x.unit ?? "")) ?? unitMult(pageText.slice(0, 1500)) ?? 1;
  out.unit = String(x.unit ?? "") || null;
  if (st && Array.isArray(x.segments)) {
    const segs = (x.segments as { name?: string; revenue?: unknown; result?: unknown }[]).filter((s) => s && s.name);
    const n = Math.max(0, ...segs.map((s) => nums(s.revenue).length));
    const cols = resultCols(label, n);
    if (cols && segs.length) {
      const R = segs.map((s) => nums(s.revenue).slice(0, cols.length));
      const P = segs.map((s) => nums(s.result).slice(0, cols.length));
      const tR = nums(x.totalRevenue), tP = nums(x.totalResult);
      // Deterministic integrity check: the segments must add up to the printed Total, column by column.
      const adds = (rows: (number | null)[][], tot: (number | null)[], tol: number) => cols.map((_, c) => {
        const t = tot[c];
        const xs = rows.map((r) => r[c]).filter((v): v is number => v != null);
        if (t == null || !xs.length) return false;
        return Math.abs(xs.reduce((a, b) => a + b, 0) - t) <= Math.max(Math.abs(t) * tol, 1.5);
      });
      let okR = adds(R, tR, 0.006), okP = adds(P, tP, 0.012);
      // Unit sanity against the reported table (segment revenue includes other income or, for banks,
      // inter-segment revenue, so this only catches lakh/crore/million slips).
      const cur = tR[0] != null ? tR[0]! * mult : null;
      if (qRev && cur && (cur / qRev < 0.4 || cur / qRev > 4)) { okR = cols.map(() => false); okP = cols.map(() => false); out.error = `segment unit check failed (${Math.round(cur)} vs ${Math.round(qRev)} cr)`; }
      out.cols = cols;
      out.checked = { revenue: okR, result: okP };
      out.segments = segs.map((s, i) => ({
        name: String(s.name).replace(/\s*\((?:refer|see) note[^)]*\)/gi, "").replace(/^[\s\-–•*]+|[\s:]+$/g, "").replace(/^[a-z0-9]{1,3}[).}]\s*/i, "").replace(/\s+/g, " ").trim(),
        revenue: cols.map((_, c) => (okR[c] && R[i][c] != null ? R[i][c]! * mult : null)),
        result: cols.map((_, c) => (okP[c] && P[i][c] != null ? P[i][c]! * mult : null)),
      }));
    } else if (segs.length) out.error = `segment columns not recognised (${n})`;
  }
  const cx = nums(x.capex);
  const cc = cashCols(label, cx.length);
  if (cc) out.capex = cc.map((p, i) => ({ period: p, value: cx[i] != null ? Math.abs(cx[i]!) * mult : NaN })).filter((c) => Number.isFinite(c.value) && c.value > 0);
  if (bk.bs) {
    const a = nums(x.advances), dp = nums(x.deposits);
    const ac = asAtCols(f.period, Math.max(a.length, dp.length));
    if (ac) out.bank = ac.map((p, i) => ({ asAt: p, advances: a[i] != null ? a[i]! * mult : null, deposits: dp[i] != null ? dp[i]! * mult : null }));
  }
  if (bk.roa) {
    const r = nums(x.roa);
    const rc = resultCols(label, r.length);
    const notAnn = /not annuali[sz]ed/i.test(bk.roa);
    if (rc) out.roa = rc.map((p, i) => {
      const v = r[i];
      const q = plQuarters(pl(p)!).length;
      return { period: p, value: v == null ? NaN : notAnn && q < 4 ? (v * 4) / q : v };
    }).filter((z) => Number.isFinite(z.value));
  }
  return out;
}

export type Filed = {
  basis: Basis | null; note: string | null; resultLabel: string | null;
  segments: { name: string; key: string; revenue: Record<string, number>; result: Record<string, number> }[];
  capex: Record<string, number>;
  bank: Record<string, { advances: number | null; deposits: number | null }>;
  roa: Record<string, number>;
  sources: { period: string; label: string; url: string; filed: string; segments: number; checkedColumns: number; note?: string | null; error?: string }[];
  stats: { label: string; model?: string; promptChars: number; ms: number; cached: boolean; error?: string }[];
  partial: boolean;
};

const segKey = (s: string) => s.toLowerCase().replace(/&/g, " and ").replace(/\b(segment|business|division|the|of)\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
const UNALLOC = /unallocat|corporate|elimination|reconcil|inter[- ]?segment/i;
const FILED_V = "f3";

async function buildFiled(list: ResultsFiling[], basis: Basis, fin: boolean, qRevOf: (label: string) => number | null): Promise<Filed> {
  const facts = (await pool(list, 2, (f) => filingFacts(f, basis, fin, qRevOf(fyLabel(f.period))))).filter(Boolean) as FilingFacts[];
  const fl: Filed = { basis: null, note: null, resultLabel: null, segments: [], capex: {}, bank: {}, roa: {}, sources: [], stats: [], partial: false };
  // Oldest first, so a later filing's (restated) figure wins.
  for (const x of facts.slice().sort((a, b) => (idx(a.period) ?? 0) - (idx(b.period) ?? 0))) {
    fl.sources.push({ period: x.period, label: x.label, url: x.url, filed: x.filed, segments: x.segments.length, checkedColumns: x.checked.revenue.filter(Boolean).length, note: x.note, ...(x.error ? { error: x.error } : {}) });
    if (x.llm) fl.stats.push({ label: x.label, model: x.llm.model, promptChars: x.llm.promptChars, ms: x.llm.ms, cached: x.llm.cached, ...(x.llm.error ? { error: x.llm.error } : {}) });
    if (x.llm?.error || (x.error && /^pdf:/.test(x.error))) fl.partial = true;
    if (x.note) fl.note = x.note;
    if (x.basis) fl.basis = x.basis;
    if (x.resultLabel) fl.resultLabel = x.resultLabel;
    for (const s of x.segments) {
      const key = segKey(s.name);
      if (!key) continue;
      let t = fl.segments.find((z) => z.key === key);
      if (!t) fl.segments.push((t = { name: s.name, key, revenue: {}, result: {} }));
      t.name = s.name;
      x.cols.forEach((c, i) => {
        if (s.revenue[i] != null) t!.revenue[c] = s.revenue[i]!;
        if (s.result[i] != null) t!.result[c] = s.result[i]!;
      });
    }
    for (const c of x.capex) fl.capex[c.period] = c.value;
    for (const b of x.bank) fl.bank[b.asAt] = { advances: b.advances ?? fl.bank[b.asAt]?.advances ?? null, deposits: b.deposits ?? fl.bank[b.asAt]?.deposits ?? null };
    for (const r of x.roa) fl.roa[r.period] = r.value;
  }
  fl.segments = fl.segments.filter((s) => Object.keys(s.revenue).length);
  const latestFY = (s: Filed["segments"][number]) => { const k = Object.keys(s.revenue).filter((l) => /^FY/.test(l)).sort().at(-1); return k ? s.revenue[k] : Object.values(s.revenue)[0] ?? 0; };
  fl.segments.sort((a, b) => (UNALLOC.test(a.name) ? 1 : 0) - (UNALLOC.test(b.name) ? 1 : 0) || latestFY(b) - latestFY(a));
  return fl;
}

/**
 * Segment results, capex and (lenders) advances/deposits from the last four results filings.
 * Cached per filing set; the work keeps running if a caller stops waiting, so the next caller
 * gets it from cache. Returns null when NSE has no results filings for the symbol.
 */
export async function filed(r: { symbol: string; basis: string; isFinancial: boolean; quarters: { periods: string[]; revenue: (number | null)[] } }): Promise<Filed | null> {
  const latest = r.quarters.periods.at(-1);
  if (!latest) return null;
  const anns = await recentAnnouncements(r.symbol).catch(() => [] as RawAnn[]);
  const list = resultsFilingsFrom(anns).filter((f) => (idx(f.period) ?? 0) <= (idx(latest) ?? 0)).slice(0, 4);
  if (!list.length) return null;
  const basis: Basis = r.basis === "standalone" ? "standalone" : "consolidated";
  const qRevOf = (label: string) => { const i = r.quarters.periods.findIndex((p) => fyLabel(p) === label); return i >= 0 ? r.quarters.revenue[i] ?? null : null; };
  const key = `filed:${FILED_V}:${r.symbol}:${basis}:${list.map((f) => f.url).join(",")}`;
  return cached(key, 30 * DAY, () => buildFiled(list, basis, r.isFinancial, qRevOf), (v) => !v.partial, { immutable: true });
}

const within = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p.catch(() => null), new Promise<null>((res) => setTimeout(() => res(null), Math.max(0, ms)))]);

// Revenue mix by segment for the research page: latest full year and latest quarter, as filed.
function segmentMix(fl: Filed | null, fin: boolean) {
  if (!fl) return null;
  const labels = new Set(fl.segments.flatMap((s) => Object.keys(s.revenue)));
  const pick = (re: RegExp) => [...labels].filter((l) => re.test(l)).sort((a, b) => (pl(a)!.fy - pl(b)!.fy) || ((pl(a)!.n) - (pl(b)!.n))).at(-1) ?? null;
  const view = (label: string | null) => {
    if (!label) return null;
    const p = pl(label)!;
    const prior = plText(yearBefore(p));
    const rows = fl.segments.filter((s) => s.revenue[label] != null);
    const total = rows.reduce((a, s) => a + s.revenue[label], 0);
    if (!rows.length || total <= 0) return null;
    return {
      period: label,
      rows: rows.map((s) => {
        const rev = s.revenue[label], res = s.result[label];
        const prev = s.revenue[prior];
        return {
          name: s.name, revenue: Math.round(rev), share: +((rev / total) * 100).toFixed(1),
          result: res == null ? null : Math.round(res), margin: res == null || rev <= 0 ? null : +((res / rev) * 100).toFixed(1),
          growth: prev == null || prev <= 0 ? null : +(((rev - prev) / prev) * 100).toFixed(1),
        };
      }),
    };
  };
  const year = view(pick(/^FY/)), quarter = view(pick(/^Q/));
  return {
    basis: fl.basis, unit: "₹ crore", note: fl.note,
    resultLabel: fl.resultLabel ? `Segment result as filed: ${fl.resultLabel}` : "Segment result as filed",
    ...(fin ? { gross: "Bank segment revenue is before inter-segment eliminations, as filed" } : {}),
    year, quarter,
    sources: fl.sources.map((s) => ({ period: s.label, url: s.url, ...(s.error ? { error: s.error } : {}) })),
  };
}

export async function research(symbolIn: string) {
  const symbol = symbolIn.toUpperCase().trim();
  // NSE symbols: letters, digits, & and - (M&M, BAJAJ-AUTO). Reject anything else before any I/O.
  if (!/^[A-Z0-9&-]{1,20}$/.test(symbol)) throw new NotFound(`"${symbolIn}" is not an NSE symbol`);
  const f = await fundamentals(symbol);
  // Banks/NBFCs: lending is an operating cash outflow and borrowings are raw material, so
  // cash conversion and debt/equity say nothing useful. Swap in the lender's lens instead.
  const isFinancial = isFinancialCo(f);
  const A = annualOnly(f);
  const sales = A.cut(row(f.annual, "Sales", "Revenue"));
  const op = A.cut(row(f.annual, "Operating Profit", "Financing Profit"));
  const pat = A.cut(row(f.annual, "Net Profit"));
  const opm = A.cut(row(f.annual, "OPM %", "Financing Margin %"));
  const nii = isFinancial ? A.cut(sub(row(f.annual, "Revenue", "Sales"), row(f.annual, "Interest"))) : [];
  const years = A.headers;
  const n = sales.length;

  const cfo = row(f.cash, "Cash from Operating Activity");
  const cfi = row(f.cash, "Cash from Investing Activity");
  const cashYears = f.cash.headers;
  const k = Math.min(5, cfo?.length ?? 0);
  // Align cash-flow years to P&L years by label, not position (the tables start in different years).
  const patByYear = (y: string) => pat[years.indexOf(y)] ?? null;
  const cashRows = last(cashYears, k).map((y, i) => {
    const idx_ = cashYears.length - k + i;
    const c = cfo?.[idx_] ?? null;
    const p = patByYear(y);
    return {
      year: y, cfo: c, pat: p,
      fcf: c != null && cfi?.[idx_] != null ? c + (cfi[idx_] as number) : null,
      conversion: !isFinancial && c != null && p && p > 0 ? (c / p) * 100 : null,
    };
  });
  const both = cashRows.filter((r) => r.cfo != null && r.pat != null);
  const sumC = both.reduce((a, r) => a + (r.cfo ?? 0), 0);
  const sumP = both.reduce((a, r) => a + (r.pat ?? 0), 0);

  const bh = f.balance.headers;
  const borrowings = row(f.balance, "Borrowings", "Borrowing");
  const reserves = row(f.balance, "Reserves");
  const equity = row(f.balance, "Equity Capital");
  const bi = (borrowings?.length ?? 0) - 1;
  const netWorth = reserves && equity && bi >= 0 ? (reserves[bi] ?? 0) + (equity[bi] ?? 0) : null;
  const de = !isFinancial && borrowings && netWorth ? (borrowings[bi] ?? 0) / netWorth : null;
  const rt = f.ratioTable;
  const lastOf = (...names: string[]) => { const r = row(rt, ...names); return r ? r[r.length - 1] : null; };
  const firstOf = (...names: string[]) => { const r = row(rt, ...names); return r ? r[Math.max(0, r.length - 6)] : null; };
  const ratioYear0 = rt.headers[Math.max(0, rt.headers.length - 6)] ?? null;

  const q = f.quarters;
  const qs = (...name: string[]) => last(row(q, ...name), 8);
  const quarters = {
    periods: last(q.headers, 8),
    revenue: qs("Sales", "Revenue"),
    ebitda: qs("Operating Profit", "Financing Profit"),
    opm: qs("OPM %", "Financing Margin %"),
    pbt: qs("Profit before tax"),
    pat: qs("Net Profit"),
    ...(isFinancial ? { nii: last(sub(row(q, "Revenue", "Sales"), row(q, "Interest")), 8), gnpa: qs("Gross NPA %"), nnpa: qs("Net NPA %") } : {}),
  };

  // Segment mix, capex and lender balance-sheet lines from the company's own results filings.
  // Waits a bounded time (the work continues and lands in the cache for the next view).
  const basis = f.basis;
  const fl = await within(filed({ symbol: f.symbol, basis, isFinancial, quarters }), 14_000);
  const segments = segmentMix(fl, isFinancial);

  const signals = { bull: [] as string[], bear: [] as string[] };
  const g3 = cagr(sales[n - 4], sales[n - 1]);
  const p3 = cagr(pat[n - 4], pat[n - 1]);
  const span = n >= 4 ? `FY${years[n - 4]?.slice(-2)}–${years[n - 1]?.slice(-2)}` : "";
  const top = isFinancial ? "Revenue (interest earned)" : "Revenue";
  if (g3 != null) {
    if (g3 >= 12) signals.bull.push(`${top} 3-yr CAGR ${g3.toFixed(0)}% (${span})`);
    else if (g3 < 6) signals.bear.push(`${top} 3-yr CAGR only ${g3.toFixed(0)}% (${span})`);
  }
  if (p3 != null && g3 != null && Math.abs(p3 - g3) >= 2)
    (p3 > g3 ? signals.bull : signals.bear).push(`Profit ${p3 > g3 ? "outgrowing" : "lagging"} revenue (${p3.toFixed(0)}% vs ${g3.toFixed(0)}% CAGR)`);
  const conv = !isFinancial && sumP > 0 ? (sumC / sumP) * 100 : null;
  if (conv != null) {
    if (conv >= 80) signals.bull.push(`${both.length}-yr cash conversion ${conv.toFixed(0)}% of PAT`);
    else signals.bear.push(`Only ${conv.toFixed(0)}% of ${both.length}-yr PAT became operating cash`);
  }
  if (!isFinancial && opm.length >= 4) {
    const d = (opm[opm.length - 1] ?? 0) - (opm[opm.length - 4] ?? 0);
    if (Math.abs(d) >= 1) (d > 0 ? signals.bull : signals.bear).push(`Operating margin ${d > 0 ? "expanded" : "compressed"} ${Math.abs(d).toFixed(0)} pts over 3 yrs (${opm[opm.length - 4]}% → ${opm[opm.length - 1]}%)`);
  }
  if (de != null) {
    if (de < 0.3) signals.bull.push(`Lightly geared: debt/equity ${de.toFixed(2)}×`);
    else if (de > 1) signals.bear.push(`Leveraged: debt/equity ${de.toFixed(2)}×`);
  }
  const ccc = isFinancial ? null : lastOf("Cash Conversion Cycle"), ccc0 = isFinancial ? null : firstOf("Cash Conversion Cycle");
  if (ccc != null && ccc0 != null && Math.abs(ccc - ccc0) > 10) (ccc < ccc0 ? signals.bull : signals.bear).push(`Cash cycle ${ccc0}→${ccc} days since ${ratioYear0}`);
  // Lender lens: asset quality and returns.
  const gnpa = isFinancial ? row(q, "Gross NPA %") : undefined;
  if (gnpa) {
    const g = gnpa.filter((x) => x != null) as number[];
    if (g.length >= 5) {
      const now = g[g.length - 1], yr = g[g.length - 5];
      if (Math.abs(now - yr) >= 0.1) (now < yr ? signals.bull : signals.bear).push(`Gross NPA ${yr}% → ${now}% over 4 quarters`);
    }
  }
  const roeRow = isFinancial ? row(rt, "ROE %") : undefined;
  if (roeRow && roeRow.length >= 4) {
    const a = roeRow[roeRow.length - 4], b = roeRow[roeRow.length - 1];
    if (a != null && b != null) (b >= 15 && b >= a - 1 ? signals.bull : signals.bear).push(`ROE ${a}% → ${b}% over 3 yrs`);
  }
  // Segment lens (from the filings): concentration, and the segment doing the heavy lifting.
  if (segments?.year && !isFinancial) {
    const rows = segments.year.rows.filter((x) => !UNALLOC.test(x.name));
    const top1 = rows[0];
    if (top1 && top1.share >= 75 && rows.length > 1) signals.bear.push(`Concentrated: ${top1.name} is ${top1.share.toFixed(0)}% of ${segments.year.period} segment revenue`);
    const fast = segments.quarter?.rows.filter((x) => !UNALLOC.test(x.name) && x.share >= 8 && x.growth != null).sort((a, b) => b.growth! - a.growth!)[0];
    if (fast && fast.growth! >= 20) signals.bull.push(`${fast.name} revenue +${fast.growth!.toFixed(0)}% YoY in ${segments.quarter!.period} (${fast.share.toFixed(0)}% of mix)`);
  }

  return {
    symbol: f.symbol, name: f.name, about: f.about, sector: f.sector, industry: f.industry, basis: f.basis, source: f.source,
    isFinancial,
    ratios: f.ratios,
    trajectory: {
      years: last(years, 6), sales: last(sales, 6), ebitda: last(op, 6), pat: last(pat, 6), opm: last(opm, 6), salesCagr3: g3, patCagr3: p3,
      cagrSpan: span || null, ...(isFinancial ? { nii: last(nii, 6) } : {}),
    },
    balance: {
      years: last(bh, 6), borrowings: last(borrowings, 6), de, netWorth,
      debtorDays: isFinancial ? null : lastOf("Debtor Days"), inventoryDays: isFinancial ? null : lastOf("Inventory Days"), payableDays: isFinancial ? null : lastOf("Days Payable"),
      ccc, ccc0, ccc0Year: ccc0 != null ? ratioYear0 : null, roce: lastOf("ROCE %"), roe: lastOf("ROE %"), wcDays: isFinancial ? null : lastOf("Working Capital Days"),
      ...(isFinancial ? { deposits: last(row(f.balance, "Deposits"), 6) } : {}),
    },
    cash: { rows: cashRows, conversion: conv, ...(isFinancial ? { note: "Not meaningful for a lender: loan growth is an operating cash outflow." } : {}) },
    quarters,
    // Business snapshot by segment (null while the filings are still being read: segmentsPending).
    segments,
    segmentsPending: fl == null,
    // Capex (cash-flow statement) and, for lenders, advances/deposits/ROA as filed — period -> ₹ crore / %.
    filed: fl ? {
      capex: Object.entries(fl.capex).map(([period, value]) => ({ period, value: Math.round(value) })),
      ...(isFinancial ? {
        balance: Object.entries(fl.bank).sort((a, b) => (idx(a[0]) ?? 0) - (idx(b[0]) ?? 0)).map(([asAt, v]) => ({
          asAt, advances: v.advances == null ? null : Math.round(v.advances), deposits: v.deposits == null ? null : Math.round(v.deposits),
          ldr: v.advances != null && v.deposits ? +((v.advances / v.deposits) * 100).toFixed(1) : null,
        })),
        roa: Object.entries(fl.roa).map(([period, value]) => ({ period, value: +value.toFixed(2) })),
      } : {}),
    } : null,
    signals,
    concalls: f.concalls.slice(0, 6),
    annualReports: f.annualReports.slice(0, 3),
    network: leadsForCompany({ name: f.name, symbol: f.symbol, sector: f.industry ?? f.sector }).slice(0, 4).map((l) => ({
      id: l.contact.id, name: l.contact.name, headline: l.contact.headline, why: l.why, relation: l.relation, via: l.via?.name, score: l.score,
    })),
  };
}

export type Research = Awaited<ReturnType<typeof research>>;

// ---------- Narrative vs numbers: promised vs delivered over the last 4 calls ----------
//
// Pipeline (cheap → expensive, every step cached by content):
//   1. fetch + parse up to 6 transcripts concurrently (pool 4, first 30 pages); in parallel, read
//      the last four results filings for segment results, capex and lender balance sheets
//   2. rules: split into speaker turns, keep MANAGEMENT turns only (analyst questions dropped),
//      keep sentences that are forward-looking AND carry a number  → ~3-6k chars per call
//   3. fast tier, one call per transcript: pick explicit numeric guidance (by sentence number,
//      so the quote is verbatim from the transcript, never paraphrased by the model); rules then
//      drop statements of the present, industry forecasts and numbers with no measured quantity
//   4. smart tier, one call total: map every promise to a reported line and period, and judge
//      what the reported numbers can't measure (KPIs) from management's own later statements
//   5. code: for every promise mapped to a line, compute the actual figure for the guided period
//      and the verdict (delivered / partly / missed, or ahead / on track / behind so far) — the
//      model never does the arithmetic, and code overrides it where the two disagree
//   A 50s budget wraps it all: anything still running is returned as partial and keeps going in
//   the background, so the next view comes straight from cache.

// Which quarter does a call discuss? Read it from the transcript title; else the latest quarter
// that ended before the call month.
function quarterDiscussed(head: string, callMonth: string): { period: string | null; fromTitle: boolean } {
  const pats: [RegExp, (m: RegExpMatchArray) => string | null][] = [
    // "Q2 FY27", "Q1FY'27", "Q4 & FY26", "Q4 & Full Year FY 2026", "Q4 & FY 2025-26" (the range means FY26)
    [/\bQ\s?([1-4])\s*(?:(?:&|and)\s*(?:H[12]|9M|full\s+year|12M)?\s*)?(?:FY|F\.Y\.?)\s*['’]?\s*(?:20)?(\d{2})(?:\s*[-–/]\s*(?:20)?(\d{2}))?\b/i, (m) => periodOf(+m[1], 2000 + +(m[3] ?? m[2]))],
    [/\b([1-4])Q\s*(?:FY)\s*['’]?\s*(?:20)?(\d{2})(?:\s*[-–/]\s*(?:20)?(\d{2}))?\b/i, (m) => periodOf(+m[1], 2000 + +(m[3] ?? m[2]))],
    [/\b(first|second|third|fourth)\s+quarter[\s,]+(?:of\s+)?(?:the\s+)?(?:financial\s+year\s+|fiscal\s+(?:year\s+)?)?(?:FY\s*)?['’]?(?:20)?(\d{2})\b/i,
      (m) => periodOf(["first", "second", "third", "fourth"].indexOf(m[1].toLowerCase()) + 1, 2000 + +m[2])],
    [/(?:quarter|months|period)\s+ended\s+(?:on\s+)?(?:\d{1,2}(?:st|nd|rd|th)?\s+)?(March|June|September|December)[\s,]*(?:\d{1,2}(?:st|nd|rd|th)?,?\s*)?(20\d{2})/i,
      (m) => `${m[1].slice(0, 3)} ${m[2]}`],
  ];
  let best: { at: number; p: string } | null = null;
  for (const [re, fn] of pats) {
    const m = head.match(re);
    const p = m ? fn(m) : null;
    if (m && p && (!best || (m.index ?? 0) < best.at)) best = { at: m.index ?? 0, p };
  }
  if (best) return { period: best.p, fromTitle: true };
  const [mm, yy] = callMonth.split(" ");
  const mi = MONTHS.indexOf(mm?.toLowerCase().slice(0, 3));
  if (mi < 0 || !Number(yy)) return { period: null, fromTitle: false };
  const ends = [2, 5, 8, 11].filter((e) => e < mi);
  return { period: ends.length ? `${MON[ends[ends.length - 1]]} ${yy}` : `Dec ${Number(yy) - 1}`, fromTitle: false };
}

const HON = /\b(?:MR|Mr|MS|Ms|MRS|Mrs|DR|Dr|SHRI|Shri|SMT|Smt|PROF|Prof)\.?[ \t]+([A-Z][A-Za-z.'’]*(?:[ \t]+[A-Z][A-Za-z.'’]*){0,3})/g;
const toks = (s: string) => s.toLowerCase().replace(/\b(mr|ms|mrs|dr|shri|smt|prof)\b\.?/g, " ").split(/[^a-z]+/).filter((t) => t.length >= 2);

// Display case for names and titles printed in capitals ("MR. ATUL LALL – MANAGING DIRECTOR").
const KEEP_CAPS = /^(CEO|CFO|COO|CTO|CIO|CHRO|CMO|CRO|CDO|CXO|MD|CMD|IR|ED|WTD|VP|SVP|EVP|AVP|HR|IT|EMS|BFSI|CS|KMP|SMP|II|III|IV|LLP|ESG|R&D|USA|UK|UAE|GM|DGM|AGM|IAS|IPS|IRS|IFS|PSU|HAL|SBI|HDFC|ICICI|IDFC|LIC|GIFT)$/;
export function displayCase(s: string) {
  const t = s.replace(/\s+/g, " ").trim();
  if (/[a-z]/.test(t)) return t; // already mixed case
  return t.split(" ").map((w) => (KEEP_CAPS.test(w.replace(/[^A-Z&]/g, "")) || /^[A-Z]\.?$/.test(w) ? w : w.split(/([-'’(])/).map((p) => (p.length > 1 ? p[0] + p.slice(1).toLowerCase() : p)).join(""))).join(" ");
}

// Management names from the title page ("MANAGEMENT: MR. ATUL LALL – MANAGING DIRECTOR …").
type Mgr = { t: string[]; title: string; name: string };
function managementNames(preRaw: string): Mgr[] {
  // Small-caps PDFs come out letter-spaced: "M ANAGEMENT: M R. R AVI K OTA" -> "MANAGEMENT: MR. RAVI KOTA".
  const pre = preRaw.replace(/\b([A-Z]) (?=[A-Z]{2,})/g, "$1").replace(/\b([MD]) ?R ?\./g, "$1R.").replace(/\b(MR|MS|MRS|DR|SHRI|SMT)\s+\./gi, "$1.");
  const m = pre.match(/(?:MANAGEMENT(?:\s+(?:SPEAKERS|PARTICIPANTS|TEAM|REPRESENTATIVES))?|SPEAKERS|COMPANY\s+PARTICIPANTS|EXECUTIVES)\s*:/i);
  if (!m) return [];
  let block = pre.slice((m.index ?? 0) + m[0].length);
  const stop = block.search(/\b(?:MODERATORS?|ANALYSTS?|HOSTS?|CONFERENCE\s+HOST)\s*:|\n\s*Page \d+/i);
  if (stop > 0) block = block.slice(0, stop);
  const JUNK = /^(limited|ltd|officer|director|chief|company|india|head|president|managing|financial|executive|group)$/;
  const hits = [...block.matchAll(HON)];
  // Title = whatever sits between this name and the next one ("– CEO, EYECARE DIVISION").
  const names = hits.map((x, i) => {
    const words = x[1].split(/[ \t]+/);
    let k = words.length;
    while (k > 1 && JUNK.test(words[k - 1].toLowerCase().replace(/[^a-z]/g, ""))) k--;
    return {
      t: toks(x[1]).filter((t) => !JUNK.test(t)),
      name: displayCase(words.slice(0, k).join(" ").replace(/[.,;:–-]+$/, "")),
      title: block.slice((x.index ?? 0) + x[0].length, hits[i + 1]?.index ?? block.length).replace(/\s+/g, " ").replace(/^[\s–,-]+|[\s–,-]+$/g, "").slice(0, 160),
    };
  }).filter((n) => n.t.length);
  if (names.length) return names;
  return block.split("\n").map((l) => l.split(/\s[–-]\s|,/)[0].trim()).filter((l) => /^[A-Za-z.' ]{4,40}$/.test(l) && l.split(/\s+/).length <= 4)
    .map((l) => ({ t: toks(l).filter((t) => !JUNK.test(t)), title: "", name: displayCase(l) })).filter((n) => n.t.length);
}

// Is this speaker running a division / subsidiary rather than the listed company?
// "CEO, Eyecare Division", "Managing Director, CaratLane" -> yes; "CFO – HDFC Bank Limited" -> no.
const TITLE_WORDS = /^(chief|officer|director|managing|president|head|group|secretary|legal|counsel|finance|financial|executive|vice|senior|strategy|relations|investor|corporate|operations|technology|human|resources|company|limited|ltd|india|private|the|and|of|whole|time|interim|part|chairman|chairperson|deputy|joint|additional|charge|with|engineering|research|development|cfo|ceo|coo|md|cio|cto|ir|svp|evp|avp|global|business|independent|non|accounts|treasury|planning|compliance|member|board|designate|officiating)$/;
function segmentTitle(title: string, company: string) {
  if (!title) return false;
  if (/\b(division|segment|vertical|subsidiary|business unit|bu head)\b/i.test(title)) return true;
  const org = title.split(/,|\s[–-]\s/).slice(1).join(" ");
  const co = toks(company);
  // A word cut off by the 160-char title limit ("HINDU" for HINDUSTAN) still belongs to the company.
  const odd = toks(org).filter((w) => w.length >= 4 && !TITLE_WORDS.test(w) && !co.some((c) => c === w || c.startsWith(w) || w.startsWith(c)));
  return odd.length > 0;
}

type Role = "mgmt" | "analyst" | "moderator" | "unknown";
type Turn = { speaker: string; role: Role; text: string; title?: string };

const NOT_SPEAKER = /^(page|note|disclaimer|sub|subject|ref|isin|cin|website|e-?mail|tel|fax|ph|regd|encl|scrip|symbol|date|to|dear|annexure|source)\b/i;

export function parseTranscript(text: string, callMonth = "") {
  const lines = text.split("\n").map((l) => l.trim());
  // Repeated running headers/footers ("Company Ltd", "October 30, 2026", "Page 3 of 23") are noise.
  const freq = new Map<string, number>();
  for (const l of lines) if (l.length < 80) freq.set(l, (freq.get(l) ?? 0) + 1);
  const clean = lines.filter((l) => l && !/^Page \d+ of \d+$/i.test(l) && !(l.length < 80 && (freq.get(l) ?? 0) >= 4));
  const firstMod = clean.findIndex((l) => /^(Moderator|Operator)\b/i.test(l));
  const pre = clean.slice(0, firstMod > 0 ? firstMod : 60).join("\n");
  const qd = quarterDiscussed(pre + "\n" + clean.slice(Math.max(0, firstMod), Math.max(0, firstMod) + 8).join(" "), callMonth);
  const quarter = qd.period;
  const earnings = qd.fromTitle || /earnings|results/i.test(pre);
  const mgmt = managementNames(pre);
  const body = clean.slice(Math.max(0, firstMod));

  const colon = /^([A-Z][A-Za-z.'’-]*(?:\s+[A-Z][A-Za-z.'’-]*){0,4})\s*:\s*(.*)$/;
  const colonCount = body.filter((l) => colon.test(l) && !NOT_SPEAKER.test(l)).length;
  const intros = new Set<string>(); // analysts the moderator introduces ("question is from the line of X")
  const introRe = /(?:line of|question (?:is |comes )?from|questions? from|next is from)\s+(?:the line of\s+)?(?:Mr\.?|Ms\.?|Mrs\.?|Dr\.?)?\s*([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,2})/g;
  for (const m of body.join(" ").matchAll(introRe)) intros.add(toks(m[1]).sort().join(" "));
  const mgrOf = (label: string) => {
    const t = toks(label);
    if (!t.length) return undefined;
    return mgmt.find((n) => {
      const hit = t.filter((x) => x.length >= 3 && n.t.includes(x)).length;
      return t.length === 1 ? hit === 1 : hit >= 2 || (hit === 1 && n.t.length === 1);
    });
  };
  const isMgmt = (label: string) => !!mgrOf(label);
  const isIntro = (label: string) => {
    const t = toks(label);
    return [...intros].some((n) => { const nt = n.split(" "); return t.filter((x) => nt.includes(x)).length >= Math.min(2, t.length); });
  };
  // Speaker at the start of a line, with or without a colon (some transcripts write "Sandeep Kalra Thank you").
  const mgmtFull = mgmt.map((n) => n.t.join(" "));
  const speakerOf = (l: string): { label: string; rest: string } | null => {
    if (/^(Moderator|Operator)\b/i.test(l)) return { label: "Moderator", rest: l.replace(/^(Moderator|Operator)\b\s*:?\s*/i, "") };
    const m = l.match(colon);
    if (m && !NOT_SPEAKER.test(m[1]) && m[1].length <= 40) return { label: m[1], rest: m[2] };
    if (colonCount < 10) {
      const words = l.replace(/^(?:Mr|Ms|Mrs|Dr)\.?\s+/, "").split(/\s+/);
      for (const w of [3, 2]) {
        const head = words.slice(0, w).join(" ").toLowerCase().replace(/[^a-z ]/g, "");
        if (mgmtFull.includes(head) || (w === 2 && [...intros].includes(head.split(" ").sort().join(" "))))
          return { label: words.slice(0, w).join(" "), rest: words.slice(w).join(" ") };
      }
    }
    return null;
  };

  // A moderator turn that opens Q&A or introduces a questioner (not the "you may ask questions later" preamble).
  const QA = /(?:first|next|last|following) question|question[- ]and[- ]answer session|Q&A session|line of\b|question (?:is |comes )?from/i;
  const turns: Turn[] = [];
  const known = new Map<string, Role>();
  let cur: Turn | null = null;
  let qaStarted = false;
  let preQA = 0;
  for (const l of body) {
    const sp = speakerOf(l);
    if (!sp) { if (cur) cur.text += " " + l; continue; }
    const prev = cur;
    if (prev?.role === "moderator" && QA.test(prev.text)) qaStarted = true;
    let role: Role;
    const key = sp.label.toLowerCase();
    if (sp.label === "Moderator") role = "moderator";
    else if (/^(management|company)$/i.test(sp.label) || isMgmt(sp.label)) role = "mgmt";
    else if (known.has(key)) role = known.get(key)!;
    else if (isIntro(sp.label) || (prev?.role === "moderator" && QA.test(prev.text))) { role = "analyst"; known.set(key, role); }
    // Section headings inside management's remarks ("Refrigerators: …", "Home Appliances: …").
    else if (prev?.role === "mgmt" && (!qaStarted || (sp.label.split(/\s+/).length === 1 && !/[?]/.test(sp.rest)))) role = "mgmt";
    else role = mgmt.length ? "unknown" : "mgmt"; // no cast list on the title page: anyone not introduced as a questioner
    cur = { speaker: sp.label, role, text: sp.rest, title: role === "mgmt" ? mgrOf(sp.label)?.title || undefined : undefined };
    if (!qaStarted) preQA = turns.length + 1;
    turns.push(cur);
  }
  // Prepared remarks are management's: a long pre-Q&A speech by someone missing from the cast list
  // (a chairman who joined late) counts; the host's short welcome does not.
  for (let i = 0; i < preQA; i++) if (turns[i].role === "unknown" && turns[i].text.length > 1500) turns[i].role = "mgmt";
  if (!turns.length) turns.push({ speaker: "", role: "unknown", text: body.join(" ") });
  return {
    quarter, earnings,
    management: mgmt.map((n) => n.title ? `${n.t.join(" ")} (${n.title})` : n.t.join(" ")),
    // The cast list as printed on the title page, in display case (for people diligence).
    cast: mgmt.map((n) => ({ name: n.name, title: displayCase(n.title.replace(/^[\s–,:-]+/, "")) })),
    turns,
  };
}

const FWD = /\b(guid\w*|outlook|expect\w*|target\w*|aspir\w*|aim(?:ing)?\s+to|plan(?:ning)?\s+to|intend\w*|envisag\w*|anticipat\w*|foresee\w*|we will|we'll|we would|will (?:be|grow|deliver|reach|achieve|see|continue|remain|come|cross|touch|double)|should (?:be|grow|see|come|reach)|going to|going forward|next (?:year|quarter|fiscal|financial year|few quarters|\d+ (?:years|quarters))|coming (?:year|quarters?)|over the (?:next|medium|long)|by (?:the )?(?:end of )?(?:FY|20\d\d)|run[- ]rate|on track|confident|sustain\w*|maintain\w*|band|corridor|range of|trajectory)\b/gi;
const STRONG = /\b(guid\w*|outlook|target\w*|expect\w*|aspir\w*)\b/i;
const NUM = /\d+(?:\.\d+)?\s?(?:%|percent|per cent|bps|basis points|crores?|cr\b|bn|billion|lakh|x\b|times)|double[- ]digit|single[- ]digit|(?:low|mid|high)[- ](?:teens|single|twenties)|\bteens\b|\b(?:INR|Rs\.?|₹)\s?\d/i;
const FYREF = /\b(FY\s?'?\d{2}|H[12]|Q[1-4]|20\d\d)\b/;
const PAST = /\b(was|were|grew|stood at|reported|registered|delivered|achieved|recorded|declined|clocked)\b/i;

type Sent = { n: number; text: string; speaker: string; title?: string; score: number };

export function guidanceSentences(turns: Turn[], maxChars = 6000, max = 30): Sent[] {
  const out: Sent[] = [];
  let pos = 0;
  for (const t of turns) {
    if (t.role !== "mgmt") continue;
    const prot = t.text.replace(/\s+/g, " ").replace(/\b(Mr|Ms|Mrs|Dr|Rs|No|vs|approx|Co|Ltd|Inc|St|Nos)\./g, "$1․");
    for (const raw of prot.split(/(?<=[.?!])\s+(?=[A-Z"“(₹])/)) {
      const s = raw.replace(/․/g, ".").trim();
      pos++;
      if (s.length < 40 || s.length > 500 || /\?\s*$/.test(s) || !NUM.test(s)) continue;
      const f = s.match(FWD)?.length ?? 0;
      if (!f) continue;
      const score = f + (STRONG.test(s) ? 2 : 0) + (FYREF.test(s) ? 1 : 0) - (PAST.test(s) && f <= 1 ? 2 : 0);
      if (score >= 1) out.push({ n: pos, text: s, speaker: t.speaker, title: t.title, score });
    }
  }
  // Keep the strongest, then restore transcript order; cap the characters sent to the model.
  const top = out.sort((a, b) => b.score - a.score).slice(0, max).sort((a, b) => a.n - b.n);
  const kept: Sent[] = [];
  let chars = 0;
  for (const s of top) {
    if (chars + s.text.length > maxChars) continue;
    chars += s.text.length;
    kept.push(s);
  }
  return kept.map((s, i) => ({ ...s, n: i + 1 }));
}

// What management says it ACTUALLY did (past tense + a number) — on a later call this is primary
// evidence for promises the reported numbers can't measure (sub-segments, volumes, store adds…).
const ACT = /\b(was|were|grew|stood at|reported|registered|delivered|achieved|recorded|declined|clocked|increased|decreased|rose|fell|expanded|improved|came in|ended|added|opened|crossed|received|bagged|won|signed|concluded|booked|secured|spent|incurred|invested)\b/i;
const KPI = /\b(grew|growth|margin|revenue|sales|volume|EBITDA|EBIT|profit|PAT|stores?|order|capex|debt|market share|units|utili[sz]ation|inflow|book)\b/i;
export function actualSentences(turns: Turn[], maxChars = 2400, max = 14): string[] {
  const out: { n: number; s: string; score: number }[] = [];
  let pos = 0;
  for (const t of turns) {
    if (t.role !== "mgmt") continue;
    const prot = t.text.replace(/\s+/g, " ").replace(/\b(Mr|Ms|Mrs|Dr|Rs|No|vs|approx|Co|Ltd|Inc|St|Nos)\./g, "$1․");
    for (const raw of prot.split(/(?<=[.?!])\s+(?=[A-Z"“(₹])/)) {
      const s = raw.replace(/․/g, ".").trim();
      pos++;
      if (s.length < 40 || s.length > 400 || /\?\s*$/.test(s) || !NUM.test(s) || !ACT.test(s)) continue;
      if ((s.match(FWD)?.length ?? 0) > 1) continue; // mostly forward-looking: not a fact
      const nums_ = s.match(new RegExp(NUM.source, "gi"))?.length ?? 0;
      out.push({ n: pos, s, score: nums_ + (KPI.test(s) ? 2 : 0) });
    }
  }
  const top = out.sort((a, b) => b.score - a.score).slice(0, max).sort((a, b) => a.n - b.n);
  const kept: string[] = [];
  let chars = 0;
  for (const x of top) {
    if (chars + x.s.length > maxChars) continue;
    chars += x.s.length;
    kept.push(x.s);
  }
  return kept;
}

// ---------- which promises are real guidance (deterministic filters on the model's picks) ----------
// A promise needs a future marker in the sentence, must not be a description of today ("is making
// 5-6% EBIT margin", "disbursals are up 10-20%"), must be about the company (not the industry or
// the economy), and must name what the number measures.
const FUTURE = /\b(will|['’]ll|shall|would|should|could|expect\w*|guid\w*|target\w*|aspir\w*|aim\w*|plan\w*|intend\w*|anticipat\w*|envisag\w*|project\w*|forecast\w*|outlook|going to|look(?:ing)? (?:to|at|for)|hop(?:e|ing)|endeavou?r\w*|commit\w*|budget\w*|likely|revis\w*|estimat\w*|next (?:year|quarter|fiscal|financial year|few|two|three|\d)|coming (?:year|quarters?|years)|over the (?:next|medium|long)|by (?:the )?(?:end of )?(?:FY|20\d\d|march|q[1-4])|this (?:year|fiscal|quarter|financial year)|current (?:year|fiscal|quarter|financial year)|for (?:the )?(?:full )?(?:year|FY)|going forward|to be (?:delivered|achieved)|on track|trajectory|horizon|onwards|stick(?:ing)? to|maintain\w*|sustain\w*)\b/i;
const PRESENT = /\b(?:is|are|has been|have been)\s+(?:\w+\s+){0,3}?(?:making|doing|running|clocking|delivering|generating|up|down|in the range)\b|\b(?:currently|today|right now|at present|presently|stands? at|so far|year[- ]to[- ]date|YTD)\b/i;
const MACRO = /\b(system|industry|sector(?:al)?|economy|gdp|inflation|repo|policy rate|monsoon|market size|banking system|commodity prices?|interest rate cycle)\b/i;
const QUANTITY = /\b(revenue|sales|turnover|top[- ]?line|income|margin|growth|grow|cagr|profit|ebitda|ebit|pat|pbt|earnings|eps|capex|capital expenditure|debt|borrowings?|loans?|advances|credit|deposits?|nim|roa|roe|roce|return|cost|tax|etr|volume|orders?|order book|utili[sz]ation|stores?|market share|dividend|payout|cash|working capital|inventory|npa|provision|ldr|ratio|headcount|capacity|realisation|realization|price|asp|run[- ]?rate|disburse\w*|aum|book)\b/i;
function notGuidance(p: { promise: string; quote: string; subject: string }, sentence: string): string | null {
  if (!FUTURE.test(sentence)) return "no future marker";
  if (PRESENT.test(p.quote) && !FUTURE.test(p.quote)) return "describes the present";
  if (MACRO.test(`${p.subject} ${p.promise}`) && !/market share/i.test(p.promise)) return "industry or macro forecast";
  if (!QUANTITY.test(`${p.promise} ${p.subject}`)) return "no measured quantity";
  return null;
}

export type Promise_ = { call: string; metric: string; promise: string; horizon: string; quote: string };
export type VerdictKind = "delivered" | "missed" | "partly" | "too early" | "unverifiable";
export type Verdict = Promise_ & {
  delivered: string; verdict: VerdictKind; note: string;
  speaker?: string; quarter?: string | null; scope?: string; subject?: string; reiterated?: string[];
  // Additive: how the verdict was reached.
  soFar?: "ahead" | "on track" | "behind" | null; // for "too early": the run-rate against the guide
  measured?: { line: string; segment?: string | null; periods: string[]; actual: { period: string; value: number }[]; target: string; by: "code" } | null;
  modelVerdict?: VerdictKind; // the judge's own call, when code overrode it
  revised?: { call: string; promise: string }[]; // the same guide restated with different numbers on a later call
};

type Extracted = Promise_ & { speaker: string; quarter: string | null; scope: string; subject: string; id?: number; reiterated?: string[]; revised?: { call: string; promise: string }[] };

// Largest INR-crore amount in a piece of text ("INR 3,500 crores to INR 4,000 crores" -> 4000).
function croreAmount(s: string): number | null {
  let best: number | null = null;
  for (const m of s.matchAll(/([\d,]+(?:\.\d+)?)\s*(?:-|–|to)?\s*(?:INR|Rs\.?|₹)?\s*([\d,]+(?:\.\d+)?)?(?:\s*-?\s*odd)?\s*(crores?|cr\b)/gi)) {
    const v = Number((m[2] ?? m[1]).replace(/,/g, ""));
    if (Number.isFinite(v) && (best == null || v > best)) best = v;
  }
  return best;
}

// ---------- the guided number, parsed from the promise / quote (no model arithmetic) ----------
type Target = { lo: number; hi: number; unit: "%" | "cr" | "pts"; approx: boolean };
function parseTarget(promise: string, quote: string): Target | "usd" | null {
  for (const raw of [promise, quote]) {
    if (/(?:US\$|\$|USD|dollars?)\s*\d|\d\s*(?:bn|billion|million|mn)\s*(?:US\$|USD|dollars?)/i.test(raw)) return "usd";
    const t = raw.replace(/(\d),(?=\d)/g, "$1").replace(/[–—]/g, "-");
    const N = Number;
    const approx = /\b(around|about|approx\w*|close to|roughly|cent(?:er|re) of gravity|in the vicinity|ballpark)\b|~/i.test(t);
    const atLeast = /\b(at least|minimum|min\.|more than|over and above|upwards of|north of|cross(?:ing)?|exceed\w*|beyond|double[- ]digit)\b/i.test(t);
    const atMost = /\b(at most|below|under|less than|not more than|maximum|max\.|cap(?:ped)? at|within)\b/i.test(t);
    const dirs = (x: Target): Target => ({ ...x, hi: atLeast && !atMost ? Infinity : x.hi, lo: atMost && !atLeast ? -Infinity : x.lo });
    let m = t.match(/(\d+(?:\.\d+)?)\s*%?\s*,?\s*(?:\+\/-|±|plus\s*(?:\/|or)?\s*minus|give or take(?:\s*plus\s*(?:\/|or)?\s*minus)?)\s*(\d+(?:\.\d+)?)\s*(bps|basis points|%|percent)?/i);
    if (m) { const c = N(m[1]), w = /bp|basis/i.test(m[3] ?? "") ? N(m[2]) / 100 : N(m[2]); return { lo: c - w, hi: c + w, unit: "%", approx: false }; }
    m = t.match(/(\d+(?:\.\d+)?)\s*(?:bps|basis points)?\s*(?:-|to|,|or|and)\s*(\d+(?:\.\d+)?)\s*(?:bps|basis points)/i) ?? t.match(/(\d+(?:\.\d+)?)\s*(?:bps|basis points)/i);
    if (m) {
      const a = N(m[1]) / 100, b = N(m[2] ?? m[1]) / 100;
      const down = /contract|declin|compress|reduc|lower|down|fall|drop|dilut/i.test(t);
      return dirs(down ? { lo: -Math.max(a, b), hi: -Math.min(a, b), unit: "pts", approx } : { lo: Math.min(a, b), hi: Math.max(a, b), unit: "pts", approx });
    }
    m = t.match(/(\d+(?:\.\d+)?)\s*lakh\s*crores?/i);
    if (m) return dirs({ lo: N(m[1]) * 1e5, hi: N(m[1]) * 1e5, unit: "cr", approx: true });
    m = t.match(/(?:INR|Rs\.?|₹)?\s*(\d+(?:\.\d+)?)\s*(?:crores?|cr\b)?\s*(?:-|to|and|or)\s*(?:INR|Rs\.?|₹)?\s*(\d+(?:\.\d+)?)\s*(?:-?\s*odd\s*)?(?:crores?|cr\b)/i);
    if (m && N(m[2]) >= N(m[1])) return dirs({ lo: N(m[1]), hi: N(m[2]), unit: "cr", approx: false });
    m = t.match(/(?:INR|Rs\.?|₹)?\s*(\d+(?:\.\d+)?)\s*(?:-?\s*odd\s*)?(?:crores?|cr\b)/i);
    if (m) return dirs({ lo: N(m[1]), hi: N(m[1]), unit: "cr", approx: true });
    m = t.match(/(\d+(?:\.\d+)?)\s*(?:%|percent|per cent)?\s*(?:-|to|and|or|,)\s*(\d+(?:\.\d+)?)\s*(?:%|percent|per cent)/i);
    if (m && N(m[2]) >= N(m[1]) && N(m[2]) - N(m[1]) <= 15) return dirs({ lo: N(m[1]), hi: N(m[2]), unit: "%", approx: false });
    m = t.match(/(\d+(?:\.\d+)?)\s*(?:%|percent|per cent)/i);
    if (m) return dirs({ lo: N(m[1]), hi: N(m[1]), unit: "%", approx: true });
    const W: [RegExp, number, number][] = [[/low[- ]double[- ]digit/i, 10, 13], [/mid[- ]teens/i, 14, 16], [/high[- ]teens/i, 17, 19], [/low[- ]teens/i, 11, 13], [/double[- ]digit/i, 10, Infinity], [/high[- ]single[- ]digit/i, 7, 9], [/mid[- ]single[- ]digit/i, 4, 6], [/low[- ]single[- ]digit/i, 1, 3], [/\bteens\b/i, 13, 19]];
    for (const [re, lo, hi] of W) if (re.test(t)) return { lo, hi, unit: "%", approx: true };
  }
  return null;
}

// ---------- the reported numbers, as a lookup the measurement code and the judge share ----------
type Num = number | null;
type QRow = { rev: Num; op: Num; dep: Num; oi: Num; int: Num; pbt: Num; tax: Num; pat: Num; gnpa: Num; nnpa: Num };
type Book = {
  fin: boolean; latestQ: string; q: Map<string, QRow>; y: Map<string, QRow>;
  roe: Map<string, number>; borrowings: Map<string, number>; deposits: Map<string, number>; fl: Filed | null;
};
function makeBook(r: Research, f: Fundamentals, fl: Filed | null): Book {
  const fin = r.isFinancial;
  const take = (t: Fundamentals["quarters"], i: number): QRow => {
    const g = (...n: string[]) => row(t, ...n)?.[i] ?? null;
    return { rev: g("Sales", "Revenue"), op: fin ? null : g("Operating Profit"), dep: g("Depreciation"), oi: g("Other Income"), int: g("Interest"), pbt: g("Profit before tax"), tax: g("Tax %"), pat: g("Net Profit"), gnpa: g("Gross NPA %"), nnpa: g("Net NPA %") };
  };
  const q = new Map<string, QRow>();
  f.quarters.headers.forEach((h, i) => q.set(fyLabel(h), take(f.quarters, i)));
  const y = new Map<string, QRow>();
  const A = annualOnly(f);
  A.headers.forEach((h, i) => { if (/^Mar/i.test(h)) y.set(`FY${h.slice(-2)}`, take(f.annual, i)); });
  const byFY = (t: Fundamentals["balance"], ...names: string[]) => {
    const m = new Map<string, number>();
    const r_ = row(t, ...names);
    t.headers.forEach((h, i) => { const v = r_?.[i]; if (v != null && /^Mar/i.test(h)) m.set(`FY${h.slice(-2)}`, v); });
    return m;
  };
  return {
    fin, latestQ: fyLabel(f.quarters.headers.at(-1) ?? ""), q, y, fl,
    roe: byFY(f.ratioTable, "ROE %"), borrowings: byFY(f.balance, "Borrowings", "Borrowing"), deposits: byFY(f.balance, "Deposits"),
  };
}

const reported = (b: Book, p: PL) => quartersOf(p).every((l) => (qOrd(l) ?? Infinity) <= (qOrd(b.latestQ) ?? -Infinity));
function sumOf(b: Book, k: keyof QRow, p: PL): Num {
  if (p.k === "FY") { const a = b.y.get(plText(p))?.[k]; if (a != null) return a; }
  let t = 0;
  for (const l of quartersOf(p)) { const v = b.q.get(l)?.[k]; if (v == null) return null; t += v; }
  return t;
}
const pctg = (a: Num, c: Num) => (a == null || c == null || c === 0 ? null : ((a - c) / Math.abs(c)) * 100);
const ratio = (a: Num, c: Num) => (a == null || c == null || c === 0 ? null : (a / c) * 100);
function segVal(b: Book, seg: string, k: "revenue" | "result", p: PL): Num {
  const s = b.fl?.segments.find((x) => x.key === segKey(seg) || x.name.toLowerCase() === seg.toLowerCase());
  if (!s) return null;
  const direct = s[k][plText(p)];
  if (direct != null) return direct;
  let t = 0;
  for (const l of quartersOf(p)) { const v = s[k][l]; if (v == null) return null; t += v; }
  return quartersOf(p).length ? t : null;
}
const asAt = (p: PL) => endPeriod(p);
const bankAt = (b: Book, p: PL) => b.fl?.bank[asAt(p)] ?? null;
const yearAgoAt = (b: Book, p: PL) => b.fl?.bank[asAt(yearBefore(p))] ?? null;

type LineDef = { unit: "%" | "cr"; dir: "higher" | "lower" | "neutral"; fin?: boolean; seg?: boolean; v: (b: Book, p: PL, seg?: string) => Num };
const LINES: Record<string, LineDef> = {
  "revenue": { unit: "cr", dir: "higher", v: (b, p) => sumOf(b, "rev", p) },
  "revenue growth": { unit: "%", dir: "higher", v: (b, p) => pctg(sumOf(b, "rev", p), sumOf(b, "rev", yearBefore(p))) },
  "revenue growth QoQ": { unit: "%", dir: "higher", v: (b, p) => (p.k === "Q" ? pctg(b.q.get(plText(p))?.rev ?? null, b.q.get(prevQuarter(plText(p)))?.rev ?? null) : null) },
  "EBITDA": { unit: "cr", dir: "higher", v: (b, p) => sumOf(b, "op", p) },
  "EBITDA growth": { unit: "%", dir: "higher", v: (b, p) => pctg(sumOf(b, "op", p), sumOf(b, "op", yearBefore(p))) },
  "EBITDA margin": { unit: "%", dir: "higher", v: (b, p) => ratio(sumOf(b, "op", p), sumOf(b, "rev", p)) },
  "EBIT margin": { unit: "%", dir: "higher", v: (b, p) => { const o = sumOf(b, "op", p), d = sumOf(b, "dep", p); return o == null || d == null ? null : ratio(o - d, sumOf(b, "rev", p)); } },
  "PBT": { unit: "cr", dir: "higher", v: (b, p) => sumOf(b, "pbt", p) },
  "PBT margin": { unit: "%", dir: "higher", v: (b, p) => ratio(sumOf(b, "pbt", p), sumOf(b, "rev", p)) },
  "PAT": { unit: "cr", dir: "higher", v: (b, p) => sumOf(b, "pat", p) },
  "PAT growth": { unit: "%", dir: "higher", v: (b, p) => pctg(sumOf(b, "pat", p), sumOf(b, "pat", yearBefore(p))) },
  "PAT margin": { unit: "%", dir: "higher", v: (b, p) => ratio(sumOf(b, "pat", p), sumOf(b, "rev", p)) },
  "tax rate": { unit: "%", dir: "neutral", v: (b, p) => {
    if (p.k === "FY" && b.y.get(plText(p))?.tax != null) return b.y.get(plText(p))!.tax;
    let w = 0, t = 0;
    for (const l of quartersOf(p)) { const r_ = b.q.get(l); if (r_?.tax == null || r_.pbt == null) return null; w += r_.pbt; t += r_.pbt * r_.tax; }
    return w ? t / w : null;
  } },
  "ROE": { unit: "%", dir: "higher", v: (b, p) => (p.k === "FY" ? b.roe.get(plText(p)) ?? null : null) },
  "capex": { unit: "cr", dir: "neutral", v: (b, p) => b.fl?.capex[plText(p)] ?? null },
  "borrowings": { unit: "cr", dir: "lower", v: (b, p) => (p.k === "FY" ? b.borrowings.get(plText(p)) ?? null : null) },
  // lenders
  "interest earned": { unit: "cr", dir: "higher", fin: true, v: (b, p) => sumOf(b, "rev", p) },
  "interest earned growth": { unit: "%", dir: "higher", fin: true, v: (b, p) => pctg(sumOf(b, "rev", p), sumOf(b, "rev", yearBefore(p))) },
  "NII": { unit: "cr", dir: "higher", fin: true, v: (b, p) => { const a = sumOf(b, "rev", p), i = sumOf(b, "int", p); return a == null || i == null ? null : a - i; } },
  "NII growth": { unit: "%", dir: "higher", fin: true, v: (b, p) => {
    const n = (pp: PL) => { const a = sumOf(b, "rev", pp), i = sumOf(b, "int", pp); return a == null || i == null ? null : a - i; };
    return pctg(n(p), n(yearBefore(p)));
  } },
  "GNPA": { unit: "%", dir: "lower", fin: true, v: (b, p) => b.q.get(quartersOf(p).at(-1)!)?.gnpa ?? null },
  "NNPA": { unit: "%", dir: "lower", fin: true, v: (b, p) => b.q.get(quartersOf(p).at(-1)!)?.nnpa ?? null },
  "LDR": { unit: "%", dir: "neutral", fin: true, v: (b, p) => { const x = bankAt(b, p); return x?.advances != null && x.deposits ? (x.advances / x.deposits) * 100 : null; } },
  "advances growth": { unit: "%", dir: "higher", fin: true, v: (b, p) => pctg(bankAt(b, p)?.advances ?? null, yearAgoAt(b, p)?.advances ?? null) },
  "deposits growth": { unit: "%", dir: "higher", fin: true, v: (b, p) => pctg(bankAt(b, p)?.deposits ?? (p.k === "FY" ? b.deposits.get(plText(p)) ?? null : null), yearAgoAt(b, p)?.deposits ?? (p.k === "FY" ? b.deposits.get(`FY${pad2(p.fy - 1)}`) ?? null : null)) },
  "ROA": { unit: "%", dir: "higher", fin: true, v: (b, p) => b.fl?.roa[plText(p)] ?? null },
  // segments (from the results filings)
  "segment revenue": { unit: "cr", dir: "higher", seg: true, v: (b, p, s) => (s ? segVal(b, s, "revenue", p) : null) },
  "segment revenue growth": { unit: "%", dir: "higher", seg: true, v: (b, p, s) => (s ? pctg(segVal(b, s, "revenue", p), segVal(b, s, "revenue", yearBefore(p))) : null) },
  "segment result": { unit: "cr", dir: "higher", seg: true, v: (b, p, s) => (s ? segVal(b, s, "result", p) : null) },
  "segment margin": { unit: "%", dir: "higher", seg: true, v: (b, p, s) => (s ? ratio(segVal(b, s, "result", p), segVal(b, s, "revenue", p)) : null) },
};
// The lines the judge may map a promise to (lenders get the lender lens; segments only when filed).
const COMMON = ["PBT", "PAT", "PAT growth", "tax rate", "ROE"];
const lineNames = (fin: boolean, segs: boolean) =>
  Object.entries(LINES).filter(([k, d]) => (segs || !d.seg) && (fin ? d.fin || d.seg || COMMON.includes(k) : !d.fin)).map(([k]) => k);

const fmtV = (v: number, unit: "%" | "cr" | "pts", growth = false) =>
  unit === "cr" ? `₹${Math.round(v).toLocaleString("en-IN")} cr` : unit === "pts" ? `${v >= 0 ? "+" : ""}${(v * 100).toFixed(0)} bps` : `${growth && v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
const fmtT = (t: Target) => {
  const one = (v: number) => (t.unit === "cr" ? `₹${Math.round(v).toLocaleString("en-IN")} cr` : t.unit === "pts" ? `${v >= 0 ? "+" : ""}${Math.round(v * 100)} bps` : `${+v.toFixed(2)}%`);
  if (t.hi === Infinity) return `≥${one(t.lo)}`;
  if (t.lo === -Infinity) return `≤${one(t.hi)}`;
  if (t.lo === t.hi) return `${t.approx ? "~" : ""}${one(t.lo)}`;
  return t.unit === "%" ? `${+t.lo.toFixed(2)}–${+t.hi.toFixed(2)}%` : `${one(t.lo)}–${one(t.hi)}`;
};

// delivered / partly / missed for one figure against the guided range (direction-aware).
function grade(a: number, t: Target, dir: LineDef["dir"], rounded: boolean): { v: "delivered" | "partly" | "missed"; rel: string } {
  let lo = t.lo, hi = t.hi;
  const eps = rounded ? 0.5 : t.unit === "cr" ? 0 : 0.05;
  if (t.approx && lo === hi && dir === "neutral") { const w = t.unit === "cr" ? 0.05 * Math.abs(lo) : 0.5; lo -= w; hi += w; }
  const ref = Number.isFinite(lo) ? Math.abs(lo) : Math.abs(hi);
  const band = t.unit === "cr" ? 0.1 * ref : t.unit === "pts" ? Math.max(0.25, 0.5 * ref) : Math.max(1, 0.1 * ref);
  const rel = !Number.isFinite(hi) ? (a >= lo - eps ? "at or above the guide" : "below the guide")
    : !Number.isFinite(lo) ? (a <= hi + eps ? "within the cap" : "above the cap")
    : a > hi + eps ? (hi === lo ? "above the guide" : "above the range") : a < lo - eps ? (hi === lo ? "below the guide" : "below the range") : hi === lo ? "at the guide" : "within the range";
  if (dir === "higher") return { v: a >= lo - eps ? "delivered" : a >= lo - band ? "partly" : "missed", rel };
  if (dir === "lower") return { v: a <= hi + eps ? "delivered" : a <= hi + band ? "partly" : "missed", rel };
  return { v: a >= lo - eps && a <= hi + eps ? "delivered" : a >= lo - band && a <= hi + band ? "partly" : "missed", rel };
}

type Measured = { verdict: VerdictKind; soFar: Verdict["soFar"]; text: string; m: NonNullable<Verdict["measured"]> };
function measure(b: Book, line: string, seg: string | null, periods: string[], base: string | null, t: Target): Measured | null {
  const def = LINES[line];
  if (!def || (def.seg && !seg)) return null;
  const pts = t.unit === "pts";
  if (!pts && t.unit !== def.unit) return null; // a crore figure can't grade a margin, nor a % an amount
  if (pts && def.unit !== "%") return null;
  const P = periods.map(pl).filter((x): x is PL => !!x);
  if (!P.length) return null;
  const segName = seg ? b.fl?.segments.find((x) => x.key === segKey(seg))?.name ?? seg : null;
  const lineName = segName ? `${segName} ${line.replace(/^segment /, "")}` : line;
  const rounded = line === "tax rate" || line === "ROE";
  const growth = /growth/.test(line);
  const valueAt = (p: PL): number | null => {
    const v = def.v(b, p, seg ?? undefined);
    if (v == null || !pts) return v;
    const bp = base ? pl(base) : yearBefore(p);
    const v0 = bp ? def.v(b, bp, seg ?? undefined) : null;
    return v0 == null ? null : v - v0;
  };
  const shown = (v: number) => fmtV(v, pts ? "pts" : def.unit, growth);
  const done = P.filter((p) => reported(b, p));
  const meas = { line, segment: segName, periods: P.map(plText), target: fmtT(t), by: "code" as const };
  if (done.length === P.length) {
    const actual: { period: string; value: number }[] = [];
    const grades: ("delivered" | "partly" | "missed")[] = [];
    let rel = "";
    for (const p of P) {
      const v = valueAt(p);
      if (v == null) return null;
      actual.push({ period: plText(p), value: +v.toFixed(2) });
      const g = grade(v, t, def.dir, rounded);
      grades.push(g.v);
      rel = g.rel;
    }
    const verdict: VerdictKind = grades.every((g) => g === "delivered") ? "delivered" : grades.every((g) => g === "missed") ? "missed" : "partly";
    const baseTxt = pts ? ` (change vs ${base ?? "a year earlier"})` : "";
    const text = `${actual.map((x) => `${x.period} ${lineName} ${shown(x.value)}`).join(", ")}${baseTxt} vs ${fmtT(t)} guided — ${P.length > 1 ? `${grades.filter((g) => g === "delivered").length} of ${P.length} periods met` : rel}`;
    return { verdict, soFar: null, text, m: { ...meas, actual } };
  }
  // Not fully reported: the run-rate so far, for a fiscal-year guide whose year is under way.
  const p = P[P.length - 1];
  const latest = pl(b.latestQ)!;
  const n = latest.fy === p.fy ? latest.n : 0;
  if (p.k !== "FY" || !n) return { verdict: "too early", soFar: null, text: `${plText(p)} not reported yet (latest: ${b.latestQ})`, m: { ...meas, actual: [] } };
  const ytd = pl(ytdText(p.fy, n))!;
  if (def.unit === "%" || pts) {
    const v = valueAt(ytd);
    if (v == null) return null;
    const g = grade(v, t, def.dir, rounded);
    const soFar: Verdict["soFar"] = g.v === "delivered" ? (Number.isFinite(t.hi) && t.hi !== t.lo && v > t.hi + 0.05 && def.dir === "higher" ? "ahead" : "on track") : "behind";
    return { verdict: "too early", soFar, text: `So far: ${plText(ytd)} ${lineName} ${shown(v)}${pts ? ` (vs ${base ?? "a year earlier"})` : ""} vs ${fmtT(t)} guided for ${plText(p)} — ${soFar}`, m: { ...meas, actual: [{ period: plText(ytd), value: +v.toFixed(2) }] } };
  }
  // An amount for the year: compare with the share of last year's total booked by this point.
  const v = def.v(b, ytd, seg ?? undefined);
  if (v == null) return null;
  const prevY = def.v(b, yearBefore(p), seg ?? undefined), prevYtd = def.v(b, yearBefore(ytd), seg ?? undefined);
  const share = prevY && prevYtd && prevY > 0 ? prevYtd / prevY : n / 4;
  const need = (Number.isFinite(t.lo) ? t.lo : t.hi) * share;
  const r_ = need ? v / need : 0;
  const soFar: Verdict["soFar"] = def.dir === "neutral" ? (r_ > 1.2 ? "ahead" : r_ >= 0.8 ? "on track" : "behind") : r_ >= 1.03 ? "ahead" : r_ >= 0.97 ? "on track" : "behind";
  const how = prevY && prevYtd ? `${Math.round(share * 100)}% of last year's total was booked by this point` : `${n} of 4 quarters`;
  return { verdict: "too early", soFar, text: `So far: ${plText(ytd)} ${lineName} ${shown(v)} = ${Math.round((v / (Number.isFinite(t.lo) ? t.lo : t.hi)) * 100)}% of the ${fmtT(t)} guide for ${plText(p)} (${how}) — ${soFar}`, m: { ...meas, actual: [{ period: plText(ytd), value: Math.round(v) }] } };
}

// Default line when the judge gave none (company-level, unambiguous wording only).
function defaultLine(p: Extracted, fin: boolean): string | null {
  if (p.scope !== "company") return null;
  const s = `${p.promise} ${p.quote}`.toLowerCase();
  if (/\b(tax rate|etr|effective tax)\b/.test(s)) return "tax rate";
  if (/\bcapex|capital expenditure\b/.test(s)) return "capex";
  if (fin) {
    if (/\bnii\b|net interest income/.test(s) && /grow/.test(s)) return "NII growth";
    if (/\b(ldr|loan[- ]to[- ]deposit|credit[- ]to[- ]deposit)\b/.test(s)) return "LDR";
    if (/\b(roa|return on assets)\b/.test(s)) return "ROA";
    if (/\b(loan|advances?|credit) growth\b/.test(s)) return "advances growth";
    if (/\bdeposits? growth\b/.test(s)) return "deposits growth";
    if (/\bgross npa|gnpa\b/.test(s)) return "GNPA";
    return null;
  }
  if (/\bebit margin\b/.test(s)) return "EBIT margin";
  if (/\b(ebitda|operating) margin\b|\bopm\b/.test(s)) return "EBITDA margin";
  if (/\b(pat|net profit) margin\b/.test(s)) return "PAT margin";
  if (/\b(revenue|sales|top[- ]?line) growth\b|\bgrow (?:revenue|sales)/.test(s) && !/cagr/.test(s)) return "revenue growth";
  return null;
}

// Fiscal periods a horizon covers, resolved against the call it came from. Relative phrases:
// "this year" = the fiscal year the call falls in; "next year" = the year after the one the call
// DISCUSSED (on a May call about Q4 FY26 that is FY27); "next quarter" = the one after that call's quarter.
function periodsFor(h: string, call: string, callQuarter: string | null, latestQ: string): string[] | null {
  const out: string[] = [];
  const s = h ?? "";
  for (const m of s.matchAll(/\b(Q[1-4]|H[12]|9M)\s*FY\s*'?(\d{4}|\d{2})\b/gi)) out.push(`${m[1].toUpperCase()} FY${pad2(fy2(m[2]))}`);
  for (const m of s.matchAll(/(?<![QH][1-4]\s?|9M\s?)\bFY\s*'?(\d{4}|\d{2})(?:\s*[-–/]\s*'?(\d{2}))?\b/gi)) {
    const a = fy2(m[1]);
    if (m[2] && m[1].length === 4 && Number(m[2]) === (a + 1) % 100) out.push(`FY${m[2]}`); // "FY 2025-26" is FY26
    else if (m[2]) { const b = fy2(m[2]); for (let y = a; y <= b && y - a < 4; y++) out.push(`FY${pad2(y)}`); }
    else out.push(`FY${pad2(a)}`);
  }
  for (const m of s.matchAll(/\b(?:March|Mar)\s*(20\d{2})\b/gi)) out.push(`FY${pad2(Number(m[1]))}`);
  const lq = pl(latestQ);
  if (out.length === 1 && /onwards|from|beyond|and after/i.test(s) && /^FY/.test(out[0]) && lq) {
    const start = pl(out[0])!.fy, lastFull = lq.n === 4 ? lq.fy : lq.fy - 1;
    for (let y = start + 1; y <= lastFull && y - start < 3; y++) out.push(`FY${pad2(y)}`);
  }
  if (!out.length) {
    const cfy = fyOfMonth(call);
    const dq = callQuarter ? pl(fyLabel(callQuarter)) : null;
    if (/\bnext quarter\b/i.test(s) && callQuarter) out.push(nextQuarter(fyLabel(callQuarter)));
    else if (/\b(?:this|current) quarter\b/i.test(s) && callQuarter) out.push(nextQuarter(fyLabel(callQuarter)));
    else if (/\b(?:this|current) (?:fiscal|year|financial year)\b|\bfull[- ]year\b/i.test(s) && cfy) out.push(`FY${cfy}`);
    else if (/\bnext (?:fiscal|year|financial year)\b/i.test(s)) { const y = dq ? dq.fy + 1 : cfy ? Number(cfy) + 1 : null; if (y) out.push(`FY${pad2(y)}`); }
  }
  return out.length ? [...new Set(out)] : null;
}

// Last month (y*12+m) a horizon covers; null if vague ("over time", "3-5 years" counted from the call).
function horizonEnd(h: string, callMonth: string, callQuarter: string | null, latestQ: string): number | null {
  const ps = periodsFor(h, callMonth, callQuarter, latestQ);
  if (ps?.length) return Math.max(...ps.map((x) => idx(endPeriod(pl(x)!)) ?? 0));
  const cfy = fyOfMonth(callMonth);
  const yrs = h.match(/(\d+)\s*(?:-|to)?\s*(\d+)?\s*years?/i);
  if (cfy && yrs) return idx(`Mar ${2000 + +cfy + Number(yrs[2] ?? yrs[1])}`);
  return null;
}

const EXTRACT_SYS =
  "You extract forward-looking guidance that company MANAGEMENT gave on an earnings call. The numbered sentences were spoken by management (analyst questions already removed). Use only these sentences; never add numbers, context or knowledge from outside them. Skip results already reported (past tense), descriptions of the current state, vague hopes without a number, forecasts about the industry or the economy, and anything that is an analyst's estimate.";

const JUDGE_SYS =
  "You are a sceptical buy-side analyst checking whether management delivered on its own guidance. Use ONLY the reported figures and management statements provided (from the company's filings and calls). Never use outside knowledge, news, estimates or memory of the company. Indian fiscal year: FY27 = Apr 2026–Mar 2027; Q1 = Jun quarter, Q2 = Sep, Q3 = Dec, Q4 = Mar. Never do arithmetic: quote figures as given. Be concise and cite figures with their periods.";

const num0 = (x: number | null | undefined) => (x == null ? "—" : Math.round(x).toLocaleString("en-IN"));
const sgn = (x: number | null) => (x == null ? "—" : `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`);
const pc1 = (x: number | null) => (x == null ? "—" : `${x.toFixed(1)}%`);

// The reported numbers the judge may use: quarterly P&L with growth and margins computed here
// (the model never does the arithmetic), fiscal-year-to-date, the annual trajectory, and the
// filed segment table / capex / lender balance sheet. Lenders get NII / asset quality instead of
// EBITDA ("Financing profit" is not NIM or PPOP).
function numbersFor(r: Research, b: Book) {
  const fin = b.fin;
  const Qs = [...b.q.keys()].slice(-9);
  const L = (name: string, p: string) => { const x = pl(p); return x ? LINES[name].v(b, x) : null; };
  const lines: string[] = [];
  lines.push(fin
    ? `Quarter | Interest earned | YoY | NII | NII YoY | PBT | Tax rate | PAT | PAT YoY | GNPA | NNPA`
    : `Quarter | Revenue | YoY | QoQ | EBITDA | EBITDA margin | EBIT margin | PBT | Tax rate | PAT | PAT YoY`);
  for (const ql of Qs) {
    const x = b.q.get(ql)!;
    const per = endPeriod(pl(ql)!);
    lines.push((fin
      ? [`${per} (${ql})`, num0(x.rev), sgn(L("interest earned growth", ql)), num0(L("NII", ql)), sgn(L("NII growth", ql)), num0(x.pbt), x.tax == null ? "—" : `${x.tax}%`, num0(x.pat), sgn(L("PAT growth", ql)), x.gnpa == null ? "—" : `${x.gnpa}%`, x.nnpa == null ? "—" : `${x.nnpa}%`]
      : [`${per} (${ql})`, num0(x.rev), sgn(L("revenue growth", ql)), sgn(L("revenue growth QoQ", ql)), num0(x.op), pc1(L("EBITDA margin", ql)), pc1(L("EBIT margin", ql)), num0(x.pbt), x.tax == null ? "—" : `${x.tax}%`, num0(x.pat), sgn(L("PAT growth", ql))]
    ).join(" | "));
  }
  // Fiscal year to date vs the same months last year.
  const lq = pl(b.latestQ);
  let ytd = "";
  if (lq && lq.n >= 2) {
    const yl = ytdText(lq.fy, lq.n), py = plText(yearBefore(pl(yl)!));
    const part = (label: string, k: keyof QRow) => { const a = sumOf(b, k, pl(yl)!), c = sumOf(b, k, pl(py)!); return `${label} ${num0(a)} vs ${num0(c)} (${sgn(pctg(a, c))})`; };
    ytd = `\nFiscal year to date (${yl} vs ${py}): ${[part(fin ? "interest earned" : "revenue", "rev"), ...(fin ? [] : [part("EBITDA", "op")]), part("PAT", "pat")].join("; ")}` +
      (fin ? "" : `; EBITDA margin ${pc1(L("EBITDA margin", yl))} vs ${pc1(L("EBITDA margin", py))}; EBIT margin ${pc1(L("EBIT margin", yl))} vs ${pc1(L("EBIT margin", py))}`) + ".";
  }
  const fys = [...b.y.keys()].slice(-5);
  const annual = fys.map((y) => {
    const x = b.y.get(y)!;
    return fin
      ? `${y}: interest earned ${num0(x.rev)} (${sgn(L("interest earned growth", y))}), NII ${num0(L("NII", y))} (${sgn(L("NII growth", y))}), PBT ${num0(x.pbt)}, tax rate ${x.tax ?? "—"}%, PAT ${num0(x.pat)} (${sgn(L("PAT growth", y))})${b.roe.get(y) != null ? `, ROE ${b.roe.get(y)}%` : ""}`
      : `${y}: revenue ${num0(x.rev)} (${sgn(L("revenue growth", y))}), EBITDA ${num0(x.op)}, EBITDA margin ${pc1(L("EBITDA margin", y))}, EBIT margin ${pc1(L("EBIT margin", y))}, PBT ${num0(x.pbt)}, tax rate ${x.tax ?? "—"}%, PAT ${num0(x.pat)} (${sgn(L("PAT growth", y))})${b.roe.get(y) != null ? `, ROE ${b.roe.get(y)}%` : ""}`;
  }).join("\n");
  const bal = fin
    ? (b.deposits.size ? `\nDeposits by FY-end: ${[...b.deposits].slice(-5).map(([k, v]) => `${k} ${num0(v)}`).join(", ")}` : "")
    : (b.borrowings.size ? `\nBorrowings by FY-end: ${[...b.borrowings].slice(-5).map(([k, v]) => `${k} ${num0(v)}`).join(", ")}; latest debt/equity ${r.balance.de?.toFixed(2) ?? "—"}` : "");
  const cash = !fin && r.cash.rows.length ? `\nCash from operations by FY: ${r.cash.rows.map((c) => `FY${c.year.slice(-2)} ${num0(c.cfo)}`).join(", ")}` : "";

  // (C) the company's own results filings.
  let filedTxt = "";
  const fl = b.fl;
  if (fl) {
    const parts: string[] = [];
    if (fl.segments.length) {
      const labels = [...new Set(fl.segments.flatMap((s) => Object.keys(s.revenue)))]
        .filter((l) => pl(l)).sort((a, c) => { const A_ = pl(a)!, C_ = pl(c)!; const rank = (x: PL) => (x.k === "Q" ? 0 : x.k === "FY" ? 2 : 1); return rank(A_) - rank(C_) || A_.fy - C_.fy || A_.n - C_.n; });
      parts.push(`Segment results (${fl.basis ?? "as filed"}, ₹ crore; result = ${fl.resultLabel ?? "segment result as filed"}; margin and YoY computed here). Columns: ${labels.join(", ")}`);
      for (const s of fl.segments) {
        const cell = (l: string) => {
          const p = pl(l)!;
          const rev = s.revenue[l], res = s.result[l];
          if (rev == null) return "—";
          const g = pctg(rev, segVal(b, s.name, "revenue", yearBefore(p)));
          return `${num0(rev)}${g != null ? ` (${sgn(g)} YoY)` : ""}${res != null ? ` / result ${num0(res)}${rev > 0 ? ` (${pc1((res / rev) * 100)})` : ""}` : ""}`;
        };
        parts.push(`  ${s.name}: ${labels.map((l) => `${l} ${cell(l)}`).join("; ")}`);
      }
    } else if (fl.note) parts.push(`Segments: the filings state the company has a ${fl.note} — no segment split is reported.`);
    const cx = Object.entries(fl.capex);
    if (cx.length) parts.push(`Capex (purchase of property, plant & equipment, cash-flow statement): ${cx.map(([k, v]) => `${k} ${num0(v)}`).join(", ")}`);
    const bk = Object.entries(fl.bank).filter(([, v]) => v.advances != null || v.deposits != null).sort((a, c) => (idx(a[0]) ?? 0) - (idx(c[0]) ?? 0));
    if (bk.length) parts.push(`Balance sheet as at (advances / deposits, ₹ crore; LDR computed here): ${bk.map(([k, v]) => `${k} (${fyLabel(k)}) ${num0(v.advances)} / ${num0(v.deposits)}${v.advances != null && v.deposits ? ` — LDR ${pc1((v.advances / v.deposits) * 100)}` : ""}${(() => { const y = fl.bank[`${k.split(" ")[0]} ${Number(k.split(" ")[1]) - 1}`]; return y?.advances && v.advances ? `, advances ${sgn(pctg(v.advances, y.advances))} YoY` : ""; })()}`).join("; ")}`);
    const ro = Object.entries(fl.roa);
    if (ro.length) parts.push(`Return on assets (annualised, as filed): ${ro.map(([k, v]) => `${k} ${v.toFixed(2)}%`).join(", ")}`);
    if (parts.length) filedTxt = `\n\n(C) From the company's results filings on NSE:\n${parts.join("\n")}`;
  }
  return { latest: endPeriod(pl(b.latestQ) ?? { k: "Q", n: 4, fy: 0 }), text: `${lines.join("\n")}${ytd}\n\nAnnual (FY ends March):\n${annual}${bal}${cash}${filedTxt}` };
}

// Every figure the judge quotes must appear in what it was given (rounding allowed) — a figure
// from anywhere else is outside knowledge, and that judgement is withheld.
function ungrounded(text: string, corpus: string): string[] {
  const pool_ = [...corpus.replace(/(\d),(?=\d)/g, "$1").matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
  const bad: string[] = [];
  for (const m of text.replace(/(\d),(?=\d)/g, "$1").matchAll(/\d+(?:\.\d+)?/g)) {
    const x = Number(m[0]);
    if (!Number.isFinite(x) || (Number.isInteger(x) && x <= 31) || (x >= 2019 && x <= 2035 && Number.isInteger(x))) continue;
    if (!pool_.some((c) => Math.abs(c - x) <= Math.max(0.051, 0.005 * Math.abs(x)) || Math.abs(c / 100 - x) < 0.0051)) bad.push(m[0]);
  }
  return bad;
}

const normQ = (s: string) => s.toLowerCase().replace(/[^a-z0-9%.]+/g, " ").trim();
const RANK: Record<string, number> = { missed: 0, partly: 1, delivered: 2, "too early": 3, unverifiable: 4 };

export type Narrative = Awaited<ReturnType<typeof computeNarrative>>;

async function computeNarrative(r: Research, budgetMs: number) {
  const t0 = Date.now();
  const left = () => budgetMs - (Date.now() - t0);
  const timings: Record<string, number> = {};
  const candidates = r.concalls.filter((c) => c.transcript).slice(0, 6);
  // The results filings are read in parallel with the transcripts (they feed only the judge).
  let filedDone = false;
  const filedP = filed(r).catch(() => null).finally(() => { filedDone = true; });
  const fP = fundamentals(r.symbol);

  let deadLinks = 0;
  // 1-2. Fetch, parse, filter — all transcripts concurrently.
  const parsed = await pool(candidates, 4, async (c) => {
    const ts = Date.now();
    let text: string;
    try {
      text = await Promise.race([pdfText(c.transcript!, 30), new Promise<string>((_, rej) => setTimeout(() => rej(new Error("pdf timeout")), Math.min(20_000, Math.max(1_000, left() - 25_000))))]);
    } catch (e) {
      // A dead or non-PDF link will never be read (permanent); a slow download may be next time.
      if (/pdf 4\d\d|not a pdf|too large/i.test((e as Error).message)) deadLinks++;
      throw e;
    }
    const p = parseTranscript(text, c.month);
    const sents = guidanceSentences(p.turns);
    const facts = actualSentences(p.turns);
    const mgmtChars = p.turns.filter((t) => t.role === "mgmt").reduce((a, t) => a + t.text.length, 0);
    return { ...c, url: c.transcript!, ...p, sents, facts, textChars: text.length, mgmtChars, ms: Date.now() - ts };
  });
  timings.transcripts = Date.now() - t0;
  // Prefer quarterly earnings calls (one per quarter, most recent first); fall back to whatever else.
  const ok = parsed.filter(Boolean) as NonNullable<(typeof parsed)[number]>[];
  const seen = new Set<string>();
  const calls = ok.filter((c) => (c.earnings && c.quarter && !seen.has(c.quarter) ? (seen.add(c.quarter), true) : false)).slice(0, 4);
  for (const c of ok) if (calls.length < 4 && !calls.includes(c)) calls.push(c);

  // 3. Fast tier: one extraction per call, in parallel, each capped so the judge keeps its time.
  const t1 = Date.now();
  const dropped: { call: string; quote: string; why: string }[] = [];
  const extracted = await Promise.all(calls.map(async (c) => {
    if (!c.sents.length) return { c, items: [] as Extracted[], llm: null };
    const cfy = fyOfMonth(c.month);
    const dq = c.quarter ? pl(fyLabel(c.quarter)) : null;
    const prompt =
      `Company: ${r.name}. Call held ${c.month}${cfy ? ` (in FY${cfy})` : ""}${c.quarter ? `, discussing the quarter ended ${c.quarter} (${fyLabel(c.quarter)})` : ""}. Indian FY runs Apr–Mar (FY27 = Apr 2026–Mar 2027).\n` +
      `Write horizon as fiscal periods: "this year"/"current fiscal" = FY${cfy ?? "of the call date"}; "next year"/"next fiscal" = FY${dq ? pad2(dq.fy + 1) : cfy ? pad2(Number(cfy) + 1) : "after that"}${dq?.n === 4 ? " (this call reviews the year just closed, so 'next year' is the year now under way)" : ""}; "next quarter"/"this quarter" = ${c.quarter ? nextQuarter(fyLabel(c.quarter)) : "the quarter after the one discussed"}.\n` +
      `Return JSON {"items":[{"n":<sentence number>,"metric":"revenue|growth|margin|profit|volume|capex|debt|working capital|asset quality|tax|other","subject":"what the number is for: 'whole company' or the named business/segment/product/subsidiary it refers to","scope":"company|segment","promise":"<=12 words naming the measured quantity and the number, e.g. 'EBITDA margin 16-17%' or 'Loan-to-deposit ratio 85-90%'","horizon":"e.g. FY27, Q3 FY27, H2 FY27, 2-3 years","quote":"exact words copied from that sentence, <=20 words, including the number"}]}.\n` +
      `scope is "company" only if the sentence is clearly about the whole company (overall, consolidated, total, company-level); a business line, product, JV, subsidiary or unclear subject is "segment".\n` +
      `Only the company's own future numbers: skip what is already happening ("is making", "are up", "currently"), the industry/system/economy, and sentences that don't make clear what quantity the number measures. At most 4 items. Prefer company-level, numeric guidance that reported financials can check (revenue/growth, EBITDA or EBIT margin, profit, tax rate, capex, debt; for lenders loan growth, LDR, ROA, asset quality). Return {"items":[]} if there is none.\n\n` +
      c.sents.map((s) => `${s.n}. [${s.speaker}${s.title ? `, ${s.title.slice(0, 50)}` : ""}] ${s.text}`).join("\n");
    type Raw = Partial<Promise_> & { n?: number; scope?: string; subject?: string };
    const res = await llm<{ items?: Raw[] } | Raw[]>(
      "fast", EXTRACT_SYS, prompt, 1200, { timeoutMs: Math.max(3_000, Math.min(25_000, left() - 20_000)) });
    const arr = Array.isArray(res.value) ? res.value : res.value?.items ?? [];
    const items: Extracted[] = [];
    for (const x of arr.filter((y) => y && y.promise).slice(0, 4)) {
      const s = c.sents.find((y) => y.n === Number(x.n));
      // Grounding check: the quote must be verbatim from the sentence; otherwise use the sentence itself.
      const quoteOk = s && x.quote && normQ(s.text).includes(normQ(x.quote));
      const quote = quoteOk ? x.quote! : s ? (s.text.length > 200 ? s.text.slice(0, 197) + "…" : s.text) : "";
      if (!quote || !s) continue;
      const it: Extracted = {
        call: c.month, metric: x.metric ?? "other", promise: x.promise!, horizon: x.horizon ?? "", quote,
        speaker: s.speaker ?? "", quarter: c.quarter, scope: x.scope === "company" ? "company" : "segment", subject: x.subject ?? "",
        ...(s.title && segmentTitle(s.title, r.name) ? { scope: "segment", subject: x.subject && !/whole|company/i.test(x.subject) ? x.subject : s.title } : {}),
      };
      const why = notGuidance(it, s.text);
      if (why) { dropped.push({ call: c.month, quote, why }); continue; }
      items.push(it);
    }
    return { c, items, llm: res };
  }));
  timings.extract = Date.now() - t1;

  // Same guidance on later calls: keep the earliest (most testable) and note it. Same metric and
  // horizon restated with DIFFERENT numbers is a revision: judged against the original, and shown.
  const nums_ = (s: string) => (s.replace(/\b(?:FY|Q[1-4]|H[12])\s*'?\d{2,4}\b|\b20\d{2}\b/gi, "").match(/\d+(?:\.\d+)?/g) ?? []).join(",");
  const words = (s: string) => new Set(s.toLowerCase().replace(/[\d.,%₹-]+/g, " ").split(/[^a-z]+/).filter((w) => w.length > 2 && !/^(the|and|for|with|range|around|about|between|of|to|in)$/.test(w)));
  const similar = (a: string, b: string) => { const A_ = words(a), B_ = words(b); const inter = [...A_].filter((w) => B_.has(w)).length; return inter / Math.max(1, Math.min(A_.size, B_.size)) >= 0.5; };
  const byKey = new Map<string, Extracted>();
  for (const e of extracted.slice().reverse()) {
    for (const it of e.items) {
      const k = `${it.metric}|${nums_(it.promise)}`;
      const prev = byKey.get(k);
      if (prev) { (prev.reiterated ??= []).push(it.call); continue; }
      const hz = (x: Extracted) => (periodsFor(x.horizon, x.call, x.quarter, "Q4 FY99") ?? [x.horizon.toLowerCase()]).join(",");
      const rev = [...byKey.values()].find((p) => p.metric === it.metric && hz(p) === hz(it) && segKey(p.subject) === segKey(it.subject) && similar(p.promise, it.promise));
      if (rev) { (rev.revised ??= []).push({ call: it.call, promise: it.promise }); continue; }
      byKey.set(k, it);
    }
  }
  // Scale check (deterministic): an absolute revenue figure far below the company's own reported
  // run-rate is a segment number, whatever the model labelled it — never score it against totals.
  const fyRev = r.trajectory.sales.at(-1) ?? null, qRev = r.quarters.revenue.at(-1) ?? null;
  for (const p of byKey.values()) {
    if (p.scope !== "company" || !/revenue|growth|sales/i.test(p.metric)) continue;
    const amt = croreAmount(`${p.promise} ${p.quote}`);
    const scale = /\bQ[1-4]\b|quarter/i.test(p.horizon) ? qRev : fyRev;
    if (amt != null && scale && amt < 0.4 * scale) {
      p.scope = "segment";
      p.subject = p.subject && !/whole|company|overall|total/i.test(p.subject) ? p.subject : `an unnamed business line (₹${amt.toLocaleString("en-IN")} cr is far below company scale)`;
    }
  }
  const all = [...byKey.values()];
  const MEASURABLE = /revenue|growth|sales|margin|profit|ebitda|pat|capex|debt|working|tax|asset quality|npa/i;
  const offTable = (p: Extracted) => p.scope !== "company" || !MEASURABLE.test(`${p.metric} ${p.promise}`);
  const promises = [...all.filter((p) => !offTable(p)), ...all.filter(offTable)].slice(0, 10).map((p, i) => ({ ...p, id: i + 1, offTable: offTable(p) }));
  const mIdx = (m: string) => idx(m) ?? 0;
  const oldest = promises.length ? Math.min(...promises.map((p) => mIdx(p.call))) : 0;
  let evChars = 0;
  const evidence = calls
    .filter((c) => mIdx(c.month) > oldest && c.facts.length)
    .sort((a, b) => mIdx(a.month) - mIdx(b.month))
    .map((c) => `Call ${c.month}${c.quarter ? ` (on ${fyLabel(c.quarter)} results)` : ""} — management said:\n${c.facts.map((s, i) => `  ${i + 1}) ${s}`).join("\n")}`)
    .filter((b) => (evChars += b.length) <= 7000)
    .join("\n");

  // 4. Smart tier: one judgement (and line mapping) over everything.
  let verdicts: Verdict[] | null = null;
  let bullBear: { bull: string[]; bear: string[] } | null = null;
  let judge: Awaited<ReturnType<typeof llm>> | null = null;
  let asOf: string | null = null;
  const t2 = Date.now();
  // The filings get whatever time the judge doesn't need; if they aren't in, the run is partial.
  const fl = await within(filedP, Math.max(0, left() - 22_000));
  timings.filings = Date.now() - t0;
  const f = await fP;
  const book = makeBook(r, f, fl);
  const segNames = fl?.segments.filter((s) => !UNALLOC.test(s.name)).map((s) => s.name) ?? [];
  if (promises.length) {
    const nums = numbersFor(r, book);
    asOf = nums.latest;
    const latestIdx = idx(nums.latest);
    const lineList = lineNames(book.fin, segNames.length > 0);
    const prompt =
      `${r.name} — reported figures, ${r.basis}, INR crore. Latest reported quarter: ${nums.latest} (${fyLabel(nums.latest)}). Nothing after it has been reported.\n${nums.text}\n\n` +
      `${evidence ? `(B) What management itself reported on later calls (primary source — their own words):\n${evidence}\n\n` : ""}` +
      `Guidance management gave on the last ${calls.length} earnings calls (each call discusses the quarter named and guides forward from it):\n` +
      promises.map((p) => `#${p.id} [call ${p.call}${fyOfMonth(p.call) ? ` (in FY${fyOfMonth(p.call)})` : ""}${p.quarter ? `, on ${fyLabel(p.quarter)} results` : ""}] [${p.offTable ? `segment/KPI: ${p.subject || "not company-wide"}` : "company-level"}] ${p.metric} · horizon "${p.horizon}" · ${p.promise} — "${p.quote}"`).join("\n") +
      `\n\nFor each item, first MAP it: "line" = the one reported line that measures exactly what was guided, from: ${lineList.map((x) => `"${x}"`).join(", ")}, or "none" (volumes, store adds, order book, NIM, credit cost, USD revenue, a sub-business not in (C), an impact estimate). ` +
      `Margin words: "EBITDA/operating margin" → "EBITDA margin"; "EBIT margin" → "EBIT margin" (a segment's EBIT margin → "segment margin"); "net/PAT margin" → "PAT margin". Loan/credit growth → "advances growth". ${segNames.length ? `"segment" = the exact segment name from (C) (${segNames.map((s) => `"${s}"`).join(", ")}) for segment lines, else null. ` : ""}` +
      `"periods" = the fiscal period(s) the promise is about, e.g. ["FY26"], ["Q3 FY26"], ["H2 FY26"], ["FY25","FY26"] for "from FY25 onwards". "base" = for a change guided in bps/points ("expand margin 40-50 bps"), the period it is measured from, else null.\n` +
      `Then judge: the code computes the actual figure for every mapped item and grades it, so for mapped items your verdict is a cross-check. Verdict "delivered", "missed" or "partly" ONLY if every period in the horizon has been reported; else "too early" — and say what the run-rate shows so far. Items mapped to "none": judge ONLY from (B) — a statement on a call LATER than the promise, about the same business/metric — citing it as "per <month> call"; if (B) has nothing on it, "unverifiable". You have no exchange rates: never convert USD or other currencies. ${r.isFinancial ? "This is a lender: NIM, credit cost and cost-to-income are not in the figures — \"none\" unless (B) states them. " : ""}Quote figures exactly as given; never compute. If what a number refers to is unclear, "unverifiable" — never guess which line it maps to.\n` +
      `Return JSON {"verdicts":[{"id":<#>,"line":"<line or none>","segment":null,"periods":["FY26"],"base":null,"delivered":"<=25 words: what the reported numbers show, with figures and periods","verdict":"delivered|missed|partly|too early|unverifiable","note":"<=12 words"}],"bull":["<=3 points, <=18 words each, about the last 4 quarters and the guidance track record, grounded only in the figures above"],"bear":["<=3, same rules"]}`;
    type JV = { id: number; line?: string; segment?: string | null; periods?: string[]; base?: string | null; delivered?: string; verdict?: string; note?: string };
    // A fallback model sometimes answers with a bare array, or an object without "verdicts": the
    // first is accepted, the second is refused (and so never cached) and the next model is asked.
    const usable = (v: unknown) => (Array.isArray(v) ? v.length > 0 : Array.isArray((v as { verdicts?: unknown } | null)?.verdicts) && (v as { verdicts: unknown[] }).verdicts.length > 0);
    judge = await llm<{ verdicts?: JV[]; bull?: string[]; bear?: string[] }>(
      "smart", JUDGE_SYS, prompt, 3000, { timeoutMs: Math.max(2_000, Math.min(40_000, left() - 1_000)), accept: usable });
    const rawOut = judge.value as unknown;
    const out = (Array.isArray(rawOut) ? { verdicts: rawOut as JV[] } : rawOut) as { verdicts?: JV[]; bull?: string[]; bear?: string[] } | null;
    if (out?.verdicts) {
      verdicts = promises.map((p): Verdict => {
        const v = out.verdicts!.find((x) => Number(x.id) === p.id);
        const judged = (v?.verdict && v.verdict in RANK ? v.verdict : "unverifiable") as VerdictKind;
        const { id: _id, offTable: _off, ...rest } = p;
        let said = (v?.delivered ?? "").replace(/^(delivered|missed|partly|too early|unverifiable)\s*([.:,—-]\s*|$)/i, "") || v?.note || "Not judged";
        let note = v?.note ?? "";
        // Which line and period measure it: explicit fiscal labels in the horizon win over the model.
        let line = v?.line && v.line in LINES ? v.line : v?.line && /^none$/i.test(v.line) ? null : defaultLine(p, book.fin);
        let seg = line && LINES[line].seg ? (segNames.find((s) => segKey(s) === segKey(v?.segment ?? "")) ?? null) : null;
        // A segment promise the model left unmeasured, but the filings DO report that segment.
        if (!line && p.scope === "segment") {
          const hit = segNames.find((s) => { const a = segKey(s), b_ = segKey(p.subject); return !!a && !!b_ && (a === b_ || b_.split(" ").includes(a) || a.split(" ").includes(b_)); });
          if (hit && /margin/i.test(`${p.metric} ${p.promise}`)) { line = "segment margin"; seg = hit; }
          else if (hit && /growth|grow/i.test(`${p.metric} ${p.promise}`)) { line = "segment revenue growth"; seg = hit; }
          else if (hit && /revenue|sales/i.test(`${p.metric} ${p.promise}`)) { line = "segment revenue"; seg = hit; }
        }
        if (line && LINES[line].seg && !seg) line = null;
        const periods = periodsFor(p.horizon, p.call, p.quarter, book.latestQ) ?? (v?.periods ?? []).filter((x) => pl(x)).map((x) => plText(pl(x)!));
        const target = parseTarget(p.promise, p.quote);
        const m = line && target && target !== "usd" && periods.length ? measure(book, line, seg, periods, v?.base && pl(v.base) ? plText(pl(v.base)!) : null, target) : null;
        if (m) {
          const agree = m.verdict === judged || (m.verdict === "too early" && judged === "too early");
          const kind = m.verdict;
          note = m.soFar ? `${m.soFar[0].toUpperCase()}${m.soFar.slice(1)} so far` : agree ? note || "Checked in code" : "Checked in code";
          return { ...rest, delivered: m.text, verdict: kind, note, soFar: m.soFar, measured: m.m, ...(agree ? {} : { modelVerdict: judged }) };
        }
        // Not measurable from the figures: the model's call, held to two rules in code.
        let kind = judged;
        const bad = ungrounded(said, prompt);
        if (bad.length && kind !== "unverifiable" && kind !== "too early") {
          return { ...rest, delivered: `Withheld: the judgement cited figures not in the filings or calls (${bad.slice(0, 3).join(", ")})`, verdict: "unverifiable", note: "Ungrounded figure", modelVerdict: judged, measured: null };
        }
        if (target === "usd" && (kind === "delivered" || kind === "missed" || kind === "partly") && !/per \w+ \d{4} call/i.test(said)) {
          kind = "unverifiable"; note = "USD target: no USD figures in the filings";
        }
        if (fl?.note && p.scope === "segment" && kind === "unverifiable" && /^single segment/.test(fl.note)) {
          // A subject that is really the speaker's job title ("MD – … & CEO – Royal Enfield") reads as noise.
          const what = !p.subject || /director|officer|\bceo\b|\bcfo\b|\bhead\b|president/i.test(p.subject) || p.subject.length > 48 ? "this business line" : `"${p.subject}"`;
          said = `The filings report a ${fl.note} — ${what} is not broken out, and later calls don't state it.`;
        }
        // Hard rule, enforced in code: no final verdict before the horizon has been reported.
        const end = horizonEnd(p.horizon, p.call, p.quarter, book.latestQ);
        if (end != null && latestIdx != null && end > latestIdx && (kind === "delivered" || kind === "missed" || kind === "partly")) {
          const so = kind === "delivered" ? "ahead" : kind === "missed" ? "behind" : null;
          return { ...rest, delivered: said, verdict: "too early", note: so ? `${so === "ahead" ? "Ahead" : "Behind"} so far${v?.note ? ` · ${v.note}` : ""}` : `Mixed so far${v?.note ? ` · ${v.note}` : ""}`, soFar: so, measured: null, modelVerdict: judged };
        }
        return { ...rest, delivered: said, verdict: kind, note, measured: null };
      }).sort((a, b) => RANK[a.verdict] - RANK[b.verdict]).slice(0, 8);
      // Revisions in the note (the guide was restated with different numbers on a later call).
      for (const v of verdicts) if (v.revised?.length) v.note = `${v.note ? `${v.note} · ` : ""}Restated as "${v.revised.at(-1)!.promise}" (${v.revised.at(-1)!.call})`;
      bullBear = { bull: (out.bull ?? []).slice(0, 3), bear: (out.bear ?? []).slice(0, 3) };
      // Bull/bear points are held to the same grounding rule.
      bullBear.bull = bullBear.bull.filter((s) => !ungrounded(s, prompt).length);
      bullBear.bear = bullBear.bear.filter((s) => !ungrounded(s, prompt).length);
    }
  }
  timings.judge = Date.now() - t2;
  timings.total = Date.now() - t0;

  const fastLLM = extracted.map((e) => e.llm).filter(Boolean) as NonNullable<(typeof extracted)[number]["llm"]>[];
  // A transcript that could not be downloaded in time is a call not read: say so, and don't cache.
  const unread = ok.length < Math.min(4, candidates.length - deadLinks);
  const timedOut = unread || fastLLM.some((x) => x.error) || (promises.length > 0 && !verdicts) || (!filedDone && candidates.length > 0) || !!fl?.partial;
  return {
    symbol: r.symbol,
    model: modelInfo(),
    asOf,
    generatedAt: new Date().toISOString(),
    partial: timedOut,
    calls: calls.map((c, i) => ({
      call: c.month, url: c.url, quarter: c.quarter, found: extracted[i].items.length,
      sentences: c.sents.slice(0, 4).map((s) => s.text), management: c.management.slice(0, 6),
    })),
    verdicts,
    promises: verdicts ? undefined : promises.map(({ id: _id, offTable: _o, ...p }) => p), // un-judged guidance if the judge didn't finish
    bullBear,
    // What the filings added (segments / capex / lender balance sheet), and what the rules dropped.
    filings: fl ? { basis: fl.basis, note: fl.note, segments: fl.segments.map((s) => s.name), capexPeriods: Object.keys(fl.capex), sources: fl.sources } : null,
    dropped: dropped.slice(0, 12),
    // Efficiency readout: what was read, what was sent to which model, how long each stage took.
    stats: {
      ms: timings,
      transcripts: calls.map((c) => ({ call: c.month, pdfChars: c.textChars, managementChars: c.mgmtChars, sentencesKept: c.sents.length, charsToFast: c.sents.reduce((a, s) => a + s.text.length, 0) })),
      fast: fastLLM.map((x) => ({ model: x.model, promptChars: x.promptChars, ms: x.ms, cached: x.cached, error: x.error })),
      filings: fl?.stats ?? [],
      smart: judge ? { model: judge.model, promptChars: judge.promptChars, ms: judge.ms, cached: judge.cached, error: judge.error } : null,
    },
  };
}

const PIPELINE = "pvd-16"; // bump when prompts or rules change, so cached verdicts are recomputed

// Whole-result cache keyed by the exact transcripts and the latest reported quarter: a new call or
// new results invalidate it automatically. Partial results are never cached.
export async function narrative(symbol: string, budgetMs = 50_000) {
  const t0 = Date.now();
  const r = await research(symbol);
  const key = `narr:${PIPELINE}:${r.symbol}:${r.basis}:${r.quarters.periods.at(-1)}:${r.concalls.map((c) => c.transcript ?? "").join(",")}:${JSON.stringify(modelInfo())}`;
  let hit = true;
  const out = await cached(key, 24 * HOUR, () => { hit = false; return computeNarrative(r, budgetMs - (Date.now() - t0)); }, (v) => !v.partial && v.calls.length > 0, { immutable: true });
  return { ...out, cached: hit, ms: Date.now() - t0 };
}

/** The management cast list printed on the latest earnings-call transcript (names + titles). */
export async function castList(r: Research): Promise<{ call: string; url: string; cast: { name: string; title: string }[] } | null> {
  for (const c of r.concalls.filter((x) => x.transcript).slice(0, 2)) {
    try {
      const text = await pdfText(c.transcript!, 30);
      const p = parseTranscript(text, c.month);
      if (p.cast.length) return { call: c.month, url: c.transcript!, cast: p.cast };
    } catch {}
  }
  return null;
}
