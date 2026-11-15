// The client-side join: public data from FINN's API (filings, people named in filings, company
// numbers) × the active network (demo, or the investor's own, which never leaves this device).
// Same lib/network.ts functions the server uses, so demo and imported networks behave alike.
import { useMemo } from "react";
import type { Brief, Item, Nudge } from "@/lib/brief";
import { PORTFOLIO } from "@/data/universe";
import {
  contactIndex, expertiseMap, investorOverlap, isCurrent, knowsGraph, leadsForCompany, Lead, Me, monthsSince, NetContact,
  overlapsForPerson, Overlap, PersonProfile, pickLeads, questionFor, resolveOrg, sameOrg, warmth,
} from "@/lib/network";
import { activeNetwork, Mode, useNetworkState } from "./netstore";

export type Person = NetContact & { warmth: number; months: number };
export type UILead = { id: string; name: string; headline: string; why: string; relation: Lead["relation"]; score: number; via?: string; viaId?: string; edge?: string; path?: number; ask?: string };
export type UIOverlap = { id: string; name: string; kind: string; why: string; strength: number; via?: string; viaId?: string; viaWhy?: string; path?: number };

type View = { contacts: readonly NetContact[]; people: Person[]; byId: Map<string, Person>; themes: { theme: string; people: { id: string; name: string }[] }[] };
const views = new WeakMap<readonly NetContact[], View>();
function viewOf(contacts: readonly NetContact[]): View {
  let v = views.get(contacts);
  if (!v) {
    const people = contacts.map((c) => ({ ...c, warmth: warmth(c), months: monthsSince(c.lastSpoke) })).sort((a, b) => b.warmth - a.warmth || a.name.localeCompare(b.name));
    v = { contacts, people, byId: new Map(people.map((p) => [p.id, p])), themes: expertiseMap(contacts).map((t) => ({ theme: t.theme, people: t.people.map((p) => ({ id: p.id, name: p.name })) })) };
    views.set(contacts, v);
  }
  return v;
}

export type Net = View & { mode: Mode; me: Me | null; ready: boolean };
export function useNet(): Net {
  const s = useNetworkState();
  const a = activeNetwork(s);
  return useMemo(() => ({ ...viewOf(a.contacts), mode: a.mode, me: a.me, ready: s.ready }), [a.contacts, a.mode, a.me, s.ready]);
}

export const toUILead = (l: Lead<NetContact>, ask?: string): UILead => ({
  id: l.contact.id, name: l.contact.name, headline: l.contact.headline, why: l.why, relation: l.relation, score: l.score,
  via: l.via?.name, viaId: l.via?.id, edge: l.edge, path: l.path, ...(ask ? { ask } : {}),
});
const toUIOverlap = (o: Overlap<NetContact>): UIOverlap => ({
  id: o.contact.id, name: o.contact.name, kind: o.kind, why: o.why, strength: o.strength, via: o.via?.name, viaId: o.via?.id, viaWhy: o.viaWhy, path: o.path,
});

export function leadsFor(company: { name: string; symbol?: string; sector?: string; themes?: string[] }, topic: string | undefined, contacts: readonly NetContact[], n: number, category?: string): UILead[] {
  const picked = pickLeads(leadsForCompany(company, topic, contacts), n);
  return picked.map((l, i) => toUILead(l, i === 0 && category ? questionFor(category, l.relation, company.name, topic) : undefined));
}

export function overlapsFor(p: PersonProfile, joiningOrg: string | undefined, net: { contacts: readonly NetContact[]; me: Me | null }, n = 3) {
  return { overlaps: overlapsForPerson(p, joiningOrg, net.contacts).slice(0, n).map(toUIOverlap), you: investorOverlap(p, net.me) };
}

export type JItem = Omit<Item, "leads" | "person"> & {
  leads: UILead[];
  person?: Omit<NonNullable<Item["person"]>, "overlaps"> & { overlaps: UIOverlap[] };
};
export type JNudge = Nudge & { spokeKnown?: boolean };

