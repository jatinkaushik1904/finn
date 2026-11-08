import { promises as fs } from "fs";
import path from "path";
import { Company, PORTFOLIO } from "@/data/universe";
import { CONTACTS } from "@/data/network";
import { announcements, eod, pdfText, pool, Bar, RawAnn } from "./nse";
import { assess, CATEGORY_LABEL, Category, classify, isGeneric, needsFiling, sentences } from "./classify";
import { fundamentals, headline, Headline } from "./screener";
import { investorOverlap, leadsForCompany, monthsSince, orgsInText, overlapsForPerson, PersonProfile, resolveOrg } from "./network";
import { llmJSON } from "./llm";
import { cached, hash } from "./cache";

// The PUSH pipeline. Two layers:
//   core    — everything that costs network/LLM time: fetch filings + EOD bars, read the
//             cover letter of filings whose one-liner is vague, classify, fold duplicates,
//             enrich (results table, people, who-to-call). Cached 10 min per window.
//   overlay — everything that depends on the user's settings: price/volume alerts from the
//             bars, "types you track" boost, ranking, stats. Pure and instant, so moving a
//             slider never re-fetches anything — and it runs identically on a snapshot.

export type Settings = { hours: number; volX: number; movePct: number; cares: Category[] };
export const DEFAULT_SETTINGS: Settings = { hours: 24, volX: 2, movePct: 4, cares: ["results", "M&A", "management_change", "litigation"] };

export type LeadLite = { id: string; name: string; headline: string; why: string; via?: string; score: number; ask?: string };
export type Related = { id: string; time: string; label: string; summary: string; url: string };
export type Item = {
  id: string; symbol: string; company: string; time: string; category: Category; label: string;
  priority: number; summary: string; url: string; desc: string;
  results?: Headline & { source: string };
  person?: {
    name: string; role?: string; profile: PersonProfile; bio?: string;
    overlaps: { id: string; name: string; kind: string; why: string; strength: number }[];
    you?: string | null; extractedBy: string; direction?: "joining" | "leaving";
  };
  leads?: LeadLite[];
  signals?: string[];
  base?: number; // materiality before the user's settings (types tracked, unusual moves)
  related?: Related[]; // filings folded into this card: same paperwork, same matter
  collapsedInto?: string; // set on a folded filing (kept for completeness, ranked as routine)
  readFiling?: boolean; // classified from the filing's own cover letter, not just NSE's one-liner
  source?: "live" | "snapshot";
};
export type Alert = {
  symbol: string; company: string; kind: "volume" | "price"; text: string; date: string; value: number;
  threshold?: number; sessions?: number; source?: "live" | "snapshot";
};
export type Nudge = { id: string; name: string; months: number; reason: string; symbol: string };
export type Brief = {
  generatedAt: string; settings: Settings; items: Item[]; alerts: Alert[]; nudges: Nudge[];
  stats: { total: number; material: number; routine: number; companies: number; filingsRead?: number };
  source: "live" | "snapshot" | "live+snapshot";
  quietHint?: string;
  market?: { lastSession?: string; skipped?: { date: string; reason: string }[] };
  coverage?: { live: number; fromSnapshot: string[]; missing: string[] };
  timings?: Record<string, number>;
};

const MATERIAL = 45;
const CARES_BOOST = 12;
const MOVED_BOOST = 8;
const EOD_DAYS = 80; // ~55 sessions: a full 20-session baseline even for the first day of a 30-day window
const IST = 5.5 * 3600_000;
const T = { fetch: 22_000, filings: 34_000, enrich: 46_000, hard: 52_000 }; // ms from start; Vercel cap is 60s

const parseDate = (s: string) => new Date(s.replace(" ", "T") + "+05:30");
const istDay = (d: Date) => new Date(d.getTime() + IST).toISOString().slice(0, 10);
const dayLabel = (iso: string) =>
  new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).replace(",", "");
const until = (deadline: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, deadline - Date.now())));
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// ---------------------------------------------------------------- price / volume alerts

type Session = Bar & { special?: string };

