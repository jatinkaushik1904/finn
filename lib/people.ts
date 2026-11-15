// "Before you meet management": who runs the company, where they came from, and what to ask.
//
// Primary sources only, the same discipline as the research view:
//   people  — management-change filings on NSE over ~25 months (the appointment letter carries a
//             mandatory "brief profile"), plus the management cast printed on the latest
//             earnings-call transcript;
//   ask     — what the company's own record raises: guidance it missed (promised vs delivered),
//             senior exits, and regulatory / litigation / rating filings in the last 12 months.
// The model only copies a profile out of a filing (lib/person.ts); everything else is rules.
// PRIVACY: nothing about the investor's network is used here. Overlaps with these people are
// matched in the browser (components/people.tsx), against whichever network is active.
import { assess, roleTier } from "./classify";
import { cached, DAY } from "./cache";
import { pdfText, pool, RawAnn } from "./nse";
import { cleanName, extractPerson, personKey } from "./person";
import { castList, narrative, recentAnnouncements, research } from "./research";

export type MStint = { org: string; role?: string | null; from?: number | null; to?: number | null };
export type MPerson = {
  name: string; role?: string | null; since?: string | null; source: "filing" | "concall";
  filingUrl?: string | null; bio?: string | null; career: MStint[];
  education: { school: string; from?: number | null; to?: number | null }[];
};
export type AskAbout = { topic: string; why: string; verdict?: string; url?: string; kind: "promise" | "exit" | "filing" };
export type Meeting = {
  symbol: string; company: string; people: MPerson[]; askAbout: AskAbout[]; asOf: string; partial?: boolean;
  sources: { filingsScanned: number; filingsRead: number; call?: string | null; callUrl?: string | null };
};

const parseDate = (s: string) => new Date(String(s ?? "").replace(" ", "T") + "+05:30");
const nameKey = (n: string) => cleanName(n).toLowerCase().replace(/[^a-z]/g, "");
// "A. K. Sharma" on a call and "Ashok Kumar Sharma" in a filing: same surname, same first initial.
const loose = (n: string) => { const p = cleanName(n).toLowerCase().split(/[^a-z]+/).filter(Boolean); return p.length ? `${p[0][0]}|${p[p.length - 1]}` : ""; };
// …and "Kota Ravi" in a filing is "Ravi Kota" on the call: the same name tokens in any order.
const bag = (n: string) => cleanName(n).toLowerCase().split(/[^a-z]+/).filter((t) => t.length > 1).sort().join(" ");
const sameName = (a: string, b: string) => nameKey(a) === nameKey(b) || (!!loose(a) && loose(a) === loose(b)) || (bag(a).includes(" ") && bag(a) === bag(b));
const monthYear = (d: Date) => d.toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
const TIER_RANK: Record<string, number> = { top: 0, chair: 1, exec: 2, smp: 3, ned: 4, id: 5 };
const MANAGEMENT = new Set(["top", "chair", "exec", "smp"]);
const EXIT = /resign|retire|cessation|ceas(?:e|ed|ing)\b|vacat|superannuat|step(?:ped|s)? down|demise|relinquish/i;
const FOLLOW_UP = /shareholders?['’]? approval|approval of (?:the )?(?:shareholders|members)|postal ballot|e-voting/i;
// Firms and functionaries appointed by the same kind of filing: not people you meet as "management".
const NOT_MANAGEMENT = /auditors?\b|registrar|\bRTA\b|trustee|scrutini[sz]er|merchant banker|\bM\/s\b|practi[sc]ing company secretar/i;
const trim = (s: string, n: number) => (s.length > n ? s.slice(0, n).replace(/\s+\S*$/, "") + "…" : s);
// A call's cast list prints "Managing Director And Vice Chairman – Dixon Technologies (India) Limited".
const tidyTitle = (t: string, company: string) => {
  const co = company.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3)[0] ?? "\u0000";
  return (t || "")
    .replace(/^[\s–—,:-]+/, "")
    .replace(/\s*[–—,-]\s*([^–—,]*)$/, (m, tail: string) => (tail.toLowerCase().includes(co) || /\b(limited|ltd)\.?$/i.test(tail.trim()) ? "" : m))
    .replace(/\b(And|Of|The|For|In)\b/g, (w) => w.toLowerCase())
    .trim();
};

type Event = { a: RawAnn; time: Date; summary: string; tier?: string; who: string; exit: boolean };

