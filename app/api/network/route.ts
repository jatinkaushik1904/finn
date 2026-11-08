import { NextRequest } from "next/server";
import { CONTACTS } from "@/data/network";
import { expertiseMap, leadsForCompany, monthsSince, resolveOrg, warmth } from "@/lib/network";

export const runtime = "nodejs";

// Network stays server-side; the client only gets what it renders.
export async function GET(req: NextRequest) {
  const company = req.nextUrl.searchParams.get("company");
  if (company) {
    const org = resolveOrg(company);
    const leads = leadsForCompany({ name: org?.name ?? company, symbol: org?.symbol, sector: org?.sector, themes: org?.themes }, company);
    return Response.json({ company: org?.name ?? company, leads: leads.slice(0, 6).map((l) => ({ id: l.contact.id, name: l.contact.name, headline: l.contact.headline, why: l.why, relation: l.relation, via: l.via?.name, score: l.score })) });
  }
  return Response.json({
    contacts: CONTACTS.map((c) => ({ ...c, warmth: warmth(c), months: monthsSince(c.lastSpoke) })).sort((a, b) => b.warmth - a.warmth),
    themes: expertiseMap().map((t) => ({ theme: t.theme, people: t.people.map((p) => ({ id: p.id, name: p.name })) })),
  });
}