// Flag sessions that aren't normal trading days: weekend specials (Diwali Muhurat trading)
// or anything trading a sliver of normal volume. They are excluded from both the alerts and
// the volume baseline, so a 1-hour Sunday session can neither trigger nor hide an alert.
export function sessions(bars: Bar[]): Session[] {
  const sorted = bars.filter((b) => b.volume > 0 && b.prev > 0 && Number.isFinite(b.close)).sort((a, b) => a.date.localeCompare(b.date));
  const regular: Bar[] = [];
  return sorted.map((b) => {
    const base = regular.slice(-20).map((x) => x.volume).sort((x, y) => x - y);
    const med = base.length ? base[Math.floor(base.length / 2)] : 0;
    const weekend = [0, 6].includes(new Date(b.date + "T00:00:00Z").getUTCDay());
    let special: string | undefined;
    if (base.length >= 10 && b.volume < (weekend ? 0.5 : 0.25) * med)
      special = `${weekend ? "Special weekend session (e.g. Muhurat trading)" : "Abnormally thin session"}, ${Math.round((b.volume / med) * 100)}% of normal volume`;
    if (!special) regular.push(b);
    return { ...b, special };
  });
}

// Every regular session inside the window (always at least the latest one) is tested;
// one alert per symbol and kind, keeping the strongest, with the count of sessions that hit.
export function priceAlerts(symbol: string, company: string, bars: Bar[], s: Settings, fromDay: string): Alert[] {
  const regular = sessions(bars).filter((b) => !b.special);
  if (regular.length < 11) return [];
  const last = regular[regular.length - 1];
  const best: { price?: Alert; volume?: Alert } = {};
  const hits = { price: 0, volume: 0 };
  regular.forEach((b, i) => {
    if (b.date < fromDay && b !== last) return;
    const prior = regular.slice(Math.max(0, i - 20), i);
    if (prior.length < 10) return;
    const avg = prior.reduce((a, x) => a + x.volume, 0) / prior.length;
    const chg = ((b.close - b.prev) / b.prev) * 100;
    const vx = b.volume / avg;
    if (Math.abs(chg) >= s.movePct) {
      hits.price++;
      if (!best.price || Math.abs(chg) > Math.abs(best.price.value))
        best.price = { symbol, company, kind: "price", date: b.date, value: Math.round(chg * 100) / 100, threshold: s.movePct, text: "" };
    }
    if (vx >= s.volX) {
      hits.volume++;
      if (!best.volume || vx > best.volume.value)
        best.volume = { symbol, company, kind: "volume", date: b.date, value: Math.round(vx * 100) / 100, threshold: s.volX, text: "" };
    }
  });
  const out: Alert[] = [];
  if (best.price) {
    const a = best.price;
    a.sessions = hits.price;
    a.text = `${a.value > 0 ? "+" : ""}${a.value.toFixed(1)}% on ${dayLabel(a.date)}${hits.price > 1 ? ` · ${hits.price} sessions beyond ±${s.movePct}%` : ` (threshold ±${s.movePct}%)`}`;
    out.push(a);
  }
  if (best.volume) {
    const a = best.volume;
    a.sessions = hits.volume;
    a.text = `Volume ${a.value.toFixed(1)}× its 20-session average on ${dayLabel(a.date)}${hits.volume > 1 ? ` · ${hits.volume} sessions above ${s.volX}×` : ""}`;
    out.push(a);
  }
  return out;
}

function marketNote(bars: Record<string, Bar[]>): Brief["market"] {
  const lasts = new Map<string, number>();
  const skipped = new Map<string, { n: number; reason: string }>();
  const series = Object.values(bars).filter((b) => b.length);
  for (const b of series) {
    const ss = sessions(b);
    const reg = ss.filter((x) => !x.special);
    if (reg.length) lasts.set(reg[reg.length - 1].date, (lasts.get(reg[reg.length - 1].date) ?? 0) + 1);
    for (const x of ss.slice(-10)) if (x.special) skipped.set(x.date, { n: (skipped.get(x.date)?.n ?? 0) + 1, reason: x.special.replace(/, \d+% of normal volume$/, "") });
  }
  const lastSession = [...lasts.entries()].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))[0]?.[0];
  const sk = [...skipped.entries()]
    .filter(([, v]) => v.n >= series.length / 2)
    .map(([date, v]) => ({ date, reason: `${v.reason}, thin volume — excluded from alerts` }));
  return { lastSession, skipped: sk.length ? sk : undefined };
}

// ---------------------------------------------------------------- people in filings

type Extract = {
  name: string; role: string; joining_or_leaving: string; bio: string;
  employers: { org: string; role?: string; from?: number; to?: number }[];
  education: { school: string; from?: number; to?: number }[];
};
const HONORIFIC = /^(?:mr|ms|mrs|dr|shri|smt|sh|prof)\.?\s+/i;
const NOT_PERSON = /\b(llp|limited|ltd|chartered|accountants|& co|company|bank|board|committee|auditors?|trust|exchange|government)\b/i;
const NOT_EMPLOYER = /^(sebi|rbi|reserve bank|nse|bse|national stock exchange|mca|ministry|stock exchange|securities and exchange board|registrar of companies)/i;
const PERSON_SYSTEM =
  "You extract facts from Indian stock-exchange filings about management changes. Use ONLY the document text. Never add outside knowledge. If a field is absent from the document, return an empty string or an empty list.";