// "X ceases to be CFO and Mr. Y is appointed in his place": the first person named is the one the
// card is about, so only the words around that name decide whether this is an exit.
function exitOf(summary: string): boolean {
  const m = summary.match(/(?:Mr|Ms|Mrs|Dr|Shri|Smt)\.?\s+[A-Z]/);
  if (!m || m.index == null) return EXIT.test(summary);
  const near = summary.slice(Math.max(0, m.index - 60), m.index + 110);
  const exit = near.search(EXIT), join = near.search(/appoint|elevat|induct|assum|designat|join/i);
  return exit >= 0 && (join < 0 || exit < join);
}

function managementEvents(anns: RawAnn[], company: string): Event[] {
  const out: Event[] = [];
  for (const a of anns) {
    if (!/\.pdf(\?|$)/i.test(a.attchmntFile ?? "")) continue;
    const x = assess(a.desc, a.attchmntText, company);
    if (x.category !== "management_change") continue;
    const head = `${a.desc} :: ${a.attchmntText}`;
    if (FOLLOW_UP.test(head) || NOT_MANAGEMENT.test(head)) continue;
    const who = personKey(x.summary);
    out.push({ a, time: parseDate(a.sort_date), summary: x.summary, tier: roleTier(head), who, exit: who ? exitOf(x.summary) : EXIT.test(head) });
  }
  return out.sort((p, q) => q.time.getTime() - p.time.getTime());
}

