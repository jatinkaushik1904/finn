import { fundamentals, Fundamentals, isFinancialCo, row } from "./screener";
import { pdfText, pool } from "./nse";
import { llm, modelInfo } from "./llm";
import { cached, HOUR } from "./cache";
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
    const idx = cashYears.length - k + i;
    const c = cfo?.[idx] ?? null;
    const p = patByYear(y);
    return {
      year: y, cfo: c, pat: p,
      fcf: c != null && cfi?.[idx] != null ? c + (cfi[idx] as number) : null,
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
//   1. fetch + parse up to 6 transcripts concurrently (pool 4, first 30 pages)
//   2. rules: split into speaker turns, keep MANAGEMENT turns only (analyst questions dropped),
//      keep sentences that are forward-looking AND carry a number  → ~3-6k chars per call
//   3. fast tier, one call per transcript: pick explicit numeric guidance (by sentence number,
//      so the quote is verbatim from the transcript, never paraphrased by the model)
//   4. smart tier, one call total: judge every promise against the reported quarterly/annual
//      table (INR crore) with the horizon resolved to Indian fiscal quarters
//   A 50s budget wraps it all: anything still running is returned as partial and keeps going in
//   the background, so the next view comes straight from cache.

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const QEND = [5, 8, 11, 2]; // Q1..Q4 of an Indian FY end in Jun, Sep, Dec, Mar

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

// Management names from the title page ("MANAGEMENT: MR. ATUL LALL – MANAGING DIRECTOR …").
type Mgr = { t: string[]; title: string };
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
  const names = hits.map((x, i) => ({
    t: toks(x[1]).filter((t) => !JUNK.test(t)),
    title: block.slice((x.index ?? 0) + x[0].length, hits[i + 1]?.index ?? block.length).replace(/\s+/g, " ").replace(/^[\s–,-]+|[\s–,-]+$/g, "").slice(0, 90),
  })).filter((n) => n.t.length);
  if (names.length) return names;
  return block.split("\n").map((l) => l.split(/\s[–-]\s|,/)[0].trim()).filter((l) => /^[A-Za-z.' ]{4,40}$/.test(l) && l.split(/\s+/).length <= 4)
    .map((l) => ({ t: toks(l).filter((t) => !JUNK.test(t)), title: "" })).filter((n) => n.t.length);
}

// Is this speaker running a division / subsidiary rather than the listed company?
// "CEO, Eyecare Division", "Managing Director, CaratLane" -> yes; "CFO – HDFC Bank Limited" -> no.
const TITLE_WORDS = /^(chief|officer|director|managing|president|head|group|secretary|legal|counsel|finance|financial|executive|vice|senior|strategy|relations|investor|corporate|operations|technology|human|resources|company|limited|ltd|india|private|the|and|of|whole|time|interim|part|chairman|chairperson|deputy|joint|additional|charge|with|engineering|research|development|cfo|ceo|coo|md|cio|cto|ir|svp|evp|avp|global|business|independent|non)$/;
function segmentTitle(title: string, company: string) {
  if (!title) return false;
  if (/\b(division|segment|vertical|subsidiary|business unit|bu head)\b/i.test(title)) return true;
  const org = title.split(/,|\s[–-]\s/).slice(1).join(" ");
  const co = toks(company);
  const odd = toks(org).filter((w) => w.length >= 4 && !TITLE_WORDS.test(w) && !co.includes(w));
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
  return { quarter, earnings, management: mgmt.map((n) => n.title ? `${n.t.join(" ")} (${n.title})` : n.t.join(" ")), turns };
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
// evidence for promises the consolidated table can't measure (segments, volumes, store adds…).
const ACT = /\b(was|were|grew|stood at|reported|registered|delivered|achieved|recorded|declined|clocked|increased|decreased|rose|fell|expanded|improved|came in|ended|added|opened|crossed)\b/i;
const KPI = /\b(grew|growth|margin|revenue|sales|volume|EBITDA|EBIT|profit|PAT|stores?|order|capex|debt|market share|units)\b/i;
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
      const nums = s.match(new RegExp(NUM.source, "gi"))?.length ?? 0;
      out.push({ n: pos, s, score: nums + (KPI.test(s) ? 2 : 0) });
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

export type Promise_ = { call: string; metric: string; promise: string; horizon: string; quote: string };
export type VerdictKind = "delivered" | "missed" | "partly" | "too early" | "unverifiable";
export type Verdict = Promise_ & {
  delivered: string; verdict: VerdictKind; note: string;
  speaker?: string; quarter?: string | null; scope?: string; subject?: string; reiterated?: string[];
};

type Extracted = Promise_ & { speaker: string; quarter: string | null; scope: string; subject: string; id?: number; reiterated?: string[] };

// Largest INR-crore amount in a piece of text ("INR 3,500 crores to INR 4,000 crores" -> 4000).
function croreAmount(s: string): number | null {
  let best: number | null = null;
  for (const m of s.matchAll(/([\d,]+(?:\.\d+)?)\s*(?:-|–|to)?\s*(?:INR|Rs\.?|₹)?\s*([\d,]+(?:\.\d+)?)?(?:\s*-?\s*odd)?\s*(crores?|cr\b)/gi)) {
    const v = Number((m[2] ?? m[1]).replace(/,/g, ""));
    if (Number.isFinite(v) && (best == null || v > best)) best = v;
  }
  return best;
}

const EXTRACT_SYS =
  "You extract forward-looking guidance that company MANAGEMENT gave on an earnings call. The numbered sentences were spoken by management (analyst questions already removed). Use only these sentences; never add numbers, context or knowledge from outside them. Skip results already reported (past tense), vague hopes without a number, and anything that is an analyst's estimate.";

const JUDGE_SYS =
  "You are a sceptical buy-side analyst checking whether management delivered on its own guidance. Use ONLY the reported figures provided (INR crore, from the company's filings). Never use outside knowledge, news, estimates or memory of the company. Indian fiscal year: FY27 = Apr 2026–Mar 2027; Q1 = Jun quarter, Q2 = Sep, Q3 = Dec, Q4 = Mar. Be concise and cite figures with their periods.";

const num0 = (x: number | null | undefined) => (x == null ? "—" : String(Math.round(x)));
const pctChg = (a?: number | null, b?: number | null) => (a == null || b == null || b === 0 ? null : ((a - b) / Math.abs(b)) * 100);
const sgn = (x: number | null) => (x == null ? "—" : `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`);

// The reported numbers the judge may use: quarterly P&L with YoY computed here (the model never
// does the arithmetic), fiscal-year-to-date, and the annual trajectory incl. PBT and tax rate.
// Lenders get NII / asset quality instead of EBITDA ("Financing profit" is not NIM or PPOP).
async function numbersFor(r: Research) {
  const f = await fundamentals(r.symbol);
  const fin = r.isFinancial;
  const q = f.quarters;
  const H = q.headers;
  const rev = row(q, "Sales", "Revenue"), op = fin ? sub(rev, row(q, "Interest")) : row(q, "Operating Profit"), opm = fin ? undefined : row(q, "OPM %");
  const pbt = row(q, "Profit before tax"), tax = row(q, "Tax %"), pat = row(q, "Net Profit");
  const gn = row(q, "Gross NPA %"), nn = row(q, "Net NPA %");
  const opName = fin ? "NII" : "EBITDA";
  const pc = (x?: number | null) => (x == null ? "—" : `${x}%`);
  const lines: string[] = [];
  lines.push(`Quarter | ${fin ? "Interest earned" : "Revenue"} | Rev YoY | ${opName}${fin ? " | NII YoY" : " | OPM"} | PBT | Tax rate | PAT | PAT YoY${gn ? " | GNPA | NNPA" : ""}`);
  for (let i = Math.max(0, H.length - 9); i < H.length; i++) {
    lines.push([
      `${H[i]} (${fyLabel(H[i])})`, num0(rev?.[i]), sgn(pctChg(rev?.[i], rev?.[i - 4])), num0(op?.[i]),
      fin ? sgn(pctChg(op?.[i], op?.[i - 4])) : pc(opm?.[i]), num0(pbt?.[i]), pc(tax?.[i]), num0(pat?.[i]), sgn(pctChg(pat?.[i], pat?.[i - 4])),
      ...(gn ? [pc(gn[i]), pc(nn?.[i])] : []),
    ].join(" | "));
  }
  // Fiscal year to date vs the same months last year.
  const lastP = H[H.length - 1];
  const fyq = Number(fyLabel(lastP).match(/^Q(\d)/)?.[1] ?? 0);
  let ytd = "";
  if (fyq >= 2 && H.length >= fyq + 4) {
    const sum = (r_?: (number | null)[], off = 0) => { let t = 0; for (let i = H.length - fyq - off; i < H.length - off; i++) { if (r_?.[i] == null) return null; t += r_[i] as number; } return t; };
    const part = (label: string, r_?: (number | null)[]) => { const a = sum(r_), b = sum(r_, 4); return `${label} ${num0(a)} vs ${num0(b)} (${sgn(pctChg(a, b))})`; };
    ytd = `\nFiscal year to date (first ${fyq} quarters of ${fyLabel(lastP).split(" ")[1]} vs the same quarters a year earlier): ${[part(fin ? "interest earned" : "revenue", rev), part(opName, op), part("PAT", pat)].join("; ")}${opm ? `; OPM ${H.slice(-fyq).map((h, j) => `${h} ${pc(opm[H.length - fyq + j])}`).join(", ")}` : ""}.`;
  }
  const A = annualOnly(f);
  const ar = (...n: string[]) => A.cut(row(f.annual, ...n));
  const aRev = ar("Sales", "Revenue"), aOp = fin ? sub(aRev, ar("Interest")) ?? [] : ar("Operating Profit"), aOpm = ar("OPM %");
  const aPbt = ar("Profit before tax"), aTax = ar("Tax %"), aPat = ar("Net Profit");
  const from = Math.max(0, A.headers.length - 5);
  const annual = A.headers.slice(from).map((y, j) => {
    const i = from + j;
    return `FY${y.slice(-2)}: ${fin ? "interest earned" : "revenue"} ${num0(aRev[i])}${i ? ` (${sgn(pctChg(aRev[i], aRev[i - 1]))})` : ""}, ${opName} ${num0(aOp[i])}${fin ? "" : `, OPM ${pc(aOpm[i])}`}, PBT ${num0(aPbt[i])}, tax rate ${pc(aTax[i])}, PAT ${num0(aPat[i])}`;
  }).join("\n");
  const b = r.balance;
  const bal = !b.years.length ? "" : fin
    ? (b.deposits?.length ? `\nDeposits (${b.years.join(", ")}): ${b.deposits.map(num0).join(", ")}` : "")
    : `\nBorrowings (${b.years.join(", ")}): ${b.borrowings.map(num0).join(", ")}; latest debt/equity ${b.de?.toFixed(2) ?? "—"}`;
  const cash = !fin && r.cash.rows.length ? `\nCash from operations by FY: ${r.cash.rows.map((c) => `FY${c.year.slice(-2)} ${num0(c.cfo)}`).join(", ")}` : "";
  return { latest: lastP, text: `${lines.join("\n")}${ytd}\n\nAnnual (FY ends March):\n${annual}${bal}${cash}` };
}

const idx = (period: string) => {
  const [m, y] = period.split(" ");
  const mi = MONTHS.indexOf(m?.toLowerCase().slice(0, 3));
  return mi < 0 || !Number(y) ? null : Number(y) * 12 + mi;
};
const fy2 = (x: string) => (x.length === 4 ? Number(x) : 2000 + Number(x));

// Last month (y*12+m) a horizon covers, resolved against the call it came from; null if vague.
function horizonEnd(h: string, callMonth: string, callQuarter: string | null): number | null {
  const ends: number[] = [];
  const push = (p: string) => { const i = idx(p); if (i != null) ends.push(i); };
  for (const m of h.matchAll(/\bQ([1-4])\s*FY\s*'?(\d{4}|\d{2})/gi)) push(periodOf(+m[1], fy2(m[2])));
  for (const m of h.matchAll(/\bH([12])\s*FY\s*'?(\d{4}|\d{2})/gi)) push(m[1] === "1" ? `Sep ${fy2(m[2]) - 1}` : `Mar ${fy2(m[2])}`);
  for (const m of h.matchAll(/(?<![QH][1-4]\s?)\bFY\s*'?(\d{4}|\d{2})(?:\s*[-–]\s*'?(\d{2}))?/gi)) push(`Mar ${fy2(m[2] ?? m[1])}`);
  for (const m of h.matchAll(/\b(?:March|Mar)\s*(20\d{2})\b/gi)) push(`Mar ${m[1]}`);
  const cfy = fyOfMonth(callMonth);
  if (/next quarter/i.test(h) && callQuarter) { const i = idx(callQuarter); if (i != null) ends.push(i + 3); }
  if (cfy && /this (?:fiscal|year)|current (?:fiscal|year)/i.test(h)) push(`Mar ${2000 + +cfy}`);
  if (cfy && /next (?:fiscal|year|financial year)/i.test(h)) push(`Mar ${2001 + +cfy}`);
  const yrs = h.match(/(\d+)\s*(?:-|to)?\s*(\d+)?\s*years?/i);
  if (cfy && yrs) push(`Mar ${2000 + +cfy + Number(yrs[2] ?? yrs[1])}`);
  return ends.length ? Math.max(...ends) : null;
}

const normQ = (s: string) => s.toLowerCase().replace(/[^a-z0-9%.]+/g, " ").trim();
const RANK: Record<string, number> = { missed: 0, partly: 1, delivered: 2, "too early": 3, unverifiable: 4 };

export type Narrative = Awaited<ReturnType<typeof computeNarrative>>;

async function computeNarrative(r: Research, budgetMs: number) {
  const t0 = Date.now();
  const left = () => budgetMs - (Date.now() - t0);
  const timings: Record<string, number> = {};
  const candidates = r.concalls.filter((c) => c.transcript).slice(0, 6);

  // 1-2. Fetch, parse, filter — all transcripts concurrently.
  const parsed = await pool(candidates, 4, async (c) => {
    const ts = Date.now();
    const text = await Promise.race([pdfText(c.transcript!, 30), new Promise<string>((_, rej) => setTimeout(() => rej(new Error("pdf timeout")), Math.min(20_000, Math.max(1_000, left() - 25_000))))]);
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
  const extracted = await Promise.all(calls.map(async (c) => {
    if (!c.sents.length) return { c, items: [] as Extracted[], llm: null };
    const prompt =
      `Company: ${r.name}. Call held ${c.month}${fyOfMonth(c.month) ? ` (in FY${fyOfMonth(c.month)})` : ""}${c.quarter ? `, discussing the quarter ended ${c.quarter} (${fyLabel(c.quarter)})` : ""}. Indian FY runs Apr–Mar (FY27 = Apr 2026–Mar 2027).\n` +
      `Write horizon as fiscal periods: "this year"/"current fiscal" = FY${fyOfMonth(c.month) ?? "of the call date"}; "next year" = the FY after that; "next quarter" = the quarter after ${c.quarter ? fyLabel(c.quarter) : "the one discussed"}.\n` +
      `Return JSON {"items":[{"n":<sentence number>,"metric":"revenue|growth|margin|profit|volume|capex|debt|working capital|asset quality|other","subject":"what the number is for: 'whole company' or the business/segment/product/subsidiary it refers to","scope":"company|segment","promise":"<=12 words naming the measured quantity and the number, e.g. 'EBITDA margin 16-17%' or 'Loan-to-deposit ratio 85-90%'","horizon":"e.g. FY27, Q3 FY27, next quarter, 2-3 years","quote":"exact words copied from that sentence, <=20 words"}]}.\n` +
      `scope is "company" only if the sentence is clearly about the whole company (overall, consolidated, total, company-level); a business line, product, JV, subsidiary or unclear subject is "segment".\n` +
      `Skip a sentence if it does not make clear what quantity the number measures. At most 4 items. Prefer company-level, numeric guidance that reported financials can check (revenue/growth, EBITDA margin, profit, capex, debt). Return {"items":[]} if there is none.\n\n` +
      c.sents.map((s) => `${s.n}. [${s.speaker}${s.title ? `, ${s.title.slice(0, 50)}` : ""}] ${s.text}`).join("\n");
    type Raw = Partial<Promise_> & { n?: number; scope?: string; subject?: string };
    const res = await llm<{ items?: Raw[] } | Raw[]>(
      "fast", EXTRACT_SYS, prompt, 1200, { timeoutMs: Math.max(3_000, Math.min(25_000, left() - 20_000)) });
    const arr = Array.isArray(res.value) ? res.value : res.value?.items ?? [];
    const items: Extracted[] = arr.filter((x) => x && x.promise).slice(0, 4).map((x) => {
      const s = c.sents.find((y) => y.n === Number(x.n));
      // Grounding check: the quote must be verbatim from the sentence; otherwise use the sentence itself.
      const quoteOk = s && x.quote && normQ(s.text).includes(normQ(x.quote));
      const quote = quoteOk ? x.quote! : s ? (s.text.length > 200 ? s.text.slice(0, 197) + "…" : s.text) : "";
      return {
        call: c.month, metric: x.metric ?? "other", promise: x.promise!, horizon: x.horizon ?? "", quote,
        speaker: s?.speaker ?? "", quarter: c.quarter, scope: x.scope === "company" ? "company" : "segment", subject: x.subject ?? "",
        ...(s?.title && segmentTitle(s.title, r.name) ? { scope: "segment", subject: x.subject && !/whole|company/i.test(x.subject) ? x.subject : s.title } : {}),
      };
    }).filter((x) => x.quote);
    return { c, items, llm: res };
  }));
  timings.extract = Date.now() - t1;

  // Same guidance repeated on later calls: keep the earliest (most testable), note the reiterations.
  const byKey = new Map<string, Extracted>();
  for (const e of extracted.slice().reverse()) {
    for (const it of e.items) {
      // Key on the guided numbers only (years and FY/Q labels stripped), so "$2bn by FY27" == "$2bn by March 2027".
      const k = `${it.metric}|${(it.promise.replace(/\b(?:FY|Q[1-4]|H[12])\s*'?\d{2,4}\b|\b20\d{2}\b/gi, "").match(/\d+(?:\.\d+)?/g) ?? []).join(",")}`;
      const prev = byKey.get(k);
      if (prev) (prev.reiterated ??= []).push(it.call);
      else byKey.set(k, it);
    }
  }
  // Scale check (deterministic): an absolute revenue figure far below the company's own reported
  // run-rate is a segment number, whatever the model labelled it — never score it against totals.
  const fyRev = r.trajectory.sales.at(-1) ?? null, qRev = r.quarters.revenue.at(-1) ?? null;
  for (const p of byKey.values()) {
    if (p.scope !== "company" || !/revenue|growth|sales/i.test(p.metric)) continue;
    const amt = croreAmount(`${p.promise} ${p.quote}`);
    const scale = /\bQ[1-4]\b|quarter/i.test(p.horizon) ? qRev : fyRev;
    if (amt != null && scale && amt < 0.4 * scale) { p.scope = "segment"; p.subject = `a business line (₹${amt.toLocaleString("en-IN")} cr is far below company scale)`; }
  }
  const all = [...byKey.values()];
  // Two kinds of evidence. (A) the reported table, for company-level metrics it carries.
  // (B) management's own statements of what they achieved on a LATER call — the only fair test for
  // segment / volume / KPI guidance the consolidated filings don't break out.
  const MEASURABLE = /revenue|growth|sales|margin|profit|ebitda|pat|capex|debt|working|tax|asset quality|npa/i;
  const offTable = (p: Extracted) => p.scope !== "company" || !MEASURABLE.test(`${p.metric} ${p.promise}`);
  const promises = [...all.filter((p) => !offTable(p)), ...all.filter(offTable)].slice(0, 10).map((p, i) => ({ ...p, id: i + 1, offTable: offTable(p) }));
  const segment = promises.filter((p) => p.offTable);
  const mIdx = (m: string) => idx(m) ?? 0;
  const oldest = promises.length ? Math.min(...promises.map((p) => mIdx(p.call))) : 0;
  let evChars = 0;
  const evidence = calls
    .filter((c) => mIdx(c.month) > oldest && c.facts.length)
    .sort((a, b) => mIdx(a.month) - mIdx(b.month))
    .map((c) => `Call ${c.month}${c.quarter ? ` (on ${fyLabel(c.quarter)} results)` : ""} — management said:\n${c.facts.map((s, i) => `  ${i + 1}) ${s}`).join("\n")}`)
    .filter((b) => (evChars += b.length) <= 7000)
    .join("\n");

  // 4. Smart tier: one judgement over everything.
  let verdicts: Verdict[] | null = null;
  let bullBear: { bull: string[]; bear: string[] } | null = null;
  let judge: Awaited<ReturnType<typeof llm>> | null = null;
  let asOf: string | null = null;
  const t2 = Date.now();
  const segVerdicts: Verdict[] = segment.map((p) => p.scope === "company"
    ? { ...p, verdict: "unverifiable", note: "Not a reported line", delivered: "The quarterly and annual filings don't report this metric." }
    : { ...p, verdict: "unverifiable", note: "Segment guidance", delivered: `About ${p.subject || "a business line"}; the consolidated results don't break this out.` });
  if (promises.length) {
    const nums = await numbersFor(r);
    asOf = nums.latest;
    const latestIdx = idx(nums.latest);
    const prompt =
      `${r.name} — reported figures, ${r.basis}, INR crore. Latest reported quarter: ${nums.latest} (${fyLabel(nums.latest)}). Nothing after it has been reported.\n${nums.text}\n\n` +
      `${evidence ? `(B) What management itself reported on later calls (primary source — their own words):\n${evidence}\n\n` : ""}` +
      `Guidance management gave on the last ${calls.length} earnings calls (each call discusses the quarter named and guides forward from it):\n` +
      promises.map((p) => `#${p.id} [call ${p.call}${fyOfMonth(p.call) ? ` (in FY${fyOfMonth(p.call)})` : ""}${p.quarter ? `, on ${fyLabel(p.quarter)} results` : ""}] [${p.offTable ? `segment/KPI: ${p.subject || "not company-wide"}` : "company-level"}] ${p.metric} · horizon "${p.horizon}" · ${p.promise} — "${p.quote}"`).join("\n") +
      `\n\nRules: resolve each horizon to fiscal quarters ("next quarter" = the quarter after the one that call discussed; "this year" = the fiscal year that call falls in). Verdict "delivered", "missed" or "partly" ONLY if every period in the horizon has been reported; if the horizon has not fully arrived, "too early" — and say what the run-rate shows so far. Company-level promises: judge against the table (management's later statements may support). Segment/KPI promises: judge ONLY from (B) — a statement on a call LATER than the promise, about the same business/metric — and cite it as "per <month> call"; if (B) has nothing on it, "unverifiable". If the table cannot measure a company-level metric (volume, NIM, loan growth, order book, capex detail) and (B) is silent, "unverifiable". You have no exchange rates: never convert USD or other currencies — judge a USD target only through growth rates, else "too early"/"unverifiable". ${r.isFinancial ? "This is a lender: 'margin' guidance means NIM, which the table does not have — \"unverifiable\"; so are loan/deposit growth, LDR, credit cost and cost-to-income." : "Margin promises compare against OPM."} Growth promises compare against the YoY columns. Tax-rate guidance compares against the tax rate column. Quote figures exactly as given in the table; do not re-add quarters that the table already totals. If the metric or what a number refers to is unclear, "unverifiable" — never guess which line it maps to.\n` +
      `Return JSON {"verdicts":[{"id":<#>,"delivered":"<=25 words: what the reported numbers show, with figures and periods","verdict":"delivered|missed|partly|too early|unverifiable","note":"<=12 words"}],"bull":["<=3 points, <=18 words each, about the last 4 quarters and the guidance track record, grounded only in the figures above"],"bear":["<=3, same rules"]}`;
    judge = await llm<{ verdicts?: { id: number; delivered?: string; verdict?: string; note?: string }[]; bull?: string[]; bear?: string[] }>(
      "smart", JUDGE_SYS, prompt, 2500, { timeoutMs: Math.max(2_000, Math.min(40_000, left() - 1_000)) });
    const out = judge.value as { verdicts?: { id: number; delivered?: string; verdict?: string; note?: string }[]; bull?: string[]; bear?: string[] } | null;
    if (out?.verdicts) {
      verdicts = promises.map((p): Verdict => {
        const v = out.verdicts!.find((x) => Number(x.id) === p.id);
        const kind = (v?.verdict && v.verdict in RANK ? v.verdict : "unverifiable") as VerdictKind;
        const { id: _id, offTable: _off, ...rest } = p;
        const said = (v?.delivered ?? "").replace(/^(delivered|missed|partly|too early|unverifiable)\s*([.:,—-]\s*|$)/i, "") || v?.note || "Not judged";
        // Hard rule, enforced in code: no final verdict before the horizon has been reported.
        const end = horizonEnd(p.horizon, p.call, p.quarter);
        if (end != null && latestIdx != null && end > latestIdx && (kind === "delivered" || kind === "missed" || kind === "partly")) {
          const so = kind === "delivered" ? "Ahead so far" : kind === "missed" ? "Behind so far" : "Mixed so far";
          return { ...rest, delivered: said, verdict: "too early", note: v?.note ? `${so} · ${v.note}` : so };
        }
        return { ...rest, delivered: said, verdict: kind, note: v?.note ?? "" };
      }).sort((a, b) => RANK[a.verdict] - RANK[b.verdict]).slice(0, 8);
      bullBear = { bull: (out.bull ?? []).slice(0, 3), bear: (out.bear ?? []).slice(0, 3) };
    }
  }
  timings.judge = Date.now() - t2;
  timings.total = Date.now() - t0;

  const fastLLM = extracted.map((e) => e.llm).filter(Boolean) as NonNullable<(typeof extracted)[number]["llm"]>[];
  const timedOut = fastLLM.some((x) => x.error) || (promises.length > 0 && !verdicts);
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
    // Efficiency readout: what was read, what was sent to which model, how long each stage took.
    stats: {
      ms: timings,
      transcripts: calls.map((c) => ({ call: c.month, pdfChars: c.textChars, managementChars: c.mgmtChars, sentencesKept: c.sents.length, charsToFast: c.sents.reduce((a, s) => a + s.text.length, 0) })),
      fast: fastLLM.map((x) => ({ model: x.model, promptChars: x.promptChars, ms: x.ms, cached: x.cached, error: x.error })),
      smart: judge ? { model: judge.model, promptChars: judge.promptChars, ms: judge.ms, cached: judge.cached, error: judge.error } : null,
    },
  };
}

const PIPELINE = "pvd-12"; // bump when prompts or rules change, so cached verdicts are recomputed

// Whole-result cache keyed by the exact transcripts and the latest reported quarter: a new call or
// new results invalidate it automatically. Partial results are never cached.
export async function narrative(symbol: string, budgetMs = 50_000) {
  const t0 = Date.now();
  const r = await research(symbol);
  const key = `narr:${PIPELINE}:${r.symbol}:${r.basis}:${r.quarters.periods.at(-1)}:${r.concalls.map((c) => c.transcript ?? "").join(",")}:${JSON.stringify(modelInfo())}`;
  let hit = true;
  const out = await cached(key, 24 * HOUR, () => { hit = false; return computeNarrative(r, budgetMs - (Date.now() - t0)); }, (v) => !v.partial && v.calls.length > 0);
  return { ...out, cached: hit, ms: Date.now() - t0 };
}
