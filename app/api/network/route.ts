import { NextRequest } from "next/server";
import { CONTACTS } from "@/data/network";
import { expertiseMap, knowsGraph, leadsForCompany, monthsSince, resolveOrg, warmth } from "@/lib/network";

export const runtime = "nodejs";

// The DEMO network only (synthetic people). The investor's own imported network never reaches
// this or any other route: the app matches it in the browser with the same lib/network.ts code.
export async function GET(req: NextRequest) {
  const company = req.nextUrl.searchParams.get("company");
  if (company) {
    const org = resolveOrg(company);
    const leads = leadsForCompany({ name: org?.name ?? company, symbol: org?.symbol, sector: org?.sector, themes: org?.themes }, company);
    return Response.json({ company: org?.name ?? company, leads: leads.slice(0, 6).map((l) => ({ id: l.contact.id, name: l.contact.name, headline: l.contact.headline, why: l.why, relation: l.relation, via: l.via?.name, score: l.score, ...(l.path != null ? { path: l.path, edge: l.edge } : {}) })) });
  }
  const g = knowsGraph();
  const edges: { a: string; b: string; strength: number; why: string; kind: string }[] = [];
  for (const [a, list] of g) for (const e of list) if (a < e.id) edges.push({ a, b: e.id, strength: e.strength, why: e.why, kind: e.kind });
  return Response.json({
    contacts: CONTACTS.map((c) => ({ ...c, warmth: warmth(c), months: monthsSince(c.lastSpoke) })).sort((a, b) => b.warmth - a.warmth),
    themes: expertiseMap().map((t) => ({ theme: t.theme, people: t.people.map((p) => ({ id: p.id, name: p.name })) })),
    edges: edges.sort((x, y) => y.strength - x.strength),
  });
}
