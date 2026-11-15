// The investor's network, joined to public filings and company data.
//
// ISOMORPHIC on purpose: no Node-only imports, no I/O. The same functions run
//   - on the server, against the synthetic demo network (data/network.ts), and
//   - in the browser, against the investor's OWN imported network, which never leaves the
//     device (components/netstore.ts). Every matching function takes an optional `contacts`
//     array as its LAST parameter; it defaults to the demo network.
// Nothing here calls a model: names, employers and schools are matched by rules.

import { CONTACTS, Contact, INVESTOR } from "@/data/network";
import { OTHER_ORGS, PORTFOLIO } from "@/data/universe";

// ---------- the shape every network (demo or imported) is normalised to ----------
export type Tie = Contact["tie"];
export type NetStint = { org: string; role?: string; from?: number; to?: number; ended?: boolean }; // to undefined = current, unless ended
/** Still there? (`ended` marks a past role whose end year is unknown.) */
export const isCurrent = (s: { to?: number; ended?: boolean }) => s.to == null && !s.ended;
export type NetEdu = { school: string; degree?: string; from?: number; to?: number };
export type NetContact = {
  id: string;
  name: string;
  headline: string;
  city?: string;
  tie: Tie;
  howMet?: string;
  lastSpoke: string; // ISO date. For a LinkedIn import with no logged conversation: the "Connected On" date
  career: NetStint[];
  education: NetEdu[];
  expertise: string[];
  knows: string[]; // explicit edges: ids of contacts they know (recorded by the investor)
  source?: "demo" | "linkedin" | "finn";
  spokeKnown?: boolean; // false: lastSpoke is only when you connected, not when you last talked
  derivedExpertise?: boolean; // expertise inferred from employer + title, not stated by the investor
  url?: string; // profile link from the LinkedIn export (kept on the device)
};
/** The investor's own background (for "you both went to…"). */
export type Me = { career: NetStint[]; education: NetEdu[] };

const DEMO = CONTACTS as readonly NetContact[];

// ---------- entity resolution ----------
type Org = { name: string; aliases: string[]; sector: string; themes: string[]; symbol?: string };
export const ORGS: Org[] = [
  ...PORTFOLIO.map((c) => ({ name: c.name, aliases: c.aliases ?? [], sector: c.sector, themes: c.themes, symbol: c.symbol })),
  ...OTHER_ORGS,
];

const STOP = new Set(["limited", "ltd", "pvt", "private", "india", "industries", "company", "co", "inc", "the", "llp", "plc", "corp", "corporation"]);
const tokens = (s: string) => s.toLowerCase().replace(/[^a-z0-9&]+/g, " ").split(" ").filter((t) => t && !STOP.has(t));
const norm = (s: string) => tokens(s).join("");
/** Normalised company name, e.g. "Tata Elxsi Ltd." and "TATA ELXSI LIMITED" → "tataelxsi". */
export const normOrg = norm;

const ORG_INDEX = ORGS.map((o) => ({ o, keys: [o.name, ...o.aliases].map(norm), head: tokens(o.name) }));
const memo = new Map<string, Org | null>();

function resolveUncached(s: string): Org | undefined {
  const n = norm(s);
  if (!n) return undefined;
  const low = s.trim().toLowerCase();
  const exact = ORG_INDEX.find(({ o, keys }) => o.symbol?.toLowerCase() === low || keys.includes(n));
  if (exact) return exact.o;
  // Whole-token prefixes only, so "Deloitte Touche Tohmatsu LLP" → Deloitte and
  // "Titan Company Ltd (Tanishq)" → Titan, but "Eyeglass Co" never becomes EY.
  const t = tokens(s);
  const longer = ORG_INDEX.filter(({ head }) => head.length > 0 && head.length <= t.length && head.every((x, i) => t[i] === x));
  if (longer.length) return longer.sort((a, b) => b.head.length - a.head.length)[0].o;
  // "Asian" → Asian Paints, but only when unambiguous ("Tata" fits three companies).
  if (n.length > 3) {
    const shorter = ORG_INDEX.filter(({ head }) => t.length < head.length && t.every((x, i) => head[i] === x));
    if (shorter.length === 1) return shorter[0].o;
  }
  return undefined;
}

