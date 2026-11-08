// URL-hash routing (links + back button work) and plain-language Ask routing.
// Routing is deliberately keyword-based: instant, free, and predictable.
import { OTHER_ORGS, PORTFOLIO } from "@/data/universe";

export type Tab = "brief" | "ask" | "people";
export type Route = { tab: Tab; symbol?: string; theme?: string; co?: string; person?: string };

const TABS: Tab[] = ["brief", "ask", "people"];
const cleanSym = (s: string) => s.toUpperCase().replace(/\.NS$/, "").replace(/[^A-Z0-9&_-]/g, "").slice(0, 20);

export function parseHash(hash: string): Route {
  const [path, qs = ""] = hash.replace(/^#\/?/, "").split("?");
  const [t, arg] = path.split("/");
  const tab: Tab = (TABS as string[]).includes(t) ? (t as Tab) : "brief";
  const p = new URLSearchParams(qs);
  const r: Route = { tab };
  if (tab === "ask" && arg) r.symbol = cleanSym(safeDecode(arg)) || undefined;
  if (tab === "people") {
    r.theme = p.get("theme")?.slice(0, 60) || undefined;
    r.co = p.get("co")?.slice(0, 80) || undefined;
  }
  r.person = p.get("p")?.replace(/[^a-z0-9_-]/gi, "") || undefined;
  return r;
}

export function toHash(r: Route) {
  const path = r.tab + (r.tab === "ask" && r.symbol ? `/${encodeURIComponent(r.symbol)}` : "");
  const p = new URLSearchParams();
  if (r.tab === "people" && r.theme) p.set("theme", r.theme);
  if (r.tab === "people" && r.co) p.set("co", r.co);
  if (r.person) p.set("p", r.person);
  const qs = p.toString();
  return `#${path}${qs ? `?${qs}` : ""}`;
}

function safeDecode(s: string) {
  try { return decodeURIComponent(s); } catch { return s; }
}

// ---------- company directory (client-side, public data only) ----------
// NSE tickers for directory companies outside the portfolio.
const EXTRA_SYMBOLS: Record<string, string> = {
  "Hindustan Aeronautics": "HAL", "Persistent Systems": "PERSISTENT", "Varun Beverages": "VBL", "Navin Fluorine": "NAVINFLUOR",
  "Aarti Industries": "AARTIIND", SRF: "SRF", Infosys: "INFY", Wipro: "WIPRO", "ICICI Bank": "ICICIBANK", "Kotak Mahindra Bank": "KOTAKBANK",
  "Axis Bank": "AXISBANK", "Tata Steel": "TATASTEEL", "Mahindra & Mahindra": "M&M", "Hindustan Unilever": "HINDUNILVR", Cipla: "CIPLA",
  "Dr. Reddy's": "DRREDDY", "Bandhan Bank": "BANDHANBNK", "Berger Paints": "BERGEPAINT", "Kalyan Jewellers": "KALYANKJIL",
  "Avenue Supermarts": "DMART", NSDL: "NSDL",
};

type Org = { name: string; symbol?: string; names: string[] };
const ORGS: Org[] = [
  ...PORTFOLIO.map((c) => ({ name: c.name, symbol: c.symbol, names: [c.name, c.symbol, ...(c.aliases ?? [])] })),
  ...OTHER_ORGS.map((o) => ({ name: o.name, symbol: EXTRA_SYMBOLS[o.name], names: [o.name, ...o.aliases, ...(EXTRA_SYMBOLS[o.name] ? [EXTRA_SYMBOLS[o.name]] : [])] })),
];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Longest company name/alias/ticker mentioned in the text. Short all-caps tickers must match case. */
export function findOrg(text: string): Org | undefined {
  let best: { o: Org; len: number } | undefined;
  for (const o of ORGS) {
    for (const n of o.names) {
      if (n.length < 2) continue;
      const strict = n.length <= 3 && n === n.toUpperCase();
      const re = new RegExp(`(^|[^A-Za-z0-9])${esc(n)}($|[^A-Za-z0-9])`, strict ? "" : "i");
      if (re.test(text) && (!best || n.length > best.len)) best = { o, len: n.length };
    }
  }
  return best?.o;
}

/** Org name → NSE symbol, for linking people's employers to research. */
export function symbolFor(orgName: string): string | undefined {
  const exact = ORGS.find((o) => o.names.some((n) => n.toLowerCase() === orgName.toLowerCase()));
  return (exact ?? findOrg(orgName))?.symbol;
}

// ---------- plain-language Ask routing ----------
export type Intent = { kind: "symbol"; symbol: string } | { kind: "people"; theme?: string; co?: string } | { kind: "none" };

const PEOPLE = /\b(who|whom|anyone|someone|call|knows?|talk|speak|intro|introduce|introduction|network|contacts?|people|experts?|reach)\b/i;
const STOP = new Set("who whom can could should would i me my we do does is are anyone someone somebody call ring knows know talk speak to about on at in for the a an with from intro introduce introduction network contacts contact people expert experts reach out of works worked there any good best person help me please".split(" "));

function findTheme(text: string, themes: string[]) {
  const t = ` ${text.toLowerCase().replace(/[^a-z0-9&\s-]/g, " ").replace(/\s+/g, " ")} `;
  let best: string | undefined;
  for (const th of themes) {
    const forms = [th, th.replace(/s$/, ""), th.replace(/-/g, " ")];
    if (forms.some((f) => f.length > 1 && (t.includes(` ${f} `) || t.includes(` ${f}s `))) && (!best || th.length > best.length)) best = th;
  }
  return best;
}

export function interpret(raw: string, themes: string[]): Intent {
  const q = raw.trim().replace(/[?!.]+$/, "");
  if (!q) return { kind: "none" };
  const org = findOrg(q);
  const theme = findTheme(q, themes);
  const words = q.split(/\s+/);

  if (PEOPLE.test(q) && words.length > 1) {
    if (org) return { kind: "people", co: org.name };
    if (theme) return { kind: "people", theme };
    const rest = words.filter((w) => !STOP.has(w.toLowerCase())).join(" ");
    return rest ? { kind: "people", co: rest } : { kind: "people" };
  }
  if (org?.symbol) return { kind: "symbol", symbol: org.symbol };
  const whole = q.toLowerCase();
  if (theme && (whole === theme || whole === theme.replace(/s$/, "") || whole === `${theme}s`)) return { kind: "people", theme };
  if (words.length === 1) return { kind: "symbol", symbol: cleanSym(q) };
  if (org) return { kind: "people", co: org.name };
  // "tata elxsi" → TATAELXSI; longer sentences → the most ticker-like word.
  const caps = words.find((w) => /^[A-Z0-9&-]{2,}$/.test(w));
  const pick = caps ?? (words.length <= 2 ? words.join("") : words.filter((w) => !STOP.has(w.toLowerCase())).sort((a, b) => b.length - a.length)[0] ?? q);
  return { kind: "symbol", symbol: cleanSym(pick) };
}