const cleanName = (s?: string) => (s || "").replace(HONORIFIC, "").replace(/\s*\(DIN[^)]*\)/i, "").replace(/\s+/g, " ").trim();
const plausibleName = (n: string, corpus: string) => {
  const parts = n.split(" ").filter(Boolean);
  const last = parts[parts.length - 1]?.replace(/[^A-Za-z]/g, "");
  return parts.length >= 2 && parts.length <= 5 && !NOT_PERSON.test(n) && !!last && last.length >= 2 && new RegExp(`\\b${last}\\b`, "i").test(corpus);
};
// A bio is kept only if it is (nearly) all words from the filing itself.
const grounded = (bio: string, corpus: string) => {
  const words = (bio.toLowerCase().match(/[a-z]{5,}/g) ?? []);
  if (!words.length) return false;
  const c = corpus.toLowerCase();
  return words.filter((w) => c.includes(w)).length / words.length >= 0.75;
};
const profileSection = (doc: string) => {
  const i = doc.search(/brief profile|profile of (?:the )?(?:director|appointee|mr|ms)|brief resume|background of/i);
  return i >= 0 ? doc.slice(i, i + 2000) : "";
};

// PRIVACY: the model sees only the public exchange filing (and NSE's one-line summary of it).
// Contact/network data never leaves this process — overlaps are matched locally afterwards.
async function personFromFiling(it: Item, doc: string | undefined, company: Company, deadline: number): Promise<Item["person"] | undefined> {
  const filing = (doc ?? "").replace(/\s+/g, " ").slice(0, 12000);
  const ai = filing
    ? await llmJSON<Extract>(
        "fast",
        PERSON_SYSTEM,
        `The filing line this card is about: "${it.summary}"\n\nReturn JSON {"name":"","role":"","joining_or_leaving":"joining|leaving","bio":"<=40 words, only from the document's brief profile; empty if the document has no profile","employers":[{"org":"","role":"","from":null,"to":null}],"education":[{"school":"","from":null,"to":null}]} for the person that line is about (if several, the most senior). Employers and education only as stated in the document.\n\nDOCUMENT:\n${filing}`,
        900,
        { timeoutMs: Math.max(3000, deadline - Date.now()) },
      )
    : null;
  const corpus = `${it.summary} ${filing}`;
  const rx = it.summary.match(/(?:Mr|Ms|Mrs|Dr|Shri|Smt)\.?\s+([A-Z][A-Za-z.'’]*(?:\s+[A-Z][A-Za-z.'’]*){1,3})/);
  const aiName = cleanName(ai?.name);
  const name = plausibleName(aiName, corpus) ? aiName : rx && plausibleName(cleanName(rx[1]), corpus) ? cleanName(rx[1]) : "";
  if (!name) return undefined;
  const usedAI = !!ai && name === aiName;
  const leaving = /leav|retir|resign|ceas|superannu|vacat|cessation/i.test(usedAI ? ai!.joining_or_leaving || it.summary : it.summary);
  const prof = profileSection(filing);
  const isCo = (org: string) => resolveOrg(org)?.symbol === company.symbol;
  let employers = (usedAI ? ai!.employers ?? [] : [])
    .filter((e) => e?.org && !NOT_EMPLOYER.test(e.org.trim()))
    .map((e) => ({ org: e.org, role: e.role || undefined, from: Number(e.from) || undefined, to: Number(e.to) || undefined }));
  if (!employers.length && prof) employers = orgsInText(prof).filter((o) => !NOT_EMPLOYER.test(o.name)).map((o) => ({ org: o.name, role: undefined, from: undefined, to: undefined }));
  // Joining: the company itself is where they are going, not shared history. Leaving: it is.
  if (leaving) { if (!employers.some((e) => isCo(e.org))) employers.push({ org: company.name, role: undefined, from: undefined, to: undefined }); }
  else employers = employers.filter((e) => !isCo(e.org));
  const education = (usedAI ? ai!.education ?? [] : [])
    .filter((e) => e?.school)
    .map((e) => ({ school: e.school, from: Number(e.from) || undefined, to: Number(e.to) || undefined }));
  if (!education.length && prof)
    for (const m of prof.match(/\b(IIT [A-Z][a-z]+|IIM [A-Z][a-z]+|XLRI|ISB|SRCC|NMIMS|BITS Pilani|ICAI|Harvard|Wharton|INSEAD|Stanford)\b/g) ?? []) education.push({ school: m, from: undefined, to: undefined });
  const role = usedAI ? ai!.role || undefined : undefined;
  const profile: PersonProfile = { name, role, employers, education };
  const overlaps = overlapsForPerson(profile, leaving ? undefined : company.name)
    .slice(0, 3)
    .map((o) => ({ id: o.contact.id, name: o.contact.name, kind: o.kind, why: o.why, strength: o.strength }));
  const bio = usedAI && ai!.bio && grounded(ai!.bio, filing) ? ai!.bio : undefined;
  return {
    name, role, profile, bio, overlaps, you: investorOverlap(profile), direction: leaving ? "leaving" : "joining",
    extractedBy: usedAI ? "LLM (fast tier) on filing PDF" : filing ? "Rules on filing PDF" : "Rules on filing summary",
  };
}