export function resolveOrg(nameOrSymbol: string): Org | undefined {
  const key = String(nameOrSymbol ?? "").trim();
  const hit = memo.get(key);
  if (hit !== undefined) return hit ?? undefined;
  const r = resolveUncached(key);
  if (memo.size > 20_000) memo.clear();
  memo.set(key, r ?? null);
  return r;
}

// Find every known org mentioned in free text (e.g. a bio paragraph from a filing).
export function orgsInText(text: string): Org[] {
  const found: Org[] = [];
  for (const o of ORGS) {
    const names = [o.name, ...o.aliases].filter((x) => x.length >= 3);
    if (names.some((x) => new RegExp(`\\b${x.replace(/[.*+?^${}()|[\]\\&]/g, "\\$&")}\\b`, "i").test(text))) found.push(o);
  }
  return found;
}

/** Same employer? Known companies by canonical name; anything else by normalised name. */
export const sameOrg = (a: string, b: string) => {
  const A = resolveOrg(a), B = resolveOrg(b);
  return A && B ? A.name === B.name : !!norm(a) && norm(a) === norm(b);
};

// Placeholders that are not a shared workplace ("Self-employed" people don't know each other).
const GENERIC_ORG = /^(independent|self[\s-]?employed|freelanc\w*|stealth.*|confidential|retired|student|unemployed|career break|consultant|n\/?a|none|-+)$|\bstart-?up\b|\bunlisted\b/i;
const orgKey = (org: string) => {
  const s = org.trim();
  if (!s || GENERIC_ORG.test(s)) return null;
  const o = resolveOrg(s);
  return o ? `o:${o.name}` : norm(s) ? `n:${norm(s)}` : null;
};
const schoolKey = (s: string) =>
  s.toLowerCase()
    .replace(/indian institute of technology/g, "iit").replace(/indian institute of management/g, "iim")
    .replace(/\b(the|of)\b/g, "").replace(/[^a-z0-9]/g, "");
const sameSchool = (a: string, b: string) => {
  const A = schoolKey(a), B = schoolKey(b);
  return !!A && !!B && (A === B || (A.length > 5 && B.length > 5 && (A.includes(B) || B.includes(A))));
};

// ---------- relationship strength ----------
const TIE_W = { close: 1, friend: 0.85, professional: 0.6, acquaintance: 0.4 } as const;
export function warmth(c: { tie: Tie; lastSpoke: string }, today = new Date()) {
  const months = (today.getTime() - new Date(c.lastSpoke).getTime()) / (30 * 86400_000);
  const recency = months < 3 ? 1 : months < 9 ? 0.8 : months < 18 ? 0.6 : 0.4; // unknown date → coldest
  return Math.round((TIE_W[c.tie] ?? 0.4) * recency * 100);
}
export const monthsSince = (d: string) => Math.max(0, Math.round((Date.now() - new Date(d).getTime()) / (30 * 86400_000)));

const indexes = new WeakMap<readonly NetContact[], Map<string, NetContact>>();
export function contactIndex<C extends NetContact>(contacts: readonly C[]): Map<string, C> {
  let m = indexes.get(contacts) as Map<string, C> | undefined;
  if (!m) { m = new Map(contacts.map((c) => [c.id, c])); indexes.set(contacts, m as Map<string, NetContact>); }
  return m;
}

// ---------- who probably knows whom (second-degree reach) ----------
// Edges are computed, not hand-written: two contacts who were at the same employer at the same
// time, or at the same school in overlapping years, probably know each other. Strength grows
// with the overlap; crowded buckets (40 of your connections at one IT major) are discounted.
// Explicit "knows" edges recorded by the investor are kept and are the strongest signal.
export type Edge = { id: string; strength: number; why: string; kind: "worked" | "studied" | "knows" };
export type Graph = Map<string, Edge[]>;
const graphs = new WeakMap<readonly NetContact[], Graph>();

const span = (lo: number, hi: number, now: number, bothCurrent: boolean) =>
  bothCurrent && hi >= now ? `since ${lo}` : lo === hi ? `in ${lo}` : `${lo}–${hi}`;

