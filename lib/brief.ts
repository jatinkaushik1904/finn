import { promises as fs } from "fs";
import path from "path";
import { PORTFOLIO } from "@/data/universe";
import { CONTACTS } from "@/data/network";
import { announcements, eod, pdfText, pool, Bar } from "./nse";
import { basePriority, Category, CATEGORY_LABEL, classify, cleanSummary } from "./classify";
import { fundamentals, headline, Headline } from "./screener";
import { investorOverlap, leadsForCompany, monthsSince, orgsInText, overlapsForPerson, PersonProfile, resolveOrg } from "./network";
import { llmJSON } from "./llm";

export type Settings = { hours: number; volX: number; movePct: number; cares: Category[] };
export const DEFAULT_SETTINGS: Settings = { hours: 24, volX: 2, movePct: 4, cares: ["results", "M&A", "management_change", "litigation"] };

export type LeadLite = { id: string; name: string; headline: string; why: string; via?: string; score: number };
export type Item = {
  id: string; symbol: string; company: string; time: string; category: Category; label: string;
  priority: number; summary: string; url: string; desc: string;
  results?: Headline & { source: string };
  person?: { name: string; role?: string; profile: PersonProfile; bio?: string; overlaps: { id: string; name: string; kind: string; why: string; strength: number }[]; you?: string | null; extractedBy: string };
  leads?: LeadLite[];
  signals?: string[];
};
export type Alert = { symbol: string; company: string; kind: "volume" | "price"; text: string; date: string; value: number };
export type Nudge = { id: string; name: string; months: number; reason: string; symbol: string };
export type Brief = {
  generatedAt: string; settings: Settings; items: Item[]; alerts: Alert[]; nudges: Nudge[];
  stats: { total: number; material: number; routine: number; companies: number }; source: "live" | "snapshot";
  quietHint?: string;
};

const parseDate = (s: string) => new Date(s.replace(" ", "T") + "+05:30");

function priceAlerts(symbol: string, company: string, bars: Bar[], s: Settings): Alert[] {
  if (bars.length < 10) return [];
  const last = bars[bars.length - 1];
  const prior = bars.slice(-21, -1);
  const avgVol = prior.reduce((a, b) => a + b.volume, 0) / prior.length;
  const out: Alert[] = [];
  const chg = ((last.close - last.prev) / last.prev) * 100;
  if (Math.abs(chg) >= s.movePct)
    out.push({ symbol, company, kind: "price", date: last.date, value: chg, text: `${chg > 0 ? "+" : ""}${chg.toFixed(1)}% on ${last.date} (threshold ±${s.movePct}%)` });
  const vx = last.volume / avgVol;
  if (vx >= s.volX)
    out.push({ symbol, company, kind: "volume", date: last.date, value: vx, text: `Volume ${vx.toFixed(1)}× its 20-day average on ${last.date}` });
  return out;
}

// Pull the appointee's profile out of the filing itself. SEBI LODR requires a
// "brief profile" annexure for every KMP/director appointment — primary data, no scraping.
async function personFromFiling(text: string, url: string): Promise<Item["person"] | undefined> {
  const m = text.match(/(?:Mr\.?|Ms\.?|Mrs\.?|Dr\.?|Shri|Smt\.?)\s+([A-Z][A-Za-z.]*(?:\s+[A-Z][A-Za-z.]*){0,3})/);
  let doc = "";
  try { doc = (await pdfText(url, 6)).slice(0, 12000); } catch {}
  type X = { name: string; role: string; joining_or_leaving: string; bio: string; employers: { org: string; role?: string; from?: number; to?: number }[]; education: { school: string; from?: number; to?: number }[] };
  const ai = doc
    ? await llmJSON<X>(
        "fast",
        "You extract facts from Indian stock-exchange filings about management changes. Use ONLY the document. If a field is absent, use an empty value.",
        `From this filing, return JSON {"name","role","joining_or_leaving":"joining|leaving|retiring","bio":"<=40 words, from the document's brief profile","employers":[{"org","role","from","to"}],"education":[{"school","from","to"}]} for the most senior person whose appointment/cessation is announced.\n\nDOCUMENT:\n${doc}`,
        900,
      )
    : null;
  const name = ai?.name || m?.[1];
  if (!name) return undefined;
  const corpus = doc || text;
  const profile: PersonProfile = {
    name,
    role: ai?.role,
    employers: ai?.employers?.length ? ai.employers : orgsInText(corpus).map((o) => ({ org: o.name })),
    education: ai?.education?.length
      ? ai.education
      : (corpus.match(/\b(IIT [A-Z][a-z]+|IIM [A-Z][a-z]+|ICAI|XLRI|ISB|SRCC|NMIMS|BITS Pilani)\b/g) ?? []).map((s) => ({ school: s })),
  };
  const overlaps = overlapsForPerson(profile).slice(0, 3).map((o) => ({ id: o.contact.id, name: o.contact.name, kind: o.kind, why: o.why, strength: o.strength }));
  return { name, role: ai?.role, profile, bio: ai?.bio, overlaps, you: investorOverlap(profile), extractedBy: ai ? "LLM (fast tier) on filing PDF" : doc ? "Rules on filing PDF" : "Rules on filing summary" };
}

const lite = (l: ReturnType<typeof leadsForCompany>[number]): LeadLite => ({
  id: l.contact.id, name: l.contact.name, headline: l.contact.headline, why: l.why, via: l.via?.name, score: l.score,
});

