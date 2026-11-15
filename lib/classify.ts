// Rule-based classifier: maps NSE's `desc` + attachment text onto the reference
// categories and scores materiality. Free, instant, deterministic — no LLM.
// When NSE's one-liner is generic ("General Updates", "Change in Management",
// "Credit Rating", "Bagging/Receiving of orders"), the brief reads the filing's
// cover letter (subject line + body up to the sign-off) and runs the same rules on it.

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

// Base materiality, 0–100 (material = 45+). Sub-type rules in basePriority() refine it;
// the user's "care about" list adds on top in the brief.
const BASE: Record<Category, number> = {
  results: 80, "M&A": 78, management_change: 55, litigation: 72, fund_raise: 66, capex: 66,
  pledging: 64, credit_rating: 40, insider_trading: 48, press_release: 35, bonus_split: 40,
  dividend: 30, earnings_call: 22, agm_egm: 18, postal_ballot: 15, investor_meetings: 8, unclassified: 3,
};

const RULES: [Category, RegExp][] = [
  ["pledging", /pledg|encumbr/i],
  ["insider_trading", /insider trading|\bPIT\b|takeover regulation|substantial acquisition|acquisition of shares by promoter/i],
  ["credit_rating", /credit rating|rating agency|re-?affirm|\bcrisil\b|\bicra\b|care ratings|india ratings|s&p global|moody|fitch/i],
  ["fund_raise", /\bqip\b|qualified institution|issue of securities|issuance of (non|equity|shares|bonds|securities)|rights issue|preferential (issue|allotment)|commercial paper|non[- ]convertible|\bncds?\b|debentures|buy ?back|raising of funds|fund ?rais|initial public offer|\bIPO\b|red herring|offer for sale|trading in (the )?equity shares of/i],
  ["litigation", /litigation|dispute|regulatory action|penalt|show[- ]cause|orders? passed|action\(s\) (initiated|taken)|tribunal|\bnclt\b|\bnclat\b|insolvency|fine imposed|demand order|tax demand|search operation|\bCCI\b|competition commission|warning letter|import alert|form 483|halt[a-z]* .{0,40}(production|manufactur)|suspension of (production|operations|manufactur)|quality lapses|\bITAT\b|high court|supreme court|arbitra/i],
  ["management_change", /resign|appoint|change in (director|management|key managerial|senior management)|key managerial|senior management personnel|cessation|ceas(e|ed) to be|retire|superannuat|re-?designat|vacated the office|assumed charge|chief (executive|financial|operating)|\bCFO\b|\bCEO\b|managing director/i],
  ["M&A", /acquisition|acquire|amalgamation|merger|demerger|scheme of arrangement|joint venture|incorporat(ed|ion|e) (of )?(a |an )?(new )?(wholly|step[- ]down|subsidiary)|wholly owned subsidiary|\bstake\b|divest|sale or disposal|business transfer|slump sale/i],
  ["capex", /capex|capital expenditure|capacity expansion|new (plant|facility|unit)\b|greenfield|brownfield|commission(ing|ed) of|commercial production/i],
  ["bonus_split", /bonus (issue|shares)|sub-?division|stock split|split of (equity )?shares/i],
  ["dividend", /dividend|record date/i],
  ["earnings_call", /transcript|audio recording|call recording|link of recording|earnings (conference )?call|conference call/i],
  ["investor_meetings", /analyst|institutional investor|investor meet|investor conference|non-deal roadshow|one-on-one/i],
  ["agm_egm", /annual general meeting|\bAGM\b|\bEGM\b|extra-?ordinary general/i],
  ["postal_ballot", /postal ballot|e-voting/i],
  ["results", /financial results?|results for the (quarter|period)|(investor|earnings|results|analyst) presentation|interim condensed|quarterly update|performance of the company for the quarter|half yearly report/i],
  ["press_release", /press release|media (release|statement)|orders?\b|contracts?\b|\bbags\b|\bwins?\b|selects|launch|partnership|usfda|\bfda\b|approved in the u\.?s|dcgi|marketing authori[sz]ation|clarification/i],
];

