import { pdfText } from "./nse";
import { llm } from "./llm";
import type { Headline } from "./screener";

// Headline numbers straight from the results filing. SEBI's results format prints three quarter
// columns — this quarter, the preceding quarter, the same quarter last year — so QoQ and YoY are
// on the page. The fast model only COPIES numbers; all arithmetic (unit conversion, EBITDA,
// growth) happens here, and the result is cross-checked against screener.in before it is shown.

type Cols = [number | null, number | null, number | null];
type X = {
  basis?: string; unit?: string; periods?: string[];
  revenue?: Cols; otherIncome?: Cols; financeCosts?: Cols; depreciation?: Cols; pbt?: Cols; pat?: Cols;
};

export type FilingHeadline = Headline & { source: string; from: "filing" | "screener"; basis?: string; check?: string };

const SYS =
  "You copy numbers from an Indian listed company's quarterly financial-results statement. Copy figures exactly as printed (negative numbers in brackets become negative). Never compute, estimate or use outside knowledge. If a value is not printed, use null.";

const UNIT: Record<string, number> = { crore: 1, crores: 1, lakh: 0.01, lakhs: 0.01, million: 0.1, millions: 0.1, thousand: 0.0001, rupees: 1e-7 };

const pct = (a: number | null, b: number | null) => (a == null || b == null || b === 0 ? null : ((a - b) / Math.abs(b)) * 100);

export async function resultsFromFiling(url: string, fallback: (Headline & { source: string }) | null, timeoutMs: number): Promise<FilingHeadline | null> {
  let text = "";
  try { text = (await pdfText(url, 14)).replace(/[ \t]+/g, " "); } catch {}
  // Lenders' statements have no "Revenue from operations" — keep the reported-table numbers for them.
  if (!/revenue from operations/i.test(text)) return fallback ? { ...fallback, from: "screener" } : null;
  const c = text.search(/statement of (?:the )?(?:un-?audited|audited)?\s*consolidated (?:financial )?results/i);
  const start = c >= 0 ? c : Math.max(0, text.search(/revenue from operations/i) - 1500);
  const slice = text.slice(start, start + 9000);
  const res = await llm<X>("fast", SYS,
    `From this results statement, take the FIRST THREE quarter columns (quarter ended: current, preceding, corresponding quarter of the previous year) — not half-year or full-year columns.\n` +
    `Return JSON {"basis":"consolidated|standalone","unit":"crore|lakh|million|thousand|rupees (as stated, e.g. '₹ in crore')","periods":["current","preceding","year-ago" quarter-end dates as printed],"revenue":[3 numbers, Revenue from operations],"otherIncome":[3],"financeCosts":[3],"depreciation":[3, depreciation and amortisation],"pbt":[3, profit before tax],"pat":[3, net profit for the period]}\n\n${slice}`,
    700, { timeoutMs });
  const x = res.value;
  const mult = UNIT[(x?.unit ?? "").toLowerCase().replace(/[^a-z]/g, "").replace(/^in/, "")] ?? (/lakh/i.test(slice.slice(0, 1500)) ? 0.01 : /million/i.test(slice.slice(0, 1500)) ? 0.1 : 1);
  const v = (k: keyof X): Cols | null => {
    const a = x?.[k] as unknown;
    return Array.isArray(a) && a.length >= 3 ? (a.slice(0, 3).map((n) => (typeof n === "number" ? n * mult : null)) as Cols) : null;
  };
  const rev = v("revenue"), pbt = v("pbt"), pat = v("pat"), fin = v("financeCosts"), dep = v("depreciation"), oi = v("otherIncome");
  if (!rev || !pbt || !pat || rev[0] == null || rev[0] <= 0) return fallback ? { ...fallback, from: "screener" } : null;
  // EBITDA = PBT + finance costs + depreciation − other income (operating, excludes treasury income).
  const ebitda = [0, 1, 2].map((i) => (pbt[i] == null || fin?.[i] == null || dep?.[i] == null ? null : pbt[i]! + fin[i]! + dep[i]! - (oi?.[i] ?? 0))) as Cols;
  // Cross-check: the filing's current-quarter revenue should match the reported table (same basis) within 3%.
  let check: string | undefined;
  const ref = fallback?.lines.find((l) => l.label === "Revenue")?.value ?? null;
  if (ref) {
    const gap = Math.abs(rev[0]! - ref) / ref;
    if (gap > 0.15) return { ...fallback!, from: "screener", check: "Filing extraction disagreed with reported tables — showing the tables" };
    check = gap <= 0.03 ? "matches screener.in" : `within ${Math.round(gap * 100)}% of screener.in (basis may differ)`;
  }
  // A line is taken from the filing only if all three columns were read; otherwise that line
  // falls back to the reported tables (and the card says so) — never a blank where we had a number.
  let mixed = false;
  const line = (label: string, a: Cols | null) => {
    if (a && a.every((n) => n != null)) return { label, value: a[0], qoq: pct(a[0], a[1]), yoy: pct(a[0], a[2]) };
    const fb = fallback?.lines.find((l) => l.label === label || (label === "EBITDA" && /PPOP|EBITDA/.test(l.label)));
    if (fb) mixed = true;
    return fb ?? { label, value: a?.[0] ?? null, qoq: null, yoy: null };
  };
  const lines = [line("Revenue", rev), line("EBITDA", ebitda), line("PBT", pbt), line("PAT", pat)];
  if (mixed) check = `${check ? check + " · " : ""}some lines from screener.in`;
  const p = x?.periods ?? [];
  return {
    period: p[0] || fallback?.period || "Latest quarter",
    prevPeriod: p[1] || fallback?.prevPeriod || "previous quarter",
    yoyPeriod: p[2] || fallback?.yoyPeriod || "year-ago quarter",
    ebitdaLabel: "EBITDA",
    lines,
    source: url,
    from: "filing",
    basis: /standalone/i.test(x?.basis ?? "") ? "standalone" : "consolidated",
    check,
  };
}