export function knowsGraph(contacts: readonly NetContact[] = DEMO): Graph {
  const hit = graphs.get(contacts);
  if (hit) return hit;
  const now = new Date().getFullYear();
  type Sig = { s: number; why: string; kind: Edge["kind"] };
  const pairs = new Map<string, { a: string; b: string; sigs: Sig[] }>();
  const add = (a: string, b: string, sig: Sig) => {
    if (a === b) return;
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    const cur = pairs.get(k);
    if (!cur) pairs.set(k, { a, b, sigs: [sig] });
    else if (!cur.sigs.some((x) => x.kind === sig.kind && x.s >= sig.s)) cur.sigs = [...cur.sigs.filter((x) => x.kind !== sig.kind), sig];
  };

  // Same employer, overlapping years.
  const byOrg = new Map<string, { c: NetContact; s: NetStint }[]>();
  for (const c of contacts) for (const s of c.career ?? []) {
    const k = orgKey(s.org ?? "");
    if (k) byOrg.set(k, [...(byOrg.get(k) ?? []), { c, s }]);
  }
  for (const [k, list] of byOrg) {
    if (list.length < 2) continue;
    const crowd = list.length > 8 ? Math.sqrt(8 / list.length) : 1;
    const label = k.startsWith("o:") ? k.slice(2) : list[0].s.org.trim();
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const x = list[i], y = list[j];
      if (x.c.id === y.c.id) continue;
      let s: number, why: string;
      if (x.s.from != null && y.s.from != null) {
        const lo = Math.max(x.s.from, y.s.from), hi = Math.min(x.s.to ?? now, y.s.to ?? now);
        if (hi < lo) continue; // there at different times
        s = Math.min(80, 40 + 8 * Math.max(0.5, hi - lo));
        why = `both at ${label} ${span(lo, hi, now, isCurrent(x.s) && isCurrent(y.s))}`;
      } else if (isCurrent(x.s) && isCurrent(y.s)) { s = 45; why = `both at ${label} now`; }
      else { s = 30; why = `both worked at ${label}`; }
      s = Math.round(s * crowd);
      if (s >= 20) add(x.c.id, y.c.id, { s, why, kind: "worked" });
    }
  }

  // Same school, overlapping years (batchmates are the strongest school tie).
  const bySchool = new Map<string, { c: NetContact; e: NetEdu }[]>();
  for (const c of contacts) for (const e of c.education ?? []) {
    const k = schoolKey(e.school ?? "");
    if (k) bySchool.set(k, [...(bySchool.get(k) ?? []), { c, e }]);
  }
  for (const list of bySchool.values()) {
    if (list.length < 2) continue;
    const crowd = list.length > 8 ? Math.sqrt(8 / list.length) : 1;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const x = list[i], y = list[j];
      if (x.c.id === y.c.id) continue;
      const school = x.e.school.trim();
      let s: number, why: string;
      if (x.e.from != null && y.e.from != null) {
        const lo = Math.max(x.e.from, y.e.from), hi = Math.min(x.e.to ?? x.e.from + 2, y.e.to ?? y.e.from + 2);
        if (hi < lo) continue;
        if (x.e.from === y.e.from && x.e.to === y.e.to) { s = 60; why = `${school} batchmates ${lo}–${hi}`; }
        else { s = Math.min(50, 25 + 8 * (hi - lo)); why = `overlapped at ${school} ${span(lo, hi, now, false)}`; }
      } else { s = 20; why = `both went to ${school}`; }
      s = Math.round(s * crowd);
      if (s >= 20) add(x.c.id, y.c.id, { s, why, kind: "studied" });
    }
  }

  // Explicit edges the investor recorded.
  const ids = contactIndex(contacts);
  for (const c of contacts) for (const k of c.knows ?? []) if (ids.has(k)) add(c.id, k, { s: 85, why: "they know each other", kind: "knows" });

  const g: Graph = new Map();
  const RANK = { worked: 0, studied: 1, knows: 2 } as const;
  for (const { a, b, sigs } of pairs.values()) {
    const top = Math.max(...sigs.map((x) => x.s));
    const strength = Math.min(95, top + 6 * (sigs.length - 1)); // two independent signals beat one
    const ordered = [...sigs].sort((p, q) => RANK[p.kind] - RANK[q.kind]);
    const why = ordered.filter((x) => x.kind !== "knows").map((x) => x.why).slice(0, 2).join(" and ") || ordered[0].why;
    const kind = ordered[0].kind;
    for (const [from, to] of [[a, b], [b, a]] as const) g.set(from, [...(g.get(from) ?? []), { id: to, strength, why, kind }]);
  }
  for (const list of g.values()) list.sort((p, q) => q.strength - p.strength);
  graphs.set(contacts, g);
  return g;
}