// Housekeeping that never needs a human: tested on NSE's own one-liner only.
const ROUTINE = /newspaper (publication|advertisement|clipping)|newspaper clippings|certificate under|compliance certificate|regulation 74|loss of share certificate|duplicate share|trading window|\besop\b|\besos\b|\besps\b|employee stock option|stock option scheme|employee welfare trust|grant of [\d,]+ options|allotment of [\d,]+ (equity )?(shares|securities)|secretarial (audit|compliance)|\besg\b|business responsibility|redemption of commercial paper|change in auditors|statutory auditors?|auditor rotation|statement of deviation|spurt in volume|registrar and (share )?transfer agent|\bRTA\b|investor education and protection fund|\bIEPF\b|special window|re-?lodgement|strike off|struck off|guarantees? or indemnity|becoming a surety|interest payment|book closure|transfer of (equity )?shares to/i;
const NOT_ROUTINE = /acquisition|resign|appoint|preferential|qualified institution|\bqip\b|rights issue/i;
// Exchange-sought clarifications on media reports, and the company's replies.
const CLARIFY = /news verification|rumou?r verification|sought clarification|clarification (regarding|on|with respect to) (the )?(news|media|article)|news (report|item|article)/i;

const RESULTS_ENCLOSED = /(?:un)?audited[^.]{0,80}financial results?|financial results? for the (?:quarter|period|half|year|first|second|third|fourth)/i;

// A listed parent or subsidiary publishing ITS numbers ("Reference to the Financial Results issued
// by Suzuki Motor Corporation") is not this company's results: no results card, routine priority.
const OTHERS_RESULTS = /results? (?:issued|announced|declared|published|released|reported) by\b|results? of (?:its |the |our )?(?:holding|parent|promoter|ultimate holding|subsidiar|associate|joint venture)/i;

const firstRule = (s: string) => RULES.find(([, re]) => re.test(s))?.[0];
const MATERIAL_CATS = new Set<Category>(["results", "M&A", "fund_raise", "management_change", "litigation", "capex", "pledging", "credit_rating"]);

export function classify(desc: string, text: string, doc = ""): Category {
  const head = `${desc} :: ${text}`;
  // Exchange-provided descriptors for clear-cut cases first.
  if (/^copy of newspaper/i.test(desc)) return "unclassified";
  if (OTHERS_RESULTS.test(head) && !/^(financial result|outcome of board meeting)/i.test(desc)) return "press_release";
  if (CLARIFY.test(head)) {
    const c = firstRule(text.replace(/clarification|news verification|rumou?r verification/gi, "")) ?? (doc ? firstRule(doc) : undefined);
    return c && MATERIAL_CATS.has(c) ? c : "press_release";
  }
  if (/^analysts\/institutional/i.test(desc)) {
    if (/presentation/i.test(text) && !/schedule|intimation/i.test(text)) return "results";
    return /transcript|recording|earnings call|conference call|results/i.test(text) ? "earnings_call" : "investor_meetings";
  }
  // A board-meeting outcome is the results filing when NSE's line — or, failing that, the letter
  // itself — says the financial results are enclosed (Trent's line is just "Outcome of Board Meeting").
  if (/^outcome of board meeting/i.test(desc) && (/financial result/i.test(text) || RESULTS_ENCLOSED.test(doc.slice(0, 1500)))) return "results";
  if (/^financial result/i.test(desc)) return "results";
  if (ROUTINE.test(head) && !NOT_ROUTINE.test(desc)) return "unclassified";
  const c = firstRule(head);
  // A vague exchange descriptor with a vague one-liner: the letter decides.
  const vague = VAGUE_DESC.test(desc) && isGeneric(desc, cleanSummary(text, ""));
  if (c && !(vague && doc)) return c;
  if (doc) {
    const lead = stripBoilerplate(doc.slice(0, 1200)).slice(0, 700);
    if (ROUTINE.test(lead) && !NOT_ROUTINE.test(lead)) return "unclassified";
    const clean = doc.replace(DEBARRED, " ");
    const first = earliestRule(clean);
    // "Chairman and Managing Director Shri X welcomed…" names a title; it is not a change of one.
    if (first === "management_change" && !sentences(clean).some((x) => CHANGE_VERB.test(x) && roleTier(x))) return earliestRule(clean, "management_change") ?? c ?? "unclassified";
    return first ?? c ?? "unclassified";
  }
  return c ?? "unclassified";
}