const lite = (l: ReturnType<typeof leadsForCompany>[number]): LeadLite => ({
  id: l.contact.id, name: l.contact.name, headline: l.contact.headline, why: l.why, via: l.via?.name, score: l.score,
});

// The one question worth asking this person about this filing (deterministic; no contact data
// leaves the server). Insiders get "why", peers get "are you seeing it too".
function askFor(cat: Category, relation: string, company: string): string {
  const peer = relation === "peer" || relation === "theme";
  const Q: Partial<Record<Category, [string, string]>> = {
    results: ["Was this quarter's margin move mix, pricing or one-offs — and does it repeat next quarter?", `Are you seeing the same demand and cost trend that ${company} just reported?`],
    management_change: ["Why now — and what will the new person change first?", `What's the industry read on this change at ${company}?`],
    "M&A": ["Why this deal, what are they really paying for, and who pushed for it?", `Does this deal change how ${company} competes with you?`],
    capex: ["Is there demand to fill this capacity — what payback are they underwriting?", "Is the industry adding capacity at the same time?"],
    litigation: ["How material is this really, and has it happened before?", `Has this kind of order hit others in the sector, or only ${company}?`],
    fund_raise: ["Why raise now — growth, balance sheet, or a promoter need?", "Is the sector raising money too, or is this company-specific?"],
    credit_rating: ["What is the agency worried about that the market isn't?", "Are lenders tightening on the sector?"],
    pledging: ["Why does the promoter need liquidity right now?", "Is promoter stress showing up anywhere else you know?"],
  };
  const q = Q[cat];
  return q ? q[peer ? 1 : 0] : `Anything about ${company} the filings aren't telling me?`;
}

// ---------------------------------------------------------------- folding duplicates

type Work = Item & { fp?: string; doc?: string; generic: boolean; thread?: boolean; raw: RawAnn };

const forum = (t: string) =>
  /\bCCI\b|competition commission/i.test(t) ? "competition"
  : /\b(ITAT|income tax|GST|customs|tax demand)\b/i.test(t) ? "tax"
  : /\bNCLT\b|\bNCLAT\b|insolvency|\bCIRP\b/i.test(t) ? "insolvency"
  : /\bSEBI\b.{0,40}(order|penalt)/i.test(t) ? "sebi"
  : /high court|supreme court|arbitra/i.test(t) ? "court" : undefined;
const CLARIFY = /news verification|rumou?r verification|sought clarification|clarification regarding news/i;

function keysFor(w: Work): string[] {
  const k: string[] = [];
  const t = `${w.desc} ${w.raw.attchmntText} ${w.doc?.slice(0, 1500) ?? ""}`;
  if (w.fp) k.push(`fp:${w.symbol}:${w.fp}`);
  const sum = norm(w.summary);
  if (!w.generic && sum.length > 40) k.push(`sum:${w.symbol}:${sum}`);
  if (w.category === "results") k.push(`res:${w.symbol}`);
  if (w.category === "management_change") k.push(`mgmt:${w.symbol}:${istDay(new Date(w.time))}`);
  if (CLARIFY.test(t)) { k.push(`clar:${w.symbol}`); w.thread = true; }
  else if (w.category === "litigation" && forum(t)) { k.push(`lit:${w.symbol}:${forum(t)}`); w.thread = true; }
  if (w.category === "fund_raise") {
    const m = t.match(/(?:offer|shares) of ([A-Z][A-Za-z&.]+(?: [A-Z][A-Za-z&.]+){0,2})/);
    if (m) { k.push(`ipo:${w.symbol}:${norm(m[1].replace(/\b(limited|ltd)\b/i, ""))}`); w.thread = true; }
  }
  return k;
}