export async function buildBrief(s: Settings): Promise<Brief> {
  const to = new Date();
  const from = new Date(to.getTime() - Math.max(s.hours, 24) * 3600_000);
  const cutoff = new Date(to.getTime() - s.hours * 3600_000);
  const results = await pool(PORTFOLIO, 4, async (c) => {
    const [anns, bars] = await Promise.all([announcements(c.symbol, from, to), eod(c.symbol, 45).catch(() => [] as Bar[])]);
    return { c, anns, bars };
  });
  const ok = results.filter(Boolean) as NonNullable<(typeof results)[number]>[];
  if (ok.length === 0) return fromSnapshot(s);

  const alerts: Alert[] = ok.flatMap(({ c, bars }) => priceAlerts(c.symbol, c.name, bars, s));
  let items: Item[] = [];
  for (const { c, anns } of ok) {
    for (const a of anns) {
      if (parseDate(a.sort_date) < cutoff) continue;
      const cat = classify(a.desc, a.attchmntText);
      const text = `${a.desc} ${a.attchmntText}`;
      let p = basePriority(cat, text);
      const signals: string[] = [];
      if (s.cares.includes(cat)) { p += 12; signals.push("A type you track"); }
      if (alerts.some((x) => x.symbol === c.symbol)) { p += 8; signals.push("Stock moved unusually"); }
      items.push({
        id: a.seq_id || `${c.symbol}-${a.sort_date}`, symbol: c.symbol, company: c.name, time: parseDate(a.sort_date).toISOString(),
        category: cat, label: CATEGORY_LABEL[cat], priority: Math.min(100, p), summary: cleanSummary(a.attchmntText, c.name),
        url: a.attchmntFile, desc: a.desc, signals,
      });
    }
  }
  // De-duplicate repeated results paperwork (board outcome + ad + presentation) — keep the strongest.
  items.sort((a, b) => b.priority - a.priority || b.time.localeCompare(a.time));

  // Enrich only what earns attention. Cheap → expensive.
  const material = items.filter((i) => i.priority >= 45);
  const resultsFor = [...new Set(material.filter((i) => i.category === "results").map((i) => i.symbol))];
  const heads = new Map<string, Item["results"]>();
  await pool(resultsFor, 3, async (sym) => {
    const f = await fundamentals(sym);
    const h = headline(f);
    if (h) heads.set(sym, { ...h, source: f.source });
  });
  const seenResults = new Set<string>();
  for (const it of material) {
    const company = PORTFOLIO.find((c) => c.symbol === it.symbol)!;
    if (it.category === "results" && heads.get(it.symbol) && !seenResults.has(it.symbol)) {
      it.results = heads.get(it.symbol);
      seenResults.add(it.symbol);
    }
    const leads = leadsForCompany(company, it.summary);
    if (leads.length) {
      const n = ["M&A", "capex", "litigation", "management_change", "fund_raise"].includes(it.category) ? 2 : 1;
      it.leads = leads.slice(0, n).map(lite);
      if (leads[0].relation === "inside" || leads[0].relation === "alumni") it.priority = Math.min(100, it.priority + 4);
    }
  }
  await pool(material.filter((i) => i.category === "management_change" && i.priority >= 60).slice(0, 4), 2, async (it) => {
    it.person = await personFromFiling(it.summary, it.url);
  });
  // Repeat results paperwork from the same company is demoted beneath the enriched card.
  for (const it of items) if (it.category === "results" && !it.results && seenResults.has(it.symbol)) it.priority = Math.min(it.priority, 30);
  items.sort((a, b) => b.priority - a.priority || b.time.localeCompare(a.time));

  // Keeping the network warm: stale contacts whose (ex-)employer just made material news.
  const nudges: Nudge[] = [];
  for (const c of CONTACTS) {
    const months = monthsSince(c.lastSpoke);
    if (months < 6) continue;
    const hit = items.find((i) => i.priority >= 45 && c.career.some((st) => resolveOrg(st.org)?.symbol === i.symbol));
    if (hit) nudges.push({ id: c.id, name: c.name, months, symbol: hit.symbol, reason: `${hit.company}: ${hit.label.toLowerCase()} — ${hit.summary.slice(0, 80)}` });
  }

  const brief: Brief = {
    generatedAt: to.toISOString(), settings: s, items, alerts, nudges: nudges.slice(0, 4),
    stats: { total: items.length, material: items.filter((i) => i.priority >= 45).length, routine: items.filter((i) => i.priority < 45).length, companies: ok.length },
    source: "live",
  };
  if (process.env.FINN_WRITE_SNAPSHOT) {
    await fs.mkdir(path.join(process.cwd(), "data/snapshot"), { recursive: true });
    await fs.writeFile(path.join(process.cwd(), `data/snapshot/brief-${s.hours}.json`), JSON.stringify(brief));
  }
  return brief;
}

// If the exchange blocks us (e.g. a datacenter IP), serve the last good snapshot.
async function fromSnapshot(s: Settings): Promise<Brief> {
  const dir = path.join(process.cwd(), "data/snapshot");
  const files = (await fs.readdir(dir).catch(() => [])).filter((f) => f.startsWith("brief-"));
  const pick = files.map((f) => Number(f.match(/\d+/)?.[0])).filter((h) => h >= s.hours).sort((a, b) => a - b)[0] ?? 168;
  const b = JSON.parse(await fs.readFile(path.join(dir, `brief-${pick}.json`), "utf8")) as Brief;
  const cutoff = new Date(new Date(b.generatedAt).getTime() - s.hours * 3600_000).toISOString();
  b.items = b.items.filter((i) => i.time >= cutoff);
  b.source = "snapshot";
  b.settings = s;
  return b;
}