export type Route<C extends NetContact = Contact> = { via: C; edge: Edge; path: number };
/** Path strength through an intermediary: how well you know them × how likely they know the target. */
export const pathStrength = (via: { tie: Tie; lastSpoke: string }, edge: Edge) => Math.round((warmth(via) * edge.strength) / 100);

/** Below this warmth a direct call is a cold call, and a warmer route is worth naming. */
export const COLD = 50;

/** The best warmer route to someone you know only loosely: a closer contact who probably knows them. */
export function warmerRoute<C extends NetContact = Contact>(target: C, contacts: readonly C[] = DEMO as readonly C[], skip?: (c: C) => boolean): Route<C> | undefined {
  const direct = warmth(target);
  if (direct >= COLD) return undefined; // you can just call them
  const g = knowsGraph(contacts), ids = contactIndex(contacts);
  let best: Route<C> | undefined;
  for (const e of g.get(target.id) ?? []) {
    const v = ids.get(e.id);
    if (!v || skip?.(v)) continue;
    const path = pathStrength(v, e);
    if (path > direct + 10 && (!best || path > best.path)) best = { via: v, edge: e, path };
  }
  return best;
}

// ---------- "who should I call about company X?" ----------
export type Lead<C extends NetContact = Contact> = {
  contact: C;
  score: number;
  relation: "inside" | "alumni" | "peer" | "theme" | "second";
  why: string;
  via?: C;
  edge?: string; // second-degree: why the intermediary probably knows them
  path?: number; // second-degree: path strength 0–100
};

export function leadsForCompany<C extends NetContact = Contact>(
  company: { name: string; symbol?: string; sector?: string; themes?: string[] },
  topic?: string,
  contacts: readonly C[] = DEMO as readonly C[],
): Lead<C>[] {
  const org = resolveOrg(company.symbol ?? company.name) ?? resolveOrg(company.name);
  const target = org?.name ?? company.name;
  const sector = org?.sector ?? company.sector;
  const themes = new Set([...(org?.themes ?? []), ...(company.themes ?? [])]);
  const leads: Lead<C>[] = [];
  const now = new Date().getFullYear();
  for (const c of contacts) {
    const career = c.career ?? [];
    const here = career.find((s) => isCurrent(s) && sameOrg(s.org, target)) ?? career.find((s) => sameOrg(s.org, target));
    let lead: Lead<C> | null = null;
    const role = (s: NetStint) => s.role || "works";
    if (here && isCurrent(here)) {
      lead = { contact: c, score: 90, relation: "inside", why: `Works there now — ${here.role ? here.role : "current employer"}${here.from ? ` since ${here.from}` : ""}` };
    } else if (here) {
      const ago = here.to != null ? now - here.to : 5; // end year unknown: assume a while ago
      const yrs = here.to != null ? ` ${here.from ?? "?"}–${here.to}` : here.from != null ? ` from ${here.from}` : " earlier";
      lead = { contact: c, score: 78 - ago * 4, relation: "alumni", why: `${role(here)} there${yrs}${ago <= 2 ? " — recent enough to know today's team" : ""}` };
    } else {
      const peer = sector ? career.find((s) => isCurrent(s) && resolveOrg(s.org)?.sector === sector) : undefined;
      const theme = c.expertise?.find((e) => themes.has(e));
      if (peer) lead = { contact: c, score: 60, relation: "peer", why: `At a peer — ${[peer.role, peer.org].filter(Boolean).join(", ")}. Sees the same customers & costs` };
      else if (theme) lead = { contact: c, score: 45, relation: "theme", why: c.derivedExpertise ? `Works in ${theme}` : `Go-to on ${theme}` };
    }
    if (lead) {
      if (topic && c.expertise?.some((e) => topic.toLowerCase().includes(e))) lead.score += 8;
      lead.score = Math.round(lead.score * 0.6 + warmth(c) * 0.4);
      leads.push(lead);
    }
  }
  // Second-degree: someone you know better, who probably knows the insider (computed or recorded edge).
  const direct = new Set(leads.filter((x) => x.relation !== "theme").map((x) => x.contact.id));
  for (const l of leads.filter((x) => x.relation === "inside" || x.relation === "alumni")) {
    const r = warmerRoute(l.contact, contacts, (v) => direct.has(v.id));
    if (r) leads.push({ contact: l.contact, via: r.via, score: Math.round(l.score * 0.9), relation: "second", why: `Warm intro via ${r.via.name} — ${r.edge.why}`, edge: r.edge.why, path: r.path });
  }
  return leads.sort((a, b) => b.score - a.score);
}

