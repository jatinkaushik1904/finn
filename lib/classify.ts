// Rule-based classifier: maps NSE's `desc` + attachment text onto the reference
// categories. It's free, instant and deterministic. It covers ~95% of filings,
// so the LLM only sees the rare ambiguous ones (and the few that need reading).

export type Category =
  | "results" | "M&A" | "fund_raise" | "management_change" | "litigation" | "insider_trading"
  | "earnings_call" | "investor_meetings" | "credit_rating" | "dividend" | "bonus_split" | "capex"
  | "press_release" | "postal_ballot" | "agm_egm" | "pledging" | "unclassified";

export const CATEGORY_LABEL: Record<Category, string> = {
  results: "Results", "M&A": "M&A", fund_raise: "Fund raise", management_change: "Management",
  litigation: "Litigation", insider_trading: "Insider trade", earnings_call: "Earnings call",
  investor_meetings: "Investor meet", credit_rating: "Credit rating", dividend: "Dividend",
  bonus_split: "Bonus / split", capex: "Capex", press_release: "Press release",
  postal_ballot: "Postal ballot", agm_egm: "AGM / EGM", pledging: "Pledge", unclassified: "Routine",
};

// Base materiality, 0–100. The user's "care about" list adds on top.
const BASE: Record<Category, number> = {
  results: 80, "M&A": 78, management_change: 70, litigation: 72, fund_raise: 66, capex: 66,
  pledging: 64, credit_rating: 50, insider_trading: 48, press_release: 40, bonus_split: 40,
  dividend: 30, earnings_call: 22, agm_egm: 18, postal_ballot: 15, investor_meetings: 10, unclassified: 3,
};

const RULES: [Category, RegExp][] = [
  ["pledging", /pledg|encumbr/i],
  ["insider_trading", /insider trading|\bPIT\b|takeover regulation|reg(ulation)?\.? ?(29|31)\b|acquisition of shares by promoter/i],
  ["credit_rating", /credit rating|rating agency|reaffirm|crisil|icra|care ratings|india ratings/i],
  ["litigation", /litigation|dispute|regulatory action|penalty|show cause|order passed|tribunal|nclt|insolvency|fine imposed|demand order|search operation/i],
  ["management_change", /resignation|appointment|change in director|key managerial|cessation|retire|re-appoint|chief (executive|financial|operating)|\bCFO\b|\bCEO\b|managing director/i],
  ["M&A", /acquisition|amalgamation|merger|demerger|scheme of arrangement|joint venture|incorporat(ed|ion) of (a )?(wholly|subsidiary)|stake|divest/i],
  ["fund_raise", /qip|qualified institution|rights issue|preferential|commercial paper|non-convertible|ncd|debentures|buy ?back|raising of funds|fund rais/i],
  ["capex", /capex|capacity expansion|new plant|greenfield|brownfield|commission(ing|ed) of/i],
  ["bonus_split", /bonus|sub-division|split/i],
  ["dividend", /dividend|record date/i],
  ["earnings_call", /transcript|audio recording|call recording|earnings call|conference call/i],
  ["investor_meetings", /analyst|institutional investor|investor meet|investor conference|non-deal roadshow/i],
  ["agm_egm", /annual general meeting|\bAGM\b|\bEGM\b|extra-?ordinary general/i],
  ["postal_ballot", /postal ballot|e-voting/i],
  ["results", /financial results?|outcome of board meeting|results for the (quarter|period)|investor presentation|quarterly update/i],
  ["press_release", /press release|order (win|received|book)|bags|launch|partnership|clarification/i],
];

const ROUTINE = /newspaper publication|certificate under|compliance certificate|regulation 74|loss of share certificate|duplicate share|trading window|esop|allotment of (equity )?shares under|secretarial|esg|business responsibility|redemption of commercial paper|change in auditors|statement of deviation|spurt in volume/i;

export function classify(desc: string, text: string): Category {
  const s = `${desc} :: ${text}`;
  // Exchange-provided descriptors for clear-cut cases first.
  if (/^copy of newspaper/i.test(desc) || ROUTINE.test(s) && !/acquisition|resign|appoint/i.test(desc)) return "unclassified";
  if (/^analysts\/institutional/i.test(desc)) {
    return /transcript|recording|earnings call|results/i.test(text) ? "earnings_call" : "investor_meetings";
  }
  if (/^outcome of board meeting/i.test(desc) && /financial result/i.test(text)) return "results";
  if (/^financial result/i.test(desc)) return "results";
  for (const [cat, re] of RULES) if (re.test(s)) return cat;
  return "unclassified";
}

// "Titan Company Limited has informed the Exchange about X" -> "X"
export function cleanSummary(text: string, company: string) {
  let t = (text || "").replace(/\s+/g, " ").trim();
  t = t.replace(/^.*?has (informed|submitted to) the Exchange(,)? (about|regarding|that|the)?\s*/i, "");
  t = t.replace(/^'|'\.?$/g, "").replace(/^(the )?company has /i, "");
  if (!t) return company;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function basePriority(cat: Category, text: string) {
  let p = BASE[cat];
  if (cat === "management_change") {
    if (/\b(CFO|CEO|chief financial|chief executive|managing director|MD\b|whole[- ]time)/i.test(text)) p += 15;
    if (/independent director|company secretary|compliance officer/i.test(text)) p -= 35;
  }
  if (cat === "credit_rating" && /downgrad|negative|watch/i.test(text)) p += 25;
  if (cat === "results" && /investor presentation|newspaper/i.test(text)) p -= 30;
  if (cat === "litigation" && /no (material )?impact|not material/i.test(text)) p -= 25;
  return Math.max(0, Math.min(100, p));
}