function preference(w: Work) {
  let p = w.generic ? 0 : 1;
  if (w.category === "results" && /^(outcome of board meeting|financial result)/i.test(w.desc) && /financial result/i.test(w.raw.attchmntText)) p += 2;
  if (CLARIFY.test(`${w.desc} ${w.raw.attchmntText}`) && !/sought clarification/i.test(w.raw.attchmntText)) p += 2;
  return p;
}

// "Media report: “…”. Company: …" — built from the exchange's notice and the company's reply.
function clarifySummary(g: Work[]): string | undefined {
  const caption = g.map((w) => w.raw.attchmntText.match(/captioned\s+[“"]?(.+?)[”"]?\.?\s+(?:The response|$)/i)?.[1]).find(Boolean);
  const reply = g
    .map((w) => (w.doc ? sentences(w.doc.replace(/\s+/g, " ").slice(0, 6000)).find((x) => /relates to|not aware|does not concern|is not true|denies|baseless|speculative/i.test(x)) : undefined))
    .find(Boolean);
  if (!caption) return undefined;
  const r = reply ? reply.replace(/^.*?(The News Report|The news report|The said news|The article)/, "$1").replace(/\s*\(“News Report”\)/, "") : "";
  const out = `Media report: “${caption.trim()}”.${r ? ` Company: ${r}` : " Company reply awaited."}`;
  return out.length > 280 ? out.slice(0, 280).replace(/\s+\S*$/, "") + "…" : out;
}

function fold(items: Work[]) {
  const parent = items.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const owner = new Map<string, number>();
  items.forEach((w, i) => {
    for (const key of keysFor(w)) {
      const j = owner.get(key);
      if (j == null) owner.set(key, i);
      else parent[find(i)] = find(j);
    }
  });
  const groups = new Map<number, Work[]>();
  items.forEach((w, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), w]));
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const max = Math.max(...g.map((w) => w.base!));
    const thread = g.some((w) => w.thread);
    const cands = g.filter((w) => w.base! >= max - (thread ? 6 : 0));
    cands.sort((a, b) => preference(b) - preference(a) || b.base! - a.base! || b.time.localeCompare(a.time));
    const primary = cands[0];
    primary.base = max;
    if (g.some((w) => CLARIFY.test(`${w.desc} ${w.raw.attchmntText}`))) primary.summary = clarifySummary(g) ?? primary.summary;
    primary.related = g
      .filter((w) => w !== primary)
      .sort((a, b) => b.time.localeCompare(a.time))
      .map((w) => ({ id: w.id, time: w.time, label: w.label, summary: w.summary, url: w.url }));
    for (const w of g) if (w !== primary) { w.collapsedInto = primary.id; w.base = Math.min(w.base!, 20); }
  }
}

// ---------------------------------------------------------------- core (cached per window)

type Core = {
  generatedAt: string; hours: number; items: Item[]; bars: Record<string, Bar[]>;
  source: Brief["source"]; companies: number; coverage: NonNullable<Brief["coverage"]>;
  timings: Record<string, number>; filingsRead: number;
};