/**
 * Top `n` people to call, each with their warmer intro route folded in when one exists. If none of
 * them is inside (or recently out of) the company but someone is, that person is added too: a
 * cold line inside, with a warm way in, beats another opinion from outside.
 */
export function pickLeads<C extends NetContact = Contact>(all: Lead<C>[], n: number): Lead<C>[] {
  const direct = all.filter((l) => l.relation !== "second");
  const top = direct.filter((l, i) => direct.findIndex((x) => x.contact.id === l.contact.id) === i).slice(0, n);
  const insider = direct.find((l) => l.relation === "inside" || l.relation === "alumni");
  if (insider && !top.some((l) => l.relation === "inside" || l.relation === "alumni")) top.push(insider);
  return top.flatMap((l) => {
    const r = all.find((x) => x.relation === "second" && x.contact.id === l.contact.id);
    return r ? [l, r] : [l];
  });
}

// ---------- "do I know this person?" — for people named in filings ----------
export type PersonProfile = {
  name: string;
  role?: string;
  employers: { org: string; role?: string; from?: number; to?: number }[];
  education: { school: string; from?: number; to?: number }[];
};

export type Overlap<C extends NetContact = Contact> = {
  contact: C;
  kind: "worked-with" | "studied-with" | "one-away" | "same-alma-mater";
  why: string;
  strength: number;
  via?: C; // a warmer contact who probably knows `contact`
  viaWhy?: string;
  path?: number;
};

const yearsOverlap = (a1?: number, a2?: number, b1?: number, b2?: number) => {
  const now = new Date().getFullYear();
  if (a1 == null || b1 == null) return true; // unknown years: treat as possible overlap
  return Math.max(a1, b1) <= Math.min(a2 ?? now, b2 ?? now);
};

export function overlapsForPerson<C extends NetContact = Contact>(p: PersonProfile, joiningOrg?: string, contacts: readonly C[] = DEMO as readonly C[]): Overlap<C>[] {
  const out: Overlap<C>[] = [];
  const now = new Date().getFullYear();
  const first = (n: string) => n.split(" ")[0];
  for (const c of contacts) {
    for (const e of p.employers ?? []) {
      if (!e?.org || GENERIC_ORG.test(e.org.trim())) continue;
      for (const s of c.career ?? []) {
        if (!sameOrg(s.org, e.org)) continue;
        const both = yearsOverlap(s.from, s.to, e.from, e.to);
        const lo = s.from != null && e.from != null ? Math.max(s.from, e.from) : undefined;
        const hi = Math.min(s.to ?? now, e.to ?? now);
        out.push({
          contact: c,
          kind: both ? "worked-with" : "one-away",
          why: both
            ? `Both at ${s.org}${lo != null ? ` (${span(lo, hi, now, isCurrent(s) && e.to == null)})` : ""}`
            : `${first(c.name)} was at ${s.org} ${s.from ?? "?"}–${s.to ?? (isCurrent(s) ? "now" : "?")} — knows the team they came from`,
          strength: both ? 85 : 50,
        });
      }
    }
    for (const ed of p.education ?? []) {
      if (!ed?.school) continue;
      const m = (c.education ?? []).find((x) => sameSchool(x.school, ed.school));
      if (m) {
        const both = m.from != null && ed.from != null && yearsOverlap(m.from, m.to, ed.from, ed.to);
        const lo = Math.max(m.from ?? 0, ed.from ?? 0), hi = Math.min(m.to ?? lo + 2, ed.to ?? lo + 2);
        out.push({ contact: c, kind: both ? "studied-with" : "same-alma-mater", why: both ? `${m.school} ${lo === hi ? lo : `${lo}–${hi}`}` : `${m.school} alum`, strength: both ? 70 : 35 });
      }
    }
    if (joiningOrg) {
      const inside = (c.career ?? []).find((s) => isCurrent(s) && sameOrg(s.org, joiningOrg));
      if (inside) out.push({ contact: c, kind: "one-away", why: `Will work alongside them at ${inside.org}${inside.role ? ` (${inside.role})` : ""}`, strength: 65 });
    }
  }
  const best = new Map<string, Overlap<C>>();
  for (const o of out) {
    const s = Math.round(o.strength * 0.6 + warmth(o.contact) * 0.4);
    const cur = best.get(o.contact.id);
    if (!cur || s > cur.strength) best.set(o.contact.id, { ...o, strength: s });
  }
  // If the person who overlaps is a cold contact, name the warmer route to them.
  const hits = new Set(best.keys());
  for (const o of best.values()) {
    const r = warmerRoute(o.contact, contacts, (v) => hits.has(v.id));
    if (r) Object.assign(o, { via: r.via, viaWhy: r.edge.why, path: r.path });
  }
  return [...best.values()].sort((a, b) => b.strength - a.strength);
}

