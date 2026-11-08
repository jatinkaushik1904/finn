import { CONTACTS, Contact, INVESTOR, contactById } from "@/data/network";
import { OTHER_ORGS, PORTFOLIO } from "@/data/universe";

// ---------- entity resolution ----------
type Org = { name: string; aliases: string[]; sector: string; themes: string[]; symbol?: string };
export const ORGS: Org[] = [
  ...PORTFOLIO.map((c) => ({ name: c.name, aliases: c.aliases ?? [], sector: c.sector, themes: c.themes, symbol: c.symbol })),
  ...OTHER_ORGS,
];

const norm = (s: string) =>
  s.toLowerCase().replace(/\b(limited|ltd|pvt|private|india|industries|company|co|inc|the)\b/g, "").replace(/[^a-z0-9&]/g, "");

export function resolveOrg(nameOrSymbol: string): Org | undefined {
  const n = norm(nameOrSymbol);
  if (!n) return undefined;
  return ORGS.find(
    (o) => o.symbol?.toLowerCase() === nameOrSymbol.toLowerCase() || norm(o.name) === n || o.aliases.some((a) => norm(a) === n),
  ) ?? ORGS.find((o) => n.length > 3 && (norm(o.name).startsWith(n) || n.startsWith(norm(o.name))));
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

const sameOrg = (a: string, b: string) => {
  const A = resolveOrg(a), B = resolveOrg(b);
  return A && B ? A.name === B.name : norm(a) === norm(b);
};

// ---------- relationship strength ----------
const TIE_W = { close: 1, friend: 0.85, professional: 0.6, acquaintance: 0.4 } as const;
export function warmth(c: Contact, today = new Date()) {
  const months = (today.getTime() - new Date(c.lastSpoke).getTime()) / (30 * 86400_000);
  const recency = months < 3 ? 1 : months < 9 ? 0.8 : months < 18 ? 0.6 : 0.4;
  return Math.round(TIE_W[c.tie] * recency * 100);
}
export const monthsSince = (d: string) => Math.max(0, Math.round((Date.now() - new Date(d).getTime()) / (30 * 86400_000)));

// ---------- "who should I call about company X?" ----------
export type Lead = {
  contact: Contact;
  score: number;
  relation: "inside" | "alumni" | "peer" | "theme" | "second";
  why: string;
  via?: Contact;
};

export function leadsForCompany(company: { name: string; symbol?: string; sector?: string; themes?: string[] }, topic?: string): Lead[] {
  const org = resolveOrg(company.symbol ?? company.name) ?? resolveOrg(company.name);
  const sector = org?.sector ?? company.sector;
  const themes = new Set([...(org?.themes ?? []), ...(company.themes ?? [])]);
  const leads: Lead[] = [];
  const now = new Date().getFullYear();
  for (const c of CONTACTS) {
    const here = c.career.find((s) => sameOrg(s.org, org?.name ?? company.name));
    let lead: Lead | null = null;
    if (here && !here.to) {
      lead = { contact: c, score: 90, relation: "inside", why: `Works there now — ${here.role} since ${here.from}` };
    } else if (here) {
      const ago = now - (here.to ?? now);
      lead = { contact: c, score: 78 - ago * 4, relation: "alumni", why: `${here.role} there ${here.from}–${here.to}${ago <= 2 ? " — recent enough to know today's team" : ""}` };
    } else {
      const peer = c.career.find((s) => !s.to && resolveOrg(s.org)?.sector === sector && sector);
      const theme = c.expertise.find((e) => themes.has(e));
      if (peer) lead = { contact: c, score: 60, relation: "peer", why: `At a peer — ${peer.role}, ${peer.org}. Sees the same customers & costs` };
      else if (theme) lead = { contact: c, score: 45, relation: "theme", why: `Go-to on ${theme}` };
    }
    if (lead) {
      if (topic && c.expertise.some((e) => topic.toLowerCase().includes(e))) lead.score += 8;
      lead.score = Math.round(lead.score * 0.6 + warmth(c) * 0.4);
      leads.push(lead);
    }
  }
  // Second-degree: someone you know well who knows an insider.
  for (const l of leads.filter((x) => x.relation === "inside" || x.relation === "alumni")) {
    for (const vid of l.contact.knows) {
      const v = contactById(vid);
      if (!v || leads.some((x) => x.contact.id === v.id && x.relation !== "theme")) continue;
      if (warmth(v) > warmth(l.contact) + 15) {
        leads.push({ contact: l.contact, via: v, score: Math.round(l.score * 0.9), relation: "second", why: `Warm intro via ${v.name} (${v.tie}) — they know each other` });
      }
    }
  }
  return leads.sort((a, b) => b.score - a.score);
}

// ---------- "do I know this person?" — for people named in filings ----------
export type PersonProfile = {
  name: string;
  role?: string;
  employers: { org: string; role?: string; from?: number; to?: number }[];
  education: { school: string; from?: number; to?: number }[];
};

export type Overlap = { contact: Contact; kind: "worked-with" | "studied-with" | "one-away" | "same-alma-mater"; why: string; strength: number };

const yearsOverlap = (a1?: number, a2?: number, b1?: number, b2?: number) => {
  const now = new Date().getFullYear();
  if (a1 == null || b1 == null) return true; // unknown years: treat as possible overlap
  return Math.max(a1, b1) <= Math.min(a2 ?? now, b2 ?? now);
};

export function overlapsForPerson(p: PersonProfile, joiningOrg?: string): Overlap[] {
  const out: Overlap[] = [];
  for (const c of CONTACTS) {
    for (const e of p.employers) {
      for (const s of c.career) {
        if (sameOrg(s.org, e.org)) {
          const both = yearsOverlap(s.from, s.to, e.from, e.to);
          out.push({
            contact: c,
            kind: both ? "worked-with" : "one-away",
            why: both
              ? `Both at ${s.org}${e.from ? ` (${Math.max(s.from, e.from)}–${Math.min(s.to ?? 2026, e.to ?? 2026)})` : ""}`
              : `${c.name.split(" ")[0]} was at ${s.org} ${s.from}–${s.to ?? "now"} — knows the team they came from`,
            strength: both ? 85 : 50,
          });
        }
      }
    }
    for (const ed of p.education) {
      const m = c.education.find((x) => norm(x.school) === norm(ed.school) || norm(ed.school).includes(norm(x.school)));
      if (m) {
        const both = yearsOverlap(m.from, m.to, ed.from, ed.to);
        out.push({ contact: c, kind: both ? "studied-with" : "same-alma-mater", why: `${m.school}${both && ed.from ? `, overlapping years` : " alum"}`, strength: both ? 70 : 35 });
      }
    }
    if (joiningOrg) {
      const inside = c.career.find((s) => !s.to && sameOrg(s.org, joiningOrg));
      if (inside) out.push({ contact: c, kind: "one-away", why: `Will work alongside them at ${inside.org} (${inside.role})`, strength: 65 });
    }
  }
  const best = new Map<string, Overlap>();
  for (const o of out) {
    const s = Math.round(o.strength * 0.6 + warmth(o.contact) * 0.4);
    const cur = best.get(o.contact.id);
    if (!cur || s > cur.strength) best.set(o.contact.id, { ...o, strength: s });
  }
  // The investor themself.
  return [...best.values()].sort((a, b) => b.strength - a.strength);
}

export function investorOverlap(p: PersonProfile): string | null {
  for (const e of p.education) if (INVESTOR.education.some((x) => norm(x.school) === norm(e.school))) return `You both went to ${e.school}`;
  for (const e of p.employers) if (INVESTOR.career.some((x) => sameOrg(x.org, e.org))) return `You both worked at ${e.org}`;
  return null;
}

// ---------- expertise map ----------
export function expertiseMap() {
  const m = new Map<string, Contact[]>();
  for (const c of CONTACTS) for (const e of c.expertise) m.set(e, [...(m.get(e) ?? []), c]);
  return [...m.entries()]
    .map(([theme, people]) => ({ theme, people: people.sort((a, b) => warmth(b) - warmth(a)) }))
    .sort((a, b) => b.people.length - a.people.length);
}