const MULTI = ["M&A", "capex", "litigation", "management_change", "fund_raise"];
const insideWhy = (why?: string) => !!why && (/^Works there now/.test(why) || /there (\d{4}|\?)–\d{4}/.test(why));

/**
 * Re-join a brief's public items with the active network. With the investor's own network, the
 * small "you know someone there" ranking boost the server gave for the demo network is replaced
 * by the one this network earns, so the demo never shapes what the investor sees.
 */
export function joinBrief(b: Brief, net: { mode: Mode; contacts: readonly NetContact[]; me: Me | null }, material = 45): { items: JItem[]; nudges: JNudge[] } {
  const items: JItem[] = b.items.map((it) => {
    const company = PORTFOLIO.find((c) => c.symbol === it.symbol) ?? { name: it.company, symbol: it.symbol };
    // Only items that are (or, after the ±4 re-ranking below, could become) material get leads.
    const relevant = !it.collapsedInto && it.priority >= material - 8;
    const leads = relevant ? leadsFor(company, it.summary, net.contacts, MULTI.includes(it.category) ? 2 : 1, it.category) : [];
    let person: JItem["person"];
    if (it.person) {
      const joining = it.person.direction === "leaving" ? undefined : company.name;
      const o = overlapsFor(it.person.profile, joining, net);
      person = { ...it.person, overlaps: o.overlaps, you: o.you };
    }
    let priority = it.priority;
    if (net.mode === "mine" && !it.collapsedInto) {
      const was = insideWhy(it.leads?.[0]?.why) ? 4 : 0;
      const now = leads[0] && (leads[0].relation === "inside" || leads[0].relation === "alumni") ? 4 : 0;
      priority = Math.max(0, Math.min(100, (priority >= 100 && it.base != null ? it.base + (it.signals ?? []).reduce((a, s) => a + (/type you track/i.test(s) ? 12 : /moved unusually/i.test(s) ? 8 : 0), 0) : priority) - was + now));
    }
    return { ...it, leads, person, priority };
  });
  if (net.mode === "mine") items.sort((a, z) => z.priority - a.priority || z.time.localeCompare(a.time));

  let nudges: JNudge[] = b.nudges ?? [];
  if (net.mode === "mine") {
    // Keeping the network warm: people whose (ex-)employer just made material news, warmest first.
    const hot = items.filter((i) => i.priority >= material && !i.collapsedInto);
    const out: (JNudge & { w: number })[] = [];
    for (const c of net.contacts) {
      const months = monthsSince(c.lastSpoke);
      if (c.spokeKnown !== false && Number.isFinite(months) && months < 6) continue;
      const hit = hot.find((i) => (c.career ?? []).some((st) => resolveOrg(st.org)?.symbol === i.symbol || sameOrg(st.org, i.company)));
      if (hit) out.push({ id: c.id, name: c.name, months: Number.isFinite(months) ? months : 0, symbol: hit.symbol, spokeKnown: c.spokeKnown !== false, w: warmth(c), reason: `${hit.company}: ${hit.label.toLowerCase()} — ${hit.summary.slice(0, 80)}` });
    }
    nudges = out.sort((a, z) => z.w - a.w).slice(0, 4).map(({ w: _w, ...n }) => n);
  }
  return { items, nudges };
}

/** People who probably know `id`, strongest first (computed from shared employers/schools + recorded edges). */
export function knownBy(id: string, contacts: readonly NetContact[]) {
  const g = knowsGraph(contacts), ids = contactIndex(contacts);
  return (g.get(id) ?? []).map((e) => ({ edge: e, c: ids.get(e.id) })).filter((x): x is { edge: typeof x.edge; c: NetContact } => !!x.c);
}

/** How many of the investor's holdings this network has someone inside right now. */
export function coverage(contacts: readonly NetContact[]) {
  return PORTFOLIO.filter((h) => contacts.some((c) => (c.career ?? []).some((s) => isCurrent(s) && sameOrg(s.org, h.name)))).map((h) => h.symbol);
}