async function liveCore(hours: number): Promise<Core> {
  const t0 = Date.now();
  const to = new Date();
  const from = new Date(to.getTime() - Math.max(hours, 24) * 3600_000);
  const cutoff = new Date(to.getTime() - hours * 3600_000);
  const timings: Record<string, number> = {};

  // 1. Filings + EOD bars per holding (≤4 concurrent). Whatever hasn't arrived by the fetch
  //    budget is filled from the snapshot; the stragglers still land in the cache for next time.
  const got = new Map<string, { c: Company; anns: RawAnn[]; bars: Bar[] }>();
  const fetching = pool(PORTFOLIO, 4, async (c) => {
    const [anns, bars] = await Promise.all([announcements(c.symbol, from, to), eod(c.symbol, EOD_DAYS).catch(() => [] as Bar[])]);
    got.set(c.symbol, { c, anns: Array.isArray(anns) ? anns : [], bars });
  });
  await Promise.race([fetching, until(t0 + T.fetch)]);
  timings.fetch = Date.now() - t0;
  if (got.size === 0) throw new Error("NSE unreachable");
  const live = [...got.values()];

  // 2. First pass on NSE's one-liners; then read the cover letter where the one-liner is vague
  //    or the sub-type decides materiality (who exactly left, rating action, order size, penalty).
  const work: Work[] = [];
  for (const { c, anns } of live)
    for (const a of anns) {
      if (parseDate(a.sort_date) < cutoff) continue;
      const first = assess(a.desc, a.attchmntText, c.name);
      work.push({
        id: a.seq_id || `${c.symbol}-${a.sort_date}`, symbol: c.symbol, company: c.name, time: parseDate(a.sort_date).toISOString(),
        category: first.category, label: CATEGORY_LABEL[first.category], priority: first.priority, base: first.priority,
        summary: first.summary, url: a.attchmntFile, desc: a.desc, generic: isGeneric(a.desc, first.summary), raw: a, source: "live",
      });
    }
  const toRead = work
    .filter((w) => /\.pdf$/i.test(w.url) && needsFiling(w.desc, w.raw.attchmntText, classify(w.desc, w.raw.attchmntText)))
    .sort((a, b) => b.base! - a.base!)
    .slice(0, 48);
  const t1 = Date.now();
  await Promise.race([
    pool(toRead, 4, async (w) => {
      if (Date.now() > t0 + T.filings) return;
      w.doc = await pdfText(w.url, 6);
    }),
    until(t0 + T.filings),
  ]);
  timings.filings = Date.now() - t1;
  let filingsRead = 0;
  for (const w of work) {
    if (!w.doc) continue;
    filingsRead++;
    const r = assess(w.desc, w.raw.attchmntText, w.company, w.doc);
    Object.assign(w, { category: r.category, label: CATEGORY_LABEL[r.category], base: r.priority, priority: r.priority, summary: r.summary, readFiling: true });
    w.generic = isGeneric(w.desc, r.summary);
    w.fp = hash(w.doc.replace(/\s+/g, " ").slice(0, 4000));
  }

  // 3. Fold results paperwork, duplicate uploads and same-matter threads into one card each.
  fold(work);

  // 4. Enrich only what could be material under some setting. Cheap → expensive, in parallel,
  //    each capped by the deadline (late answers still warm the cache).
  const t2 = Date.now();
  const could = work.filter((w) => !w.collapsedInto && w.base! + CARES_BOOST + MOVED_BOOST >= MATERIAL);
  for (const w of could) {
    const company = PORTFOLIO.find((c) => c.symbol === w.symbol)!;
    const leads = leadsForCompany(company, w.summary);
    if (!leads.length) continue;
    const n = ["M&A", "capex", "litigation", "management_change", "fund_raise"].includes(w.category) ? 2 : 1;
    w.leads = leads.slice(0, n).map((l, i) => ({ ...lite(l), ...(i === 0 ? { ask: askFor(w.category, l.relation, company.name) } : {}) }));
    if (leads[0].relation === "inside" || leads[0].relation === "alumni") w.base = Math.min(100, w.base! + 4);
  }
  const resultsFor = could.filter((w) => w.category === "results");
  const people = could
    .filter((w) => w.category === "management_change" && w.base! + CARES_BOOST >= MATERIAL)
    .sort((a, b) => b.base! - a.base!)
    .slice(0, 5);
  await Promise.race([
    Promise.all([
      pool(resultsFor, 3, async (w) => {
        const f = await fundamentals(w.symbol);
        const h = headline(f);
        if (h) w.results = { ...h, source: f.source };
      }),
      pool(people, 3, async (w) => {
        const company = PORTFOLIO.find((c) => c.symbol === w.symbol)!;
        w.person = await personFromFiling(w, w.doc, company, t0 + T.enrich);
      }),
    ]),
    until(t0 + T.enrich),
  ]);
  timings.enrich = Date.now() - t2;

  const items: Item[] = work.map(({ fp: _fp, doc: _doc, generic: _g, thread: _t, raw: _r, ...it }) => ({ ...it, priority: it.base! }));
  const bars: Record<string, Bar[]> = {};
  for (const { c, bars: b } of live) bars[c.symbol] = b;
  const missing = PORTFOLIO.filter((c) => !got.has(c.symbol)).map((c) => c.symbol);
  timings.total = Date.now() - t0;
  return {
    generatedAt: to.toISOString(), hours, items, bars, source: "live", companies: live.length,
    coverage: { live: live.length, fromSnapshot: [], missing }, timings, filingsRead,
  };
}

// ---------------------------------------------------------------- snapshots

// A snapshot is a raw live response plus `_eod` (the bars), so alerts can be recomputed for
// any threshold even when the exchange is unreachable (e.g. datacenter IPs on Vercel).
type SnapshotFile = Brief & { _eod?: Record<string, [string, number, number, number][]> };
const SNAP_DIR = path.join(process.cwd(), "data/snapshot");