async function build(symbol: string, budgetMs: number): Promise<Meeting> {
  const t0 = Date.now();
  const deadline = t0 + budgetMs;
  const r = await research(symbol);
  const company = { name: r.name, symbol: r.symbol };
  const anns = await recentAnnouncements(r.symbol).catch(() => [] as RawAnn[]);
  const events = managementEvents(anns, r.name);

  // Which filings to open: the latest filing per named person, and unnamed "change in management"
  // filings (the name is inside). Most senior first, then most recent; at most 10 PDFs.
  const perPerson = new Map<string, Event>();
  for (const e of events) {
    const k = e.who || `#${e.a.seq_id || e.a.attchmntFile}`;
    const cur = perPerson.get(k);
    // Prefer the appointment letter (it carries the mandatory profile) over later notices about the same person.
    const appt = (x: Event) => !x.exit && /appoint|elevat|induct|designat/i.test(`${x.a.desc} ${x.a.attchmntText}`);
    if (!cur || (appt(e) && !appt(cur))) perPerson.set(k, e);
  }
  const toRead = [...perPerson.values()]
    .filter((e) => !e.tier || MANAGEMENT.has(e.tier))
    .sort((p, q) => (TIER_RANK[p.tier ?? "smp"] - TIER_RANK[q.tier ?? "smp"]) || q.time.getTime() - p.time.getTime())
    .slice(0, 10);

  type Found = { e: Event; summary: string; name: string; role?: string; bio?: string; career: MStint[]; education: MPerson["education"]; direction: string; tier?: string; board?: boolean };
  const found: Found[] = [];
  let read = 0;
  let partial = false;
  await Promise.race([
    pool(toRead, 4, async (e) => {
      if (Date.now() > deadline - 4000) { partial = true; return; }
      const doc = await pdfText(e.a.attchmntFile, 12).catch(() => "");
      if (doc) read++;
      // With the letter in hand, the one-liner sharpens ("Change in Management" → who and what).
      const sharp = doc ? assess(e.a.desc, e.a.attchmntText, r.name, doc) : null;
      const summary = sharp && sharp.category === "management_change" ? sharp.summary : e.summary;
      const x = await extractPerson(summary, doc || undefined, company, deadline - 2000);
      if (!x) return;
      const tier = roleTier(`${x.role ?? ""} ${summary}`) ?? e.tier;
      // Independent, nominee and plain "additional" directors are the board, not management —
      // unless they also speak for the company on its earnings call (an executive on the board).
      const board = tier ? !MANAGEMENT.has(tier) : /\bdirector\b/i.test(x.role ?? summary);
      found.push({ e, summary, name: x.name, role: x.role, bio: x.bio, career: x.employers, education: x.education, direction: x.direction, tier, board });
    }),
    new Promise<void>((res) => setTimeout(() => { partial = true; res(); }, Math.max(0, deadline - 3000 - Date.now()))),
  ]);

  // Who has left: named in an exit filing (by rules on NSE's line, or by the letter itself).
  type Exit = { name: string; role?: string; at: Date; summary: string; url: string; tier?: string };
  const exits = new Map<string, Exit>();
  const whoOf = (s: string) => cleanName(s.match(/(?:Mr|Ms|Mrs|Dr|Shri|Smt)\.?\s+([A-Z][A-Za-z.'’]*(?:\s+[A-Z][A-Za-z.'’]*){1,3})/)?.[1] ?? "");
  for (const e of events) if (e.exit && e.who) exits.set(e.who, { name: whoOf(e.summary), at: e.time, summary: e.summary, url: e.a.attchmntFile, tier: e.tier });
  for (const f of found) if (f.direction === "leaving") exits.set(nameKey(f.name), { name: f.name, role: f.role, at: f.e.time, summary: f.summary, url: f.e.a.attchmntFile, tier: f.tier });
  // "Sandhya Sharma" in the exit notice is "Sandhya Venugopal Sharma" in her appointment letter.
  const leftAt = (name: string) => exits.get(nameKey(name)) ?? [...exits.values()].find((x) => x.name && sameName(x.name, name));

  // Current management from filings: appointed or re-appointed, and not seen leaving afterwards.
  const peopleByKey = new Map<string, MPerson & { tier?: string }>();
  const boardOnly = new Map<string, MPerson & { tier?: string }>();
  for (const f of found.sort((p, q) => q.e.time.getTime() - p.e.time.getTime())) {
    if (f.direction === "leaving") continue;
    const k = nameKey(f.name);
    const gone = leftAt(f.name);
    if (gone && gone.at.getTime() >= f.e.time.getTime()) continue;
    const into = f.board ? boardOnly : peopleByKey;
    if (peopleByKey.has(k) || boardOnly.has(k)) continue;
    into.set(k, {
      name: f.name, role: f.role ?? null, since: f.direction === "joining" ? f.e.time.toISOString() : null, source: "filing",
      filingUrl: f.e.a.attchmntFile, bio: f.bio ?? null, career: f.career, education: f.education, tier: f.tier,
    });
  }

  // The cast of the latest earnings call: certainly current. Merge by name; add those with no filing.
  const cast = await Promise.race([castList(r).catch(() => null), new Promise<null>((res) => setTimeout(() => res(null), Math.max(0, deadline - 2000 - Date.now())))]);
  for (const c of cast?.cast ?? []) {
    const k = nameKey(c.name);
    if (!k) continue;
    const hit = peopleByKey.get(k) ?? [...peopleByKey.values()].find((p) => sameName(p.name, c.name));
    const title = tidyTitle(c.title, r.name);
    if (hit) { if (title) hit.role = title; continue; }
    // On the board by filing AND on the call for management: an executive. Keep their filed profile.
    const seat = boardOnly.get(k) ?? [...boardOnly.values()].find((p) => sameName(p.name, c.name));
    if (seat) { peopleByKey.set(k, { ...seat, role: title || seat.role, tier: roleTier(title || "") ?? "exec" }); continue; }
    peopleByKey.set(k, { name: c.name, role: title || null, since: null, source: "concall", filingUrl: null, bio: null, career: [], education: [], tier: roleTier(title || "") });
  }
  const people = [...peopleByKey.values()]
    .sort((p, q) => (TIER_RANK[p.tier ?? "smp"] - TIER_RANK[q.tier ?? "smp"]) || Number(!!q.bio) - Number(!!p.bio) || (p.source === q.source ? 0 : p.source === "filing" ? -1 : 1))
    .slice(0, 12)
    .map(({ tier: _t, ...p }) => p);

  // ---- what to ask about
  const ask: AskAbout[] = [];
  const yearAgo = Date.now() - 365 * DAY;
  // 1. Guidance the company's own numbers say it missed (cached with the research view's narrative).
  const narr = await Promise.race([
    narrative(r.symbol, Math.max(5000, deadline - Date.now() - 1500)).catch(() => null),
    new Promise<null>((res) => setTimeout(() => res(null), Math.max(0, deadline - 1500 - Date.now()))),
  ]);
  if (!narr) partial = true;
  for (const v of (narr?.verdicts ?? []).filter((x) => x.verdict === "missed" || x.verdict === "partly").slice(0, 3))
    ask.push({ kind: "promise", topic: trim(v.scope && v.scope !== "company" && v.subject && v.subject.split(/\s+/).length <= 3 && !/unnamed|\(/.test(v.subject) && !v.promise.toLowerCase().includes(v.subject.toLowerCase()) ? `${v.subject[0].toUpperCase()}${v.subject.slice(1)}: ${v.promise}` : v.promise, 120), why: trim(`${v.call} call${v.speaker ? `, ${v.speaker}` : ""}. Reported: ${v.delivered}`, 240), verdict: v.verdict, url: narr?.calls.find((c) => c.call === v.call)?.url });
  // 2. Senior people who left in the last 12 months.
  const senior = [...exits.values()].filter((x) => x.at.getTime() >= yearAgo && x.tier && MANAGEMENT.has(x.tier)).sort((p, q) => (TIER_RANK[p.tier!] - TIER_RANK[q.tier!]) || q.at.getTime() - p.at.getTime());
  const generic = (s: string) => s.length < 30 || /^(change in|resignation|retirement|cessation|appointment)\b[^.]{0,40}$|^ref\b|regulation 30|listing obligations/i.test(s);
  for (const x of senior.slice(0, 2))
    ask.push({ kind: "exit", topic: trim(generic(x.summary) && x.name ? `${x.name}${x.role ? `, ${x.role},` : ""} left` : x.summary, 120), why: `Filed ${monthYear(x.at)}. Why they left, and who covers the role now.`, url: x.url });
  if (senior.length > 2) ask.push({ kind: "exit", topic: `${senior.length} senior exits in 12 months`, why: "More than two senior departures in a year is a pattern worth a direct question." });
  // 3. Regulatory, litigation, rating and pledge filings the classifier scores as material — judged
  //    on the letter itself (a "penalty" line can be a ₹10,000 fine), not on NSE's one-liner.
  const material = (c: string, p: number) => (c === "litigation" && p >= 60) || (c === "credit_rating" && p >= 55) || c === "pledging";
  const flagged = anns
    .map((a) => ({ a, x: assess(a.desc, a.attchmntText, r.name), at: parseDate(a.sort_date) }))
    .filter(({ x, at }) => at.getTime() >= yearAgo && material(x.category, x.priority))
    .sort((p, q) => q.x.priority - p.x.priority || q.at.getTime() - p.at.getTime())
    .slice(0, 4);
  const flags = (await pool(flagged, 2, async (f) => {
    if (Date.now() > deadline - 1500 || !/\.pdf(\?|$)/i.test(f.a.attchmntFile ?? "")) return f;
    const doc = await pdfText(f.a.attchmntFile, 6).catch(() => "");
    return doc ? { ...f, x: assess(f.a.desc, f.a.attchmntText, r.name, doc) } : f;
  })).filter((f): f is (typeof flagged)[number] => !!f && material(f.x.category, f.x.priority)).slice(0, 2);
  for (const f of flags) ask.push({ kind: "filing", topic: trim(f.x.summary, 140), why: `${f.x.category === "litigation" ? "Regulatory / legal" : f.x.category === "pledging" ? "Promoter pledge" : "Credit rating"} filing, ${monthYear(f.at)}. How material, and is it closed?`, url: f.a.attchmntFile });

  return {
    symbol: r.symbol, company: r.name, people, askAbout: ask.slice(0, 6), asOf: new Date().toISOString(), ...(partial ? { partial: true } : {}),
    sources: { filingsScanned: events.length, filingsRead: read, call: cast?.call ?? null, callUrl: cast?.url ?? null },
  };
}

/** Cached per symbol, latest filing and latest reported quarter; incomplete answers are not kept. */
export async function people(symbolIn: string, budgetMs = 42_000): Promise<Meeting> {
  const t0 = Date.now();
  const r = await research(symbolIn);
  const anns = await recentAnnouncements(r.symbol).catch(() => [] as RawAnn[]);
  const latest = anns.map((a) => a.sort_date).sort().at(-1) ?? "";
  const key = `people:v6:${r.symbol}:${latest.slice(0, 10)}:${r.quarters.periods.at(-1)}:${r.concalls.find((c) => c.transcript)?.transcript ?? ""}`;
  return cached(key, DAY, () => build(r.symbol, Math.max(8000, budgetMs - (Date.now() - t0))), (m) => !m.partial, { immutable: true });
}