/** "You both went to IIT Delhi" — against the investor's own background (demo: the synthetic investor). */
export function investorOverlap(p: PersonProfile, me: Me | null = INVESTOR): string | null {
  if (!me) return null;
  for (const e of p.education ?? []) {
    const m = (me.education ?? []).find((x) => e?.school && sameSchool(x.school, e.school));
    if (!m) continue;
    if (m.from != null && e.from != null && yearsOverlap(m.from, m.to, e.from, e.to)) {
      const lo = Math.max(m.from, e.from), hi = Math.min(m.to ?? m.from + 2, e.to ?? e.from + 2);
      return `You were at ${e.school} at the same time (${lo === hi ? lo : `${lo}–${hi}`})`;
    }
    return `You both went to ${e.school}`;
  }
  for (const e of p.employers ?? []) if (e?.org && (me.career ?? []).some((x) => sameOrg(x.org, e.org))) return `You both worked at ${e.org}`;
  return null;
}

// ---------- expertise map ----------
export function expertiseMap<C extends NetContact = Contact>(contacts: readonly C[] = DEMO as readonly C[]) {
  const m = new Map<string, C[]>();
  for (const c of contacts) for (const e of c.expertise ?? []) m.set(e, [...(m.get(e) ?? []), c]);
  return [...m.entries()]
    .map(([theme, people]) => ({ theme, people: people.sort((a, b) => warmth(b) - warmth(a)) }))
    .sort((a, b) => b.people.length - a.people.length);
}

// ---------- the question worth asking, per filing type and relationship ----------
// Deterministic: no contact data goes anywhere. Insiders get "why", peers get "are you seeing it too".
export function questionFor(category: string, relation: string, company: string, summary = ""): string {
  const peer = relation === "peer" || relation === "theme";
  if (category === "management_change" && !peer) {
    if (/re-?appoint|re-?designat|extension of (?:the |his |her )?(?:term|tenure)/i.test(summary)) return "Is this renewal a vote of confidence, or is succession still an open question?";
    if (/resign|retire|cessation|ceas|vacat|superannuat|step(?:ped|s)? down/i.test(summary)) return "Why are they really leaving, and who runs their part of the business now?";
  }
  if (category === "press_release" && /\b(order|contract|bags|wins?|awarded)\b/i.test(summary))
    return peer ? "Was this order competitively bid, and at what kind of margin?" : "Is this order at normal margins, and how quickly does it turn into revenue?";
  const Q: Record<string, [string, string]> = {
    results: ["Was this quarter's margin move mix, pricing or one-offs — and does it repeat next quarter?", `Are you seeing the same demand and cost trend that ${company} just reported?`],
    management_change: ["Why now — and what will the new person change first?", `What's the industry read on this change at ${company}?`],
    "M&A": ["Why this deal, what are they really paying for, and who pushed for it?", `Does this deal change how ${company} competes with you?`],
    capex: ["Is there demand to fill this capacity — what payback are they underwriting?", "Is the industry adding capacity at the same time?"],
    litigation: ["How material is this really, and has it happened before?", `Has this kind of order hit others in the sector, or only ${company}?`],
    fund_raise: ["Why raise now — growth, balance sheet, or a promoter need?", "Is the sector raising money too, or is this company-specific?"],
    credit_rating: ["What is the agency worried about that the market isn't?", "Are lenders tightening on the sector?"],
    pledging: ["Why does the promoter need liquidity right now?", "Is promoter stress showing up anywhere else you know?"],
  };
  const q = Q[category];
  return q ? q[peer ? 1 : 0] : `Anything about ${company} the filings aren't telling me?`;
}