async function readSnapshots(): Promise<SnapshotFile[]> {
  const files = (await fs.readdir(SNAP_DIR).catch(() => [] as string[])).filter((f) => /^brief-\d+\.json$/.test(f));
  const out: SnapshotFile[] = [];
  for (const f of files) {
    try {
      const b = JSON.parse(await fs.readFile(path.join(SNAP_DIR, f), "utf8")) as SnapshotFile;
      if (Array.isArray(b.items) && b.generatedAt) out.push(b);
    } catch {}
  }
  return out;
}

// Smallest window that covers the request, newest first; else the widest we have.
function pickSnapshot(snaps: SnapshotFile[], hours: number) {
  const covering = snaps.filter((b) => b.settings?.hours >= hours).sort((a, b) => a.settings.hours - b.settings.hours || b.generatedAt.localeCompare(a.generatedAt));
  return covering[0] ?? [...snaps].sort((a, b) => (b.settings?.hours ?? 0) - (a.settings?.hours ?? 0) || b.generatedAt.localeCompare(a.generatedAt))[0];
}

const snapBars = (b: SnapshotFile): Record<string, Bar[]> =>
  Object.fromEntries(Object.entries(b._eod ?? {}).map(([sym, rows]) => [sym, rows.map(([date, close, prev, volume]) => ({ date, close, prev, volume }))]));

// Recover the settings-free score of an item from a saved response.
function baseOf(i: Item) {
  if (typeof i.base === "number") return i.base;
  let p = i.priority;
  if (i.signals?.includes("A type you track")) p -= CARES_BOOST;
  if (i.signals?.includes("Stock moved unusually")) p -= MOVED_BOOST;
  return p;
}

async function snapshotCore(hours: number, why: string): Promise<Core> {
  const snap = pickSnapshot(await readSnapshots(), hours);
  if (!snap) throw new Error(`${why}; no snapshot available`);
  const cutoff = new Date(new Date(snap.generatedAt).getTime() - hours * 3600_000).toISOString();
  const items = snap.items.filter((i) => i.time >= cutoff).map((i) => ({ ...i, base: baseOf(i), source: "snapshot" as const }));
  return {
    generatedAt: snap.generatedAt, hours, items, bars: snapBars(snap), source: "snapshot", companies: snap.stats?.companies ?? PORTFOLIO.length,
    coverage: { live: 0, fromSnapshot: PORTFOLIO.map((c) => c.symbol), missing: [] }, timings: {}, filingsRead: snap.stats?.filingsRead ?? 0,
  };
}

// Some holdings failed live: fill just those from the newest snapshot that covers the window.
async function patchFromSnapshot(core: Core): Promise<Core> {
  if (!core.coverage.missing.length) return core;
  const snap = pickSnapshot(await readSnapshots(), core.hours);
  if (!snap) return core;
  const cutoff = new Date(Date.now() - core.hours * 3600_000).toISOString();
  const want = new Set(core.coverage.missing);
  const add = snap.items.filter((i) => want.has(i.symbol) && i.time >= cutoff).map((i) => ({ ...i, base: baseOf(i), source: "snapshot" as const }));
  const sb = snapBars(snap);
  const filled = core.coverage.missing.filter((s) => sb[s] || snap.items.some((i) => i.symbol === s));
  for (const s of filled) if (sb[s]) core.bars[s] = sb[s];
  return {
    ...core, items: [...core.items, ...add], source: filled.length ? "live+snapshot" : core.source, companies: core.companies + filled.length,
    coverage: { live: core.coverage.live, fromSnapshot: filled, missing: core.coverage.missing.filter((s) => !filled.includes(s)) },
  };
}

// ---------------------------------------------------------------- overlay (per request, instant)