const VAGUE_DESC = /^(general updates?|updates?|issue of securities|other restructuring|outcome of board meeting|disclosure|intimation)/i;

// Director appointments carry "not debarred ... by virtue of any order passed by SEBI" — not litigation.
const DEBARRED = /not debarred[^.]{0,240}\./gi;
// In a letter, what is said first is what the letter is about.
function earliestRule(s: string, skip?: Category): Category | undefined {
  let best: { c: Category; at: number } | undefined;
  for (const [c, re] of RULES) {
    if (c === "press_release" || c === skip) continue; // press release: its words ("order", "contract") appear in everything
    const m = re.exec(s);
    if (m && (!best || m.index < best.at)) best = { c, at: m.index };
  }
  return best?.c ?? (RULES.find(([c]) => c === "press_release")![1].test(s) ? "press_release" : undefined);
}

// ---------- text helpers ----------

// "Disclosure under Regulation 30 of the SEBI (LODR) Regulations, 2015 – X" -> "X"
export function stripBoilerplate(s: string) {
  return (s || "")
    .replace(/(?:(?:intimation|disclosure|submission|information)s?\s+)?(?:under|pursuant to|in terms of|as per)\s+(?:the\s+)?(?:provisions of\s+)?regulations?\s*\d+[\s\S]{0,260}?2015\s*(?:\([^)]{0,80}\))?/gi, " ")
    .replace(/(?:pursuant to|in terms of|as per)\s+(?:the\s+)?(?:provisions of\s+)?regulations?\s*\d+[\s\S]{0,200}?(?:listing regulations|LODR(?: regulations)?|regulations,? 2015)[”"’)]*\s*(?:\([^)]{0,80}\))?\s*,?/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-–—:.,;/]+|[\s\-–—:.,;/]+$/g, "")
    .trim();
}

const tidy = (s: string, max = 240) => {
  let t = stripBoilerplate(s)
    .replace(/\((?:DIN|PAN|ICAI|Membership)[^)]{0,60}\)/gi, "")
    .replace(/\(\s*[“"‘'][^)]{1,40}[”"’']\s*\)/g, "")
    .replace(/^(?:we (?:further |hereby )?(?:wish to |would like to )?inform(?: you)?(?: that)?|this is to (?:further )?inform(?: you)?(?: that)?|we hereby inform(?: you)?(?: that)?|further,?|in continuation (?:to|of) [^,]{0,120},|further to [^,]{0,120},|in furtherance (?:to|of) [^,]{0,120},|pursuant to [^,]{0,160},)\s*/i, "")
    .replace(/\s+([,.;])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  for (let i = 0; i < 3; i++)
    t = t
      .replace(/^(?:dear\s+)?(?:sirs?|madam)(?:\s*\/\s*(?:sirs?|madam))?\s*[,:]+\s*/i, "")
      .replace(/^we refer to [\s\S]{0,140}?,\s*(?:wherein|whereby) it was (?:informed|intimated) that\s*/i, "")
      .replace(/^read with [\s\S]{0,220}?regulations?[”"’)]*\s*,\s*/i, "")
      .replace(/^(?:based on|on) the recommendations? of (?:the )?[\s\S]{0,140}?committees?\s*(?:\([^)]*\))?\s*,\s*/i, "")
      .replace(/^the board of directors(?: of the (?:company|bank))?(?: \([^)]*\))?,? at (?:its|their) meeting held (?:today|on [A-Za-z0-9 ]{3,30}(?:, \d{4})?)(?:,? i\.e\.,? [A-Za-z0-9 ]{3,30}(?:, \d{4})?)?,?\s*(?:inter alia,\s*)?/i, "")
      .replace(/^(?:has|have|had)\s+(?:inter alia,?\s+)?(?:considered and\s+)?approved\s+(?:the\s+)?/i, "")
      .replace(/^(?:we (?:further |hereby )?(?:wish to |would like to )?(?:inform|submit)(?: you)?(?: that)?|this is to (?:further )?inform(?: you)?(?: that)?|you are kindly informed that|we hereby submit (?:a )?disclosure in connection with)\s*/i, "")
      .replace(/^[,;:.\s]+/, "");
  if (t.length > max) t = t.slice(0, max).replace(/\s+\S*$/, "") + "…";
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
};

// "Titan Company Limited has informed the Exchange about X" -> "X"
export function cleanSummary(text: string, company: string) {
  let t = (text || "").replace(/\s+/g, " ").trim();
  t = t.replace(/^.*?has (informed|submitted to) the Exchange(,)? (about|regarding|that|the)?\s*/i, "");
  t = t.replace(/^'|'\.?$/g, "").replace(/^(the )?company has /i, "");
  // "A press release dated 1 Nov, titled "X"." -> "X"
  const titled = t.match(/^a press release dated [^,]+, titled\s*["“](.+?)["”]\.?$/i);
  if (titled) t = titled[1];
  t = stripBoilerplate(t) || t;
  if (!t) return company;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

const GENERIC = /^(general updates?|updates?|change in (management|director\(s\)( of the company)?|directors?)|resignation( of director\/kmp\/smp| of director of the company)?|appointment|retirement|credit rating|bagging\/receiving of orders\/contracts|action\(s\) (initiated|taken) or orders passed|other restructuring|acquisition|corporate insolvency resolution process|outcome of (the )?board meeting( held .{0,60})?|press release|a press release dated [^,]{4,30}\.?|intimation|disclosure|issue of securities|media statement|please find attached a media statement issued by the company)\.?$/i;
export function isGeneric(desc: string, summary: string) {
  const s = stripBoilerplate(summary).replace(/\s+/g, " ").trim();
  return s.length < 12 || GENERIC.test(s) || s.toLowerCase() === desc.toLowerCase().trim();
}

// The cover letter of a filing: subject line + body up to the sign-off (signature
// blocks carry titles like "President & Company Secretary" that would confuse the rules),
// plus the annexure after it (SEBI's Schedule III details: authority, amount, impact).
export type Letter = { subject: string; body: string; annex: string };
const SUBJECT = /\b(?:sub(?:ject|iect)?|re|ref)\s*\.?\s*:\s*/i;
const OPENER = /\b(?:Dear|DEAR|Respected|Ref\s*[.:]|Pursuant|PURSUANT|In continuation|In furtherance|Further to|With reference|As required|This is|We |The (?:letter|Board|Company|Bank|said|Hon)|Please find|Kindly|You are)/;
const SIGN_OFF = /\b(thanking you|yours (?:faithfully|sincerely|truly)|kindly take (?:the same|this|it|note)|you are (?:kindly )?requested to|we request you|request you to (?:kindly )?take|this is for (?:your )?(?:kind )?(?:information|records?)|please take (?:the same|note)|for and on behalf of)\b/i;
const SALUTE = /^\s*(?:dear\s+)?(?:sirs?|madam)(?:\s*\/\s*(?:sirs?|madam))?\s*[,:]+\s*/i;

function split(t: string): { body: string; annex: string } {
  const cut = t.search(SIGN_OFF);
  // Sign-off right at the start: the letter says nothing itself ("A media statement is attached"
  // sits in the subject line), and what follows is the signature block and the enclosure.
  if (cut >= 0) return { body: t.slice(0, cut).trim(), annex: t.slice(cut).slice(0, 3000) };
  return { body: t.slice(0, 3000).trim(), annex: "" };
}

export function letter(doc: string): Letter {
  const t = (doc || "").replace(/\s+/g, " ").slice(0, 12000);
  const m = SUBJECT.exec(t.slice(0, 2500));
  if (m) {
    const rest = t.slice(m.index + m[0].length);
    const ends = [rest.slice(8).search(OPENER), rest.slice(8).search(SIGN_OFF)].filter((x) => x >= 0).map((x) => x + 8);
    const end = ends.length ? Math.min(...ends, 360) : 240;
    const subject = rest.slice(0, end).trim();
    return { subject, ...split(rest.slice(end).replace(SALUTE, "")) };
  }
  // No "Sub:" line: start after the salutation or the exchange codes in the address block.
  let start = t.slice(0, 2500).search(/\b(?:dear sirs?|dear madam|sir\s*\/\s*madam)\b/i);
  if (start < 0) {
    const codes = [...t.slice(0, 2500).matchAll(/\b(?:scrip|stock|nse|bse)\s*(?:code|symbol)\s*[:\-]?\s*[A-Z0-9&-]+/gi)];
    start = codes.length ? codes[codes.length - 1].index! + codes[codes.length - 1][0].length : 0;
  }
  return { subject: "", ...split(t.slice(start).replace(SALUTE, "")) };
}

export function sentences(body: string): string[] {
  const DOT = "․";
  const t = body
    .replace(/\b(Mr|Ms|Mrs|Dr|Smt|Shri|Sh|No|Nos|Rs|Ltd|Pvt|Co|Inc|viz|i\.e|e\.g|w\.e\.f|vs|St|Jr|Sr|Hon'ble|M\/s)\./gi, `$1${DOT}`)
    .replace(/\b([A-Z])\.(?=\s?[A-Z])/g, `$1${DOT}`);
  return t
    .split(/[.;]\s+(?=[A-Z0-9“"(•])|\s•\s|\s(?=\d{1,2}\.\s+[A-Z])|\s(?=[ivx]{1,4}\.\s+[A-Z])/)
    .map((s) => s.split(DOT).join(".").trim())
    .filter((s) => s.length > 20);
}

// ---------- management change: who, and how senior ----------
type Tier = "top" | "chair" | "exec" | "ned" | "smp" | "id";
const TIER_P: Record<Tier, number> = { top: 85, chair: 75, exec: 72, ned: 52, smp: 32, id: 28 };
const CHANGE_VERB = /appoint|resign|ceas|cessation|retire|superannuat|vacat|assum|elevat|designat|step(?:ped|s)? down|demise|joins?|induct/i;

export function roleTier(s: string): Tier | undefined {
  const t = s.replace(/non[-\s]{0,2}executive/gi, "nonexec");
  const hits: Tier[] = [];
  if (/\b(managing director|md\s*(?:&|and)\s*ceo|chief executive|ceo|chief financial|cfo|chief operating officer|coo|deputy managing director|joint managing director)\b/i.test(t)) hits.push("top");
  if (/\b(chairman|chairperson|chairwoman|vice[- ]?chair(?:man|person)?)\b(?!\s+of\s+the\s+[a-z ,&]{0,40}committee)/i.test(t)) hits.push("chair");
  if (/\b(whole[- ]?time director|executive director)\b/i.test(t)) hits.push("exec");
  if (/\bnonexec[\s,]{0,3}(?:non[-\s]{0,2}independent\s+)?director\b|\bnominee director\b|\bnon[-\s]{0,2}independent director\b/i.test(t)) hits.push("ned");
  if (/\bindependent director\b/i.test(t)) hits.push("id");
  if (/senior management|key managerial|\bkmp\b|\bsmp\b|company secretary|compliance officer|chief [a-z&\- ]{2,40}officer|\bhead\b|vice president|\bsvp\b|\bevp\b|\bpresident\b|general manager/i.test(t) || /\bC[A-Z]{1,3}O\b/.test(t)) hits.push("smp");
  return hits.sort((a, b) => TIER_P[b] - TIER_P[a])[0];
}

function mgmtPriority(s: string) {
  const tier = roleTier(s);
  let p = tier ? TIER_P[tier] : BASE.management_change;
  if (tier === "id" && /resign|ceas|cessation/i.test(s)) p = 40; // an independent director leaving mid-term is a governance signal
  if (tier === "id" && /completion of (?:his |her |their )?(?:term|tenure)|retire/i.test(s)) p = 20;
  if (/re-?appoint|re-?designat|continuation of (?:his|her|their) (?:term|appointment)/i.test(s)) p -= 15;
  return { tier, p };
}

// The sentence of a management-change letter that names the most senior change.
const NAMED = /\b(?:Mr|Ms|Mrs|Dr|Shri|Smt)\.?\s+[A-Z]/;
// A follow-up that only records the shareholders' approval of an already-announced appointment.
const FOLLOW_UP = /shareholders?['’]? approval for|approval of (?:the )?shareholders (?:has been|was) (?:received|obtained)|shareholders (?:have|has) approved/i;
function bestRoleLine(L: Letter): { line: string; tier?: Tier; p: number; score: number } | undefined {
  let best: { line: string; tier?: Tier; p: number; score: number } | undefined;
  for (const s of [L.subject, ...sentences(L.body)].filter(Boolean)) {
    if (!CHANGE_VERB.test(s)) continue;
    const r = mgmtPriority(s);
    if (!r.tier) continue;
    const score = r.p + (NAMED.test(s) ? 0.5 : 0);
    if (!best || score > best.score) best = { line: s, tier: r.tier, p: r.p, score };
  }
  return best;
}

const INFORMATIVE = /inform|approv|receiv|impos|passed|\bwins?\b|bag|award|assign|re-?affirm|incorporat|complet|order|entered|sign|acquir|launch|announce|redeem|levy|penalt|commence|resign|appoint|filed|finalised|allotted|declared/i;
// SEBI Schedule III (Para A, item 20) annexure: authority / action / details / impact, as filed.
// Fields are located by their labels (OCR'd filings often lose the row numbers).
const ACTION_FIELDS: [string, RegExp][] = [
  ["who", /name of the (?:regulatory or licensing )?authority/i],
  ["nature", /nature and details of the action\(?s?\)?[\s\S]{0,40}?passed/i],
  ["date", /date of receipt of (?:direction or )?order(?:[^A-Z0-9]{0,160}?authority)?/i],
  ["details", /details of the violation\(?s?\)?[\s\S]{0,60}?committed(?: or alleged to be committed)?/i],
  ["impact", /impact on financial[\s\S]{0,140}?(?:possible|terms)/i],
];
function actionDetails(annex: string): string | undefined {
  const at = ACTION_FIELDS.map(([k, re]) => {
    const m = re.exec(annex);
    return m ? { k, start: m.index, end: m.index + m[0].length } : null;
  }).filter((x): x is { k: string; start: number; end: number } => !!x).sort((a, b) => a.start - b.start);
  const f: Record<string, string> = {};
  at.forEach((x, i) => {
    f[x.k] = annex.slice(x.end, at[i + 1]?.start ?? x.end + 300).replace(/^[\s:.\-–]+|\s+\d{1,2}\s*[.)]?\s*$/g, "").replace(/\s+/g, " ").trim().slice(0, 260);
  });
  if (!f.nature) return undefined;
  const who = f.who ? f.who.replace(/\s*\([A-Z]{2,8}\)$/, "") + ": " : "";
  const detail = f.details && /(?:rs\.?|₹|inr)\s*[\d,]/i.test(f.details) ? ` — ${f.details}` : f.details && f.details.length < 140 ? ` — ${f.details}` : "";
  return tidy(`${who}${f.nature}${detail}`, 260);
}

function docSummary(L: Letter, cat: Category): string | undefined {
  if (cat === "litigation") {
    const d = actionDetails(L.annex);
    if (d) return d;
  }
  const subj = stripBoilerplate(L.subject).replace(/^(?:intimation|disclosure|information)\s+(?:of|regarding|about|on)\s+/i, "");
  if (subj.length >= 12 && !GENERIC.test(subj) && !/^(outcome of (the )?board meeting|intimation|disclosure|media statement)\b/i.test(subj)) return tidy(subj);
  const pick = (t: string) => sentences(t).map(stripBoilerplate).find((x) => x.length > 30 && INFORMATIVE.test(x) && !/is attached|enclosed herewith|find (?:enclosed|attached)|for (?:your )?(?:information|records?)|hosted on the website|available on the website|digitally signed|yours (?:faithfully|sincerely|truly)|thanking you|company secretary|compliance officer|membership no|regd\.? office|\bCIN\b|copy to/i.test(x));
  const s = pick(L.body) ?? (cat === "press_release" ? pick(L.annex) : undefined);
  return s ? tidy(s) : subj.length >= 12 ? tidy(subj) : undefined;
}

// ---------- materiality ----------
// First rupee amount in the text, in crore ("Rs. 10,00,000/-", "₹1,119", "Rs. 130,000 million").
const crore = (s: string) => {
  const m = s.match(/(?:\brs\.?|₹|\binr)\s*([\d,]+(?:\.\d+)?)\s*\/?-?\s*(crores?|cr\b|lakhs?|lacs?|millions?|mn\b|billions?|bn\b)?/i);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const u = (m[2] || "").toLowerCase();
  return u.startsWith("cr") ? n : u.startsWith("la") ? n / 100 : u.startsWith("m") ? n / 10 : u.startsWith("b") ? n * 100 : n / 1e7;
};

export function basePriority(cat: Category, text: string) {
  let p = BASE[cat];
  const t = text;
  switch (cat) {
    case "management_change":
      p = mgmtPriority(t).p;
      break;
    case "results":
      if (/(investor|earnings|results|analyst) presentation|interim condensed|half yearly report|presentation/i.test(t)) p = 50;
      if (/newspaper/i.test(t)) p = 3;
      break;
    case "credit_rating":
      if (/downgrad|negative|watch|withdraw|default|suspend/i.test(t)) p = 75;
      else if (/upgrad|positive/i.test(t)) p = 55;
      else if (/re-?affirm|assign|retain|stable|AAA/i.test(t)) p = 22;
      break;
    case "litigation": {
      const amt = crore(t);
      if (/no (?:material |major |significant )?(?:financial )?(?:impact|implication)|not material|no material|not have any material|does not concern any new/i.test(t)) p -= 30;
      if (/hearing (?:adjourned|not taken up|listed|reserved|scheduled)|next date of hearing|reserved (?:the matter )?for order|early listing|will not be taken up|listed for hearing|matter was adjourned/i.test(t)) p = Math.min(p, 30);
      if (/\b(ITAT|income tax|GST|goods and services tax|tax demand|assessment order|customs)\b/i.test(t)) p = amt != null && amt >= 100 ? 60 : Math.min(p, 30);
      if (/penalt/i.test(t) && amt != null && amt < 10) p = Math.min(p, amt < 1 ? 30 : 45);
      if (/sought clarification|response from the company is awaited/i.test(t)) p = Math.min(p, 38);
      if (/set aside|allowed the appeal|stay(ed)? the order|admitted/i.test(t) && /nclt|nclat|insolvency/i.test(t) && !/\b(ITAT|income tax|GST)\b/i.test(t)) p = Math.max(p, 72);
      break;
    }
    case "M&A":
      if (/incorporat/i.test(t) && /subsidiary|\bWOS\b/i.test(t) && !/acqui(?:red|sition of) (?:\d|a |an |the )?(?:stake|shares|equity|business|company|controlling)/i.test(t)) p = 25;
      else if (/extension of (?:the )?(?:timeline|long stop date)|revised timeline/i.test(t)) p = 25;
      else if (/completion of (?:the )?acquisition|completed the acquisition/i.test(t)) p = 66;
      else if (/binding term sheet|definitive agreement|share purchase agreement|scheme of (?:amalgamation|arrangement)|merger/i.test(t)) p = 82;
      break;
    case "fund_raise":
      if (/initial public offer|\bIPO\b|red herring|trading in (?:the )?equity shares of|listing of (?:equity )?shares/i.test(t)) p = 80;
      else if (/\bqip\b|qualified institution|rights issue|preferential/i.test(t)) p = 70;
      else if (/commercial paper|non[- ]convertible|\bncds?\b|debentures|bonds|enabling resolution/i.test(t)) p = 25;
      break;
    case "press_release":
      if (OTHERS_RESULTS.test(t)) p = 20;
      else if (/ultra[- ]?mega/i.test(t)) p = 70;
      else if (/\bmega\b/i.test(t)) p = 66;
      else if (/\(\s*\*?\s*major\s*\*?\s*\)|\bmajor\*/i.test(t)) p = 58;
      else if (/\(\s*\*?\s*large\s*\*?\s*\)|\blarge\*/i.test(t)) p = 48;
      else if (/\(\s*\*?\s*significant\s*\*?\s*\)|significant\*/i.test(t)) p = 40;
      else if (/usfda|\bfda\b|approved in the u\.?s|dcgi|\bema\b|marketing authori[sz]ation/i.test(t)) p = 50;
      else if (/great place to work|award|certification|certified|recogni[sz]ed|celebrat|\bcsr\b|edition|\bstudy\b|survey|webinar|felicitat|ranked|portfolio of \d|brandscape/i.test(t)) p = 12;
      else if (/sales in|production (?:volume|in)|business update|operational update/i.test(t)) p = 30;
      else if (/selects|\bwins?\b|\bbags\b|orders?\b|contracts?\b|award(?:ed)?/i.test(t)) p = 38;
      else if (/launch|introduces|unveil/i.test(t)) p = 22;
      else if (/media statement/i.test(t)) p = 25;
      if (CLARIFY.test(t)) p = /not aware|does not concern|no (?:material|new)|baseless|speculative|denies/i.test(t) ? 25 : 35;
      break;
    case "earnings_call":
      p = /transcript/i.test(t) ? 24 : /recording|link/i.test(t) ? 14 : 12;
      break;
    case "agm_egm":
    case "postal_ballot":
      if (/voting results|scrutini[sz]er/i.test(t)) p = 12;
      break;
    case "dividend":
      if (/special dividend/i.test(t)) p = 45;
      break;
  }
  if (CLARIFY.test(t) && MATERIAL_CATS.has(cat) && cat !== "management_change") {
    // A media report the exchange asked about. Unverified until the company replies;
    // a reply that says "nothing new / not material" stays below the fold for most users.
    p = /not aware|does not concern any new|no (?:material|new) (?:event|development)|baseless|speculative|denies/i.test(t) ? 36 : Math.min(p, 40);
  }
  return Math.max(0, Math.min(100, Math.round(p)));
}

// ---------- one call for the brief ----------
export type Assessment = { category: Category; priority: number; summary: string; readFiling: boolean };

export function assess(desc: string, text: string, company: string, doc?: string): Assessment {
  const head = `${desc} :: ${text}`;
  const summary0 = cleanSummary(text, company);
  const L = doc ? letter(doc) : undefined;
  const lt = L ? `${L.subject} :: ${L.body}` : "";
  const category = classify(desc, text, lt);
  let summary = summary0;
  let ptext = head;
  let followUp = 0;
  if (category === "management_change") {
    const headTier = roleTier(head);
    const best = L ? bestRoleLine(L) : undefined;
    if (headTier) {
      // Keep NSE's own line when it already names the person; otherwise the letter's sentence is more specific.
      if (best && best.tier === headTier && (isGeneric(desc, summary0) || !NAMED.test(summary0))) summary = tidy(best.line);
    } else if (best) {
      ptext = `${head} :: ${best.line}`;
      summary = tidy(best.line);
    }
    // Shareholders approving an appointment announced months ago is a formality.
    if (FOLLOW_UP.test(`${head} ${L?.subject ?? ""}`)) followUp = 25;
  } else if (L && category !== "results") {
    // Results paperwork is scored on NSE's line alone (board outcomes quote "newspaper" etc.).
    ptext = `${head} :: ${L.subject} :: ${L.body.slice(0, 1500)} :: ${L.annex.slice(0, 3000)}`;
    if (isGeneric(desc, summary0)) summary = docSummary(L, category) ?? summary0;
    else if (category === "litigation") summary = actionDetails(L.annex) ?? summary0;
  } else if (L && isGeneric(desc, summary0)) {
    // Results whose NSE line is just "Outcome of Board Meeting": say what the letter encloses.
    const m = category === "results" ? `${L.subject} ${L.body}`.match(/((?:un)?audited[^.;]{0,70}financial results?[^.;]{0,70}?ended (?:on )?[^.,;]{4,24}\d{4})/i) : null;
    summary = m ? tidy(m[1]) : docSummary(L, category) ?? summary0;
  }
  const base = basePriority(category, ptext);
  const priority = followUp ? Math.max(base - followUp, Math.min(base, 20)) : base;
  return { category, priority, summary: summary || company, readFiling: !!L };
}

// Worth opening the PDF for? Only when NSE's one-liner can't tell us what happened,
// or when the sub-type (role, rating action, order size, penalty) changes materiality.
export function needsFiling(desc: string, text: string, cat: Category) {
  if (/^copy of newspaper/i.test(desc)) return false;
  if (["earnings_call", "investor_meetings", "agm_egm", "postal_ballot", "dividend"].includes(cat)) return false;
  const head = `${desc} :: ${text}`;
  if (cat === "unclassified" && ROUTINE.test(head)) return false;
  if (cat === "results") return false; // paperwork: the results card carries the numbers
  return isGeneric(desc, cleanSummary(text, "")) || CLARIFY.test(head) ||
    ["management_change", "credit_rating", "litigation"].includes(cat) ||
    (cat === "press_release" && /orders?|contracts?/i.test(head)) ||
    (cat === "M&A" && /acquisition/i.test(desc) && !/incorporat/i.test(text));
}
