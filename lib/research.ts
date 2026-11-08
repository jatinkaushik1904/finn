import { fundamentals, Fundamentals, row } from "./screener";
import { pdfText, pool } from "./nse";
import { llmJSON, modelInfo } from "./llm";
import { leadsForCompany } from "./network";

const cagr = (a?: number | null, b?: number | null, yrs = 3) =>
  a && b && a > 0 && b > 0 ? (Math.pow(b / a, 1 / yrs) - 1) * 100 : null;
const last = <T,>(a: T[] | undefined, n: number) => (a ? a.slice(-n) : []);

// Screener's annual tables end with a "TTM" column; drop it for year-on-year maths.
function annualOnly(f: Fundamentals) {
  const h = f.annual.headers;
  const ttm = h[h.length - 1]?.toUpperCase() === "TTM";
  const cut = <T,>(r?: T[]) => (r ? (ttm ? r.slice(0, -1) : r) : []);
  return { headers: ttm ? h.slice(0, -1) : h, cut };
}

export async function research(symbol: string) {
  const f = await fundamentals(symbol);
  const A = annualOnly(f);
  const sales = A.cut(row(f.annual, "Sales", "Revenue"));
  const op = A.cut(row(f.annual, "Operating Profit", "Financing Profit"));
  const pat = A.cut(row(f.annual, "Net Profit"));
  const opm = A.cut(row(f.annual, "OPM %", "Financing Margin %"));
  const years = A.headers;
  const n = sales.length;

  const cfo = row(f.cash, "Cash from Operating Activity");
  const cfi = row(f.cash, "Cash from Investing Activity");
  const cashYears = f.cash.headers;
  const k = Math.min(5, cfo?.length ?? 0);
  const patByYear = (y: string) => pat[years.indexOf(y)] ?? null;
  const cashRows = last(cashYears, k).map((y, i) => {
    const idx = cashYears.length - k + i;
    const c = cfo?.[idx] ?? null;
    const p = patByYear(y);
    return { year: y, cfo: c, pat: p, fcf: c != null && cfi?.[idx] != null ? c + (cfi[idx] as number) : null, conversion: c != null && p ? (c / p) * 100 : null };
  });
  const sumC = cashRows.reduce((a, r) => a + (r.cfo ?? 0), 0);
  const sumP = cashRows.reduce((a, r) => a + (r.pat ?? 0), 0);

  const borrowings = row(f.balance, "Borrowings");
  const reserves = row(f.balance, "Reserves");
  const equity = row(f.balance, "Equity Capital");
  const bi = (borrowings?.length ?? 0) - 1;
  const de = borrowings && reserves && equity ? (borrowings[bi] ?? 0) / (((reserves[bi] ?? 0) + (equity[bi] ?? 0)) || 1) : null;
  const rt = f.ratioTable;
  const lastOf = (...names: string[]) => { const r = row(rt, ...names); return r ? r[r.length - 1] : null; };
  const firstOf = (...names: string[]) => { const r = row(rt, ...names); return r ? r[Math.max(0, r.length - 6)] : null; };

  const q = f.quarters;
  const qs = (name: string[]) => last(row(q, ...name), 8);
  const quarters = {
    periods: last(q.headers, 8),
    revenue: qs(["Sales", "Revenue"]),
    ebitda: qs(["Operating Profit", "Financing Profit"]),
    opm: qs(["OPM %", "Financing Margin %"]),
    pbt: qs(["Profit before tax"]),
    pat: qs(["Net Profit"]),
  };

  const signals = { bull: [] as string[], bear: [] as string[] };
  const g3 = cagr(sales[n - 4], sales[n - 1]);
  const p3 = cagr(pat[n - 4], pat[n - 1]);
  if (g3 != null) (g3 >= 12 ? signals.bull : g3 < 6 ? signals.bear : signals.bull).push(`Revenue 3-yr CAGR ${g3.toFixed(0)}%`);
  if (p3 != null && g3 != null) (p3 > g3 ? signals.bull : signals.bear).push(`Profit ${p3 > g3 ? "outgrowing" : "lagging"} revenue (${p3.toFixed(0)}% vs ${g3.toFixed(0)}%)`);
  const conv = sumP ? (sumC / sumP) * 100 : null;
  if (conv != null) (conv >= 80 ? signals.bull : signals.bear).push(`${k}-yr cash conversion ${conv.toFixed(0)}% of PAT`);
  if (opm.length >= 4) {
    const d = (opm[opm.length - 1] ?? 0) - (opm[opm.length - 4] ?? 0);
    if (Math.abs(d) >= 1) (d > 0 ? signals.bull : signals.bear).push(`Operating margin ${d > 0 ? "expanded" : "compressed"} ${Math.abs(d).toFixed(1)} pts over 3 yrs`);
  }
  if (de != null) (de < 0.5 ? signals.bull : de > 1.5 ? signals.bear : signals.bear).push(`Debt/equity ${de.toFixed(2)}×`);
  const ccc = lastOf("Cash Conversion Cycle"), ccc0 = firstOf("Cash Conversion Cycle");
  if (ccc != null && ccc0 != null && Math.abs(ccc - ccc0) > 10) (ccc < ccc0 ? signals.bull : signals.bear).push(`Cash cycle ${ccc0}→${ccc} days`);

  return {
    symbol: f.symbol, name: f.name, about: f.about, sector: f.sector, industry: f.industry, basis: f.basis, source: f.source,
    ratios: f.ratios,
    trajectory: { years: last(years, 6), sales: last(sales, 6), ebitda: last(op, 6), pat: last(pat, 6), opm: last(opm, 6), salesCagr3: g3, patCagr3: p3 },
    balance: {
      years: last(f.balance.headers, 6), borrowings: last(borrowings, 6), de,
      debtorDays: lastOf("Debtor Days"), inventoryDays: lastOf("Inventory Days"), payableDays: lastOf("Days Payable"),
      ccc, ccc0, roce: lastOf("ROCE %"), wcDays: lastOf("Working Capital Days"),
    },
    cash: { rows: cashRows, conversion: conv },
    quarters,
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
const GUIDE = /(guid|expect|target|outlook|aspire|aim to|we will|should be|going forward|next (year|quarter)|FY ?2?\d|double[- ]digit|margin|growth of|grow (at|by)|capex of|band of|range of)/i;
const HAS_NUM = /\d+(\.\d+)?\s?(%|percent|bps|crore|cr\b|x\b)|double[- ]digit|mid[- ]teens|high[- ]single/i;

function guidanceSentences(text: string, max = 40) {
  const sents = text.replace(/\s+/g, " ").split(/(?<=[.?!])\s+(?=[A-Z])/);
  return sents.filter((s) => s.length > 40 && s.length < 450 && GUIDE.test(s) && HAS_NUM.test(s)).slice(0, max);
}

export type Promise_ = { call: string; metric: string; promise: string; horizon: string; quote: string };
export type Verdict = Promise_ & { delivered: string; verdict: "delivered" | "missed" | "partly" | "too early"; note: string };

export async function narrative(symbol: string) {
  const r = await research(symbol);
  const calls = r.concalls.filter((c) => c.transcript).slice(0, 4);
  // Fast tier: read only guidance-bearing sentences (keyword pre-filter cuts ~90% of tokens).
  const perCall = await pool(calls, 2, async (c) => {
    const text = await pdfText(c.transcript!, 30);
    const sents = guidanceSentences(text);
    const extracted = await llmJSON<{ items: Omit<Promise_, "call">[] }>(
      "fast",
      "You extract explicit forward-looking guidance given by company management in an earnings call. Use only the provided sentences. Ignore analyst questions and vague statements.",
      `Call: ${c.month}. From these transcript sentences return JSON {"items":[{"metric":"revenue|margin|volume|capex|debt|other","promise":"short, with the number","horizon":"e.g. FY27 / next quarter","quote":"exact short quote"}]} — max 4 items, only explicit numeric guidance.\n\n${sents.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
      900,
    );
    return { call: c.month, url: c.transcript!, sentences: sents.slice(0, 4), items: (extracted?.items ?? []).map((x) => ({ ...x, call: c.month })) };
  });
  const got = perCall.filter(Boolean) as NonNullable<(typeof perCall)[number]>[];
  const promises = got.flatMap((g) => g.items);

  let verdicts: Verdict[] | null = null;
  let bullBear: { bull: string[]; bear: string[] } | null = null;
  if (promises.length) {
    const table = r.quarters.periods.map((p, i) =>
      `${p}: revenue ${r.quarters.revenue[i]}, EBITDA ${r.quarters.ebitda[i]}, OPM ${r.quarters.opm[i]}%, PAT ${r.quarters.pat[i]}`).join("\n");
    // Smart tier: the one reasoning step.
    const out = await llmJSON<{ verdicts: Verdict[]; bull: string[]; bear: string[] }>(
      "smart",
      "You are a sceptical buy-side analyst. Judge management's promises ONLY against the reported numbers given. Never use outside knowledge. If the horizon hasn't arrived yet, say 'too early'. Figures are INR crore.",
      `Reported quarterly numbers (${r.basis}):\n${table}\n\nAnnual: ${r.trajectory.years.join(", ")} revenue ${r.trajectory.sales.join(", ")}; OPM% ${r.trajectory.opm.join(", ")}.\n\nManagement promises (from the last ${got.length} earnings calls):\n${JSON.stringify(promises)}\n\nReturn JSON {"verdicts":[{...each promise fields, "delivered":"what the numbers show, with figures","verdict":"delivered|missed|partly|too early","note":"<=20 words"}],"bull":["<=3 tight points grounded in the numbers/promises"],"bear":["<=3"]}`,
      2500,
    );
    verdicts = out?.verdicts ?? null;
    if (out) bullBear = { bull: out.bull, bear: out.bear };
  }
  return {
    symbol: r.symbol,
    model: modelInfo(),
    calls: got.map((g) => ({ call: g.call, url: g.url, found: g.items.length, sentences: g.sentences })),
    verdicts,
    bullBear,
  };
}