// ---------- what the network notices that the investor wouldn't ----------
export type Notice = { kind: "route" | "cold" | "gap" | "hub"; text: string; ids: string[]; symbols: string[] };

export function noticed<C extends NetContact = Contact>(contacts: readonly C[] = DEMO as readonly C[], holdings: { symbol: string; name: string }[] = PORTFOLIO): Notice[] {
  const out: Notice[] = [];
  const first = (n: string) => n.split(" ")[0];
  // A "line" into a holding: someone there now, or who left within the last 3 years.
  const yr = new Date().getFullYear();
  const insideBy = new Map<string, C[]>();
  for (const h of holdings) {
    const ins = contacts.filter((c) => (c.career ?? []).some((s) => sameOrg(s.org, h.name) && (isCurrent(s) || (s.to != null && yr - s.to <= 3))));
    if (ins.length) insideBy.set(h.symbol, ins);
  }
  // 1. Your only line into a holding has gone cold, but a warmer contact probably knows them.
  const routes: { n: Notice; score: number }[] = [];
  const colds: { n: Notice; score: number }[] = [];
  for (const h of holdings) {
    const ins = insideBy.get(h.symbol);
    if (!ins) continue;
    const best = [...ins].sort((a, b) => warmth(b) - warmth(a))[0];
    if (warmth(best) >= COLD) continue;
    const r = warmerRoute(best, contacts, (v) => ins.some((x) => x.id === v.id));
    const m = monthsSince(best.lastSpoke);
    const ago = best.spokeKnown === false ? "you have no conversation logged with them" : Number.isFinite(m) ? `you last spoke ${m} months ago` : "you have no conversation logged with them";
    const line = ins.length > 1 ? "warmest line" : "only line";
    // Inferred links (shared employer/school) first: the investor already knows the ones they recorded.
    if (r) routes.push({ score: r.path - warmth(best) + (r.edge.kind === "knows" ? 0 : 100), n: { kind: "route", ids: [best.id, r.via.id], symbols: [h.symbol], text: `${best.name} is your ${line} into ${h.name}, and ${ago}. ${r.via.name} is a warmer way in: ${r.edge.why}.` } });
    else colds.push({ score: 50 - warmth(best), n: { kind: "cold", ids: [best.id], symbols: [h.symbol], text: `${best.name} is your ${line} into ${h.name}, and ${ago}. Worth a call before you need one.` } });
  }
  out.push(...routes.sort((a, b) => b.score - a.score).slice(0, 2).map((x) => x.n));
  out.push(...colds.sort((a, b) => b.score - a.score).slice(0, 1).map((x) => x.n));
  // 2. Holdings with no one inside or recently out.
  const blind = holdings.filter((h) => !insideBy.has(h.symbol));
  if (blind.length) out.push({ kind: "gap", ids: [], symbols: blind.map((h) => h.symbol), text: `No one inside ${blind.length} of your ${holdings.length} holdings: ${blind.slice(0, 6).map((h) => h.symbol).join(", ")}${blind.length > 6 ? ` and ${blind.length - 6} more` : ""}. You'd be calling peers, not insiders.` });
  // 3. The connector: a warm contact who probably knows the most people you know only loosely.
  const g = knowsGraph(contacts), ids = contactIndex(contacts);
  let hub: { c: C; n: number; orgs: string[] } | undefined;
  for (const c of contacts) {
    if (warmth(c) < 60) continue;
    const reach = (g.get(c.id) ?? []).map((e) => ids.get(e.id)).filter((x): x is C => !!x && warmth(x) < warmth(c));
    if (reach.length >= 2 && (!hub || reach.length > hub.n)) {
      const orgs = [...new Set(reach.map((x) => (x.career ?? []).find(isCurrent)?.org).filter((x): x is string => !!x && !GENERIC_ORG.test(x)))];
      hub = { c, n: reach.length, orgs };
    }
  }
  if (hub) out.push({ kind: "hub", ids: [hub.c.id], symbols: [], text: `${hub.c.name} is your best connector: probably knows ${hub.n} people you know only loosely${hub.orgs.length ? `, at ${hub.orgs.slice(0, 3).join(", ")}` : ""}. Ask ${first(hub.c.name)} for intros, not just views.` });
  return out;
}