function overlay(core: Core, s: Settings): Brief {
  const now = core.source === "snapshot" ? new Date(core.generatedAt) : new Date();
  const fromDay = istDay(new Date(now.getTime() - s.hours * 3600_000));
  const name = (sym: string) => PORTFOLIO.find((c) => c.symbol === sym)?.name ?? sym;
  const snapSyms = new Set(core.coverage.fromSnapshot);
  const alerts = Object.entries(core.bars)
    .flatMap(([sym, b]) => priceAlerts(sym, name(sym), b, s, fromDay).map((a) => ({ ...a, source: snapSyms.has(sym) || core.source === "snapshot" ? ("snapshot" as const) : ("live" as const) })))
    .sort((a, b) => b.value / (b.threshold ?? 1) - a.value / (a.threshold ?? 1));
  const moved = new Set(alerts.map((a) => a.symbol));
  const items = core.items
    .map((it) => {
      const base = it.base ?? it.priority;
      const signals: string[] = [];
      let p = base;
      if (!it.collapsedInto) {
        if (s.cares.includes(it.category)) { p += CARES_BOOST; signals.push("A type you track"); }
        if (moved.has(it.symbol) && base >= 20) { p += MOVED_BOOST; signals.push("Stock moved unusually"); }
        if (it.related?.length) signals.push(`${it.related.length} related filing${it.related.length > 1 ? "s" : ""} folded in`);
      }
      return { ...it, priority: Math.min(100, p), signals };
    })
    .sort((a, b) => b.priority - a.priority || b.time.localeCompare(a.time));
  const material = items.filter((i) => i.priority >= MATERIAL && !i.collapsedInto);

  // Keeping the network warm: stale contacts whose (ex-)employer just made material news.
  const nudges: Nudge[] = [];
  for (const c of CONTACTS) {
    const months = monthsSince(c.lastSpoke);
    if (months < 6) continue;
    const hit = material.find((i) => c.career.some((st) => resolveOrg(st.org)?.symbol === i.symbol));
    if (hit) nudges.push({ id: c.id, name: c.name, months, symbol: hit.symbol, reason: `${hit.company}: ${hit.label.toLowerCase()} — ${hit.summary.slice(0, 80)}` });
  }

  const market = marketNote(core.bars);
  let quietHint: string | undefined;
  if (!material.length) {
    const last = market?.lastSession ? ` Last regular session: ${dayLabel(market.lastSession)}` : "";
    const sk = market?.skipped?.[0] ? ` (${dayLabel(market.skipped[0].date)} was a thin special session, excluded)` : "";
    quietHint = `Nothing material filed in this window.${last}${sk}${last ? "." : ""}`;
  }
  return {
    generatedAt: core.generatedAt, settings: s, items, alerts, nudges: nudges.slice(0, 4),
    stats: { total: items.length, material: material.length, routine: items.length - material.length, companies: core.companies, filingsRead: core.filingsRead },
    source: core.source, quietHint, market, coverage: core.coverage, timings: core.timings,
  };
}

// ---------------------------------------------------------------- entry points

export function normalizeSettings(s: Partial<Settings>): Settings {
  const num = (v: unknown, d: number, lo: number, hi: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.min(hi, Math.max(lo, Number(v))) : d);
  const known = new Set(Object.keys(CATEGORY_LABEL));
  return {
    hours: Math.round(num(s.hours, DEFAULT_SETTINGS.hours, 1, 24 * 90)),
    volX: num(s.volX, DEFAULT_SETTINGS.volX, 1, 20),
    movePct: num(s.movePct, DEFAULT_SETTINGS.movePct, 0.1, 50),
    cares: Array.isArray(s.cares) ? (s.cares.filter((c) => known.has(c)) as Category[]) : DEFAULT_SETTINGS.cares,
  };
}

const CORE_TTL = 10 * 60_000;

async function core(hours: number): Promise<Core> {
  const build = async (): Promise<Core> => {
    try {
      const c = await Promise.race([liveCore(hours), until(Date.now() + T.hard).then(() => null)]);
      return c ? await patchFromSnapshot(c) : await snapshotCore(hours, "NSE too slow");
    } catch (e) {
      return snapshotCore(hours, (e as Error).message);
    }
  };
  // Only fully live results are cached; a degraded brief retries on the next request.
  return cached(`brief-core:v3:${hours}`, CORE_TTL, build, (c) => c.source === "live");
}

export async function buildBrief(input: Partial<Settings>): Promise<Brief> {
  const s = normalizeSettings(input);
  return overlay(await core(s.hours), s);
}

// Snapshot fallback with the same overlay (exported for the route's last-resort path).
export async function snapshotBrief(input: Partial<Settings>, why = "live fetch failed"): Promise<Brief> {
  const s = normalizeSettings(input);
  return overlay(await snapshotCore(s.hours, why), s);
}

// Dev-only: rebuild live and save as data/snapshot/brief-<hours>.json (raw response + bars).
export async function writeSnapshot(input: Partial<Settings>): Promise<Brief> {
  const s = normalizeSettings({ ...DEFAULT_SETTINGS, hours: input.hours });
  const c = await core(s.hours);
  if (c.source !== "live") throw new Error(`not writing a snapshot from a ${c.source} brief`);
  const b = overlay(c, s);
  const _eod = Object.fromEntries(Object.entries(c.bars).map(([sym, bars]) => [sym, bars.map((x) => [x.date, x.close, x.prev, x.volume] as [string, number, number, number])]));
  await fs.mkdir(SNAP_DIR, { recursive: true });
  await fs.writeFile(path.join(SNAP_DIR, `brief-${s.hours}.json`), JSON.stringify({ ...b, _eod }));
  return b;
}
