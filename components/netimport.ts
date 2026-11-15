// Import the investor's own network from a CSV, entirely in the browser.
//
// Accepted files (detected by their header row, not their name):
//   - LinkedIn data export "Connections.csv": a few "Notes:" lines, then
//     First Name,Last Name,URL,Email Address,Company,Position,Connected On
//   - FINN template (public/finn-network-template.csv):
//     name,company,role,past_roles,schools,expertise,tie,last_spoke,city
//   - LinkedIn "Positions.csv" / "Education.csv" from the same export: YOUR own background,
//     used only for the "you both went to…" line.
// PRIVACY: nothing here touches the network. Email addresses are dropped while parsing.
import { NetContact, NetEdu, NetStint, Me, Tie, resolveOrg, sameOrg } from "@/lib/network";

// ---------- RFC 4180-ish CSV: quoted fields, "" escapes, embedded newlines, BOM, CRLF ----------
export function parseCSV(text: string, sep = ","): string[][] {
  const s = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"' && cell.trim() === "") { q = true; cell = ""; }
    else if (ch === sep) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ""));
}

export type FileKind = "linkedin" | "finn" | "positions" | "education";
const H = (r: string[]) => r.map((c) => c.toLowerCase().replace(/[^a-z_ ]/g, "").replace(/\s+/g, " ").trim());
function detect(rows: string[][]): { kind: FileKind; at: number } | null {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const h = H(rows[i]);
    if (h.includes("first name") && h.includes("last name")) return { kind: "linkedin", at: i };
    if (h.includes("company name") && h.includes("title")) return { kind: "positions", at: i };
    if (h.includes("school name")) return { kind: "education", at: i };
    if (h.includes("name") && (h.includes("company") || h.includes("role") || h.includes("past_roles") || h.includes("past roles"))) return { kind: "finn", at: i };
  }
  return null;
}

// ---------- dates ----------
const MON = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n: number) => String(n).padStart(2, "0");
/** "09 Nov 2026", "2026-11-09", "11/9/26", "Nov 2026" → "2026-11-09" (or undefined). */
export function isoDate(raw: string | undefined): string | undefined {
  const s = (raw ?? "").trim();
  if (!s) return undefined;
  let m = s.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/);
  if (m) return `${m[1]}-${pad(+m[2])}-${pad(+(m[3] ?? 1))}`;
  m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3})[A-Za-z]*[\s-,]+(\d{4})$/);
  if (m && MON.includes(m[2].toLowerCase())) return `${m[3]}-${pad(MON.indexOf(m[2].toLowerCase()) + 1)}-${pad(+m[1])}`;
  m = s.match(/^([A-Za-z]{3})[A-Za-z]*\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m && MON.includes(m[1].toLowerCase())) return `${m[3]}-${pad(MON.indexOf(m[1].toLowerCase()) + 1)}-${pad(+m[2])}`;
  m = s.match(/^([A-Za-z]{3})[A-Za-z]*\s+(\d{4})$/);
  if (m && MON.includes(m[1].toLowerCase())) return `${m[2]}-${pad(MON.indexOf(m[1].toLowerCase()) + 1)}-01`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/); // US-style m/d/yy, as older exports used
  if (m) { const y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; return `${y}-${pad(+m[1])}-${pad(+m[2])}`; }
  return undefined;
}
const year = (raw: string | undefined) => {
  const m = (raw ?? "").match(/\b(19[5-9]\d|20\d\d)\b/);
  return m ? Number(m[1]) : undefined;
};

// ---------- expertise we can honestly derive: employer's sector themes + the job title ----------
const FUNC: [RegExp, string][] = [
  [/\b(cfo|finance|financial|treasury|controller|accounts?|fp&a)\b/i, "finance"],
  [/\binvestor relations\b|\bIR\b/, "investor relations"],
  [/\b(risk|credit|underwriting)\b/i, "credit risk"],
  [/\b(supply chain|procurement|sourcing|logistics|purchase|purchasing)\b/i, "supply chain"],
  [/\b(sales|business development|channel|distribution|key accounts?)\b/i, "sales & distribution"],
  [/\b(marketing|brand)\b/i, "marketing"],
  [/\b(plant|manufacturing|production|operations|quality)\b/i, "plant operations"],
  [/\b(regulatory|compliance|legal|counsel)\b/i, "regulation"],
  [/\b(strategy|m&a|corporate development)\b/i, "strategy"],
  [/\b(audit|auditor)\b/i, "audit"],
  [/\b(software|engineering manager|developer|data scien\w*|machine learning|ai)\b/i, "technology"],
];
export function deriveExpertise(company?: string, title?: string): string[] {
  const out = new Set<string>(company ? resolveOrg(company)?.themes ?? [] : []);
  for (const [re, tag] of FUNC) if (title && re.test(title)) out.add(tag);
  return [...out];
}

const TIES: Tie[] = ["close", "friend", "professional", "acquaintance"];
const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "contact";
export const nameKey = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z]/g, "");
const listOf = (s: string | undefined) => (s ?? "").split(/;|\n/).map((x) => x.trim()).filter(Boolean);
const monthYear = (iso?: string) => (iso ? new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" }) : "");

export type ParsedFile = {
  name: string; kind: FileKind | null; rows: number; contacts: NetContact[]; me?: Partial<Me>; selfRow?: boolean;
  skipped: number; error?: string;
};

export function parseNetworkFile(text: string, fileName = "file.csv"): ParsedFile {
  let rows = parseCSV(text);
  let d = detect(rows);
  for (const sep of [";", "\t"]) if (!d) { const r = parseCSV(text, sep); const dd = detect(r); if (dd) { rows = r; d = dd; } }
  if (!d) return { name: fileName, kind: null, rows: 0, contacts: [], skipped: 0, error: "Couldn't recognise this file. Use LinkedIn's Connections.csv or the FINN template." };
  const head = H(rows[d.at]).map((h) => h.replace(/ /g, "_"));
  // "# …" lines are notes (the FINN template has one); "(example)" rows are the template's samples.
  const body = rows.slice(d.at + 1).filter((r) => !r[0]?.startsWith("#"));
  const col = (r: string[], ...names: string[]) => { for (const n of names) { const i = head.indexOf(n); if (i >= 0 && r[i]) return r[i]; } return ""; };
  const out: ParsedFile = { name: fileName, kind: d.kind, rows: body.length, contacts: [], skipped: 0 };

  if (d.kind === "positions") {
    out.me = { career: body.map((r) => ({ org: col(r, "company_name"), role: col(r, "title") || undefined, from: year(col(r, "started_on")), to: year(col(r, "finished_on")) })).filter((s) => s.org) };
    return out;
  }
  if (d.kind === "education") {
    out.me = { education: body.map((r) => ({ school: col(r, "school_name"), degree: col(r, "degree_name") || undefined, from: year(col(r, "start_date")), to: year(col(r, "end_date")) })).filter((e) => e.school) };
    return out;
  }

  for (const r of body) {
    if (d.kind === "linkedin") {
      const name = `${col(r, "first_name")} ${col(r, "last_name")}`.replace(/\s+/g, " ").trim();
      if (!name) { out.skipped++; continue; } // deleted / hidden accounts export with blank names
      const company = col(r, "company"), position = col(r, "position");
      const connected = isoDate(col(r, "connected_on"));
      const expertise = deriveExpertise(company, position);
      out.contacts.push({
        id: `li-${slug(name)}`, name, headline: [position, company].filter(Boolean).join(", ") || "LinkedIn connection",
        city: "", tie: "acquaintance", howMet: connected ? `LinkedIn connection since ${monthYear(connected)}` : "LinkedIn connection",
        lastSpoke: connected ?? "", spokeKnown: false,
        career: company ? [{ org: company, role: position || undefined }] : [], education: [], expertise, derivedExpertise: true, knows: [],
        source: "linkedin", url: /^https:\/\/([a-z]+\.)?linkedin\.com\//i.test(col(r, "url")) ? col(r, "url") : undefined,
      });
      // "Email Address" is deliberately never read.
      continue;
    }
    // FINN template
    const name = col(r, "name").replace(/\s+/g, " ").trim();
    if (!name || /\(example\)\s*$/i.test(name)) { out.skipped++; continue; }
    const company = col(r, "company"), role = col(r, "role");
    const past: NetStint[] = listOf(col(r, "past_roles")).map((x) => {
      const [org, rl, from, to] = x.split("|").map((p) => p.trim());
      const f = year(from), t = year(to);
      return { org, role: rl || undefined, from: f, to: t, ...(t == null ? { ended: true } : {}) }; // a past role, even when its end year is missing
    }).filter((s) => s.org);
    const schools: NetEdu[] = listOf(col(r, "schools")).map((x) => {
      const [school, from, to, degree] = x.split("|").map((p) => p.trim());
      return { school, from: year(from), to: year(to), degree: degree || undefined };
    }).filter((e) => e.school);
    const tieRaw = col(r, "tie").toLowerCase();
    if (tieRaw === "self" || tieRaw === "me" || name.toLowerCase() === "me") {
      out.selfRow = true;
      out.me = { career: [...past, ...(company ? [{ org: company, role: role || undefined, from: year(col(r, "since")) }] : [])], education: schools };
      continue;
    }
    const spoke = isoDate(col(r, "last_spoke"));
    const stated = listOf(col(r, "expertise")).map((x) => x.toLowerCase());
    const career = [...past.sort((a, b) => (a.from ?? 0) - (b.from ?? 0)), ...(company ? [{ org: company, role: role || undefined, from: year(col(r, "since")) }] : [])];
    const derived = stated.length ? [] : [...new Set(career.flatMap((s) => deriveExpertise(s.org, s.role)))];
    out.contacts.push({
      id: `me-${slug(name)}`, name, headline: [role, company].filter(Boolean).join(", ") || past.at(-1)?.org || "",
      city: col(r, "city"), tie: (TIES as string[]).includes(tieRaw) ? (tieRaw as Tie) : "professional",
      howMet: col(r, "how_met") || "From your FINN sheet", lastSpoke: spoke ?? "", spokeKnown: !!spoke,
      career, education: schools, expertise: stated.length ? stated : derived, derivedExpertise: !stated.length, knows: listOf(col(r, "knows")),
      source: "finn", url: /^https:\/\/([a-z]+\.)?linkedin\.com\//i.test(col(r, "linkedin", "url")) ? col(r, "linkedin", "url") : undefined,
    });
  }
  return out;
}

// ---------- merge several files into one network ----------
// LinkedIn gives breadth (everyone, current job only); the FINN sheet gives depth (past roles,
// schools, how close you are). Rows for the same person are merged by name.
export function mergeNetwork(base: NetContact[], incoming: NetContact[]): NetContact[] {
  const out = base.map((c) => ({ ...c }));
  const byUrl = new Map(out.filter((c) => c.url).map((c) => [c.url!, c]));
  const byName = new Map<string, NetContact>();
  for (const c of out) if (!byName.has(nameKey(c.name))) byName.set(nameKey(c.name), c);
  const nowAt = (c: NetContact) => c.career.find((s) => s.to == null && !s.ended)?.org;
  const sameNow = (a: NetContact, b: NetContact) => { const x = nowAt(a), y = nowAt(b); return !x || !y || sameOrg(x, y); };
  for (const c of incoming) {
    const named = byName.get(nameKey(c.name));
    // Same profile link; else same name — unless both rows name different current employers
    // (two different "Rahul Sharma"s). A LinkedIn row only merges by name into a sheet row.
    const hit = (c.url && byUrl.get(c.url)) || (named && sameNow(named, c) && (c.source === "finn" || !named.url) ? named : undefined);
    if (!hit) {
      out.push({ ...c });
      if (c.url) byUrl.set(c.url, out[out.length - 1]);
      if (!byName.has(nameKey(c.name))) byName.set(nameKey(c.name), out[out.length - 1]);
      continue;
    }
    if (c.source === "finn") {
      // The sheet is the investor's own word: it wins on tie, history, schools, expertise.
      Object.assign(hit, {
        tie: c.tie, city: c.city || hit.city, howMet: c.howMet && c.howMet !== "From your FINN sheet" ? c.howMet : hit.howMet,
        lastSpoke: c.spokeKnown ? c.lastSpoke : hit.lastSpoke, spokeKnown: c.spokeKnown || hit.spokeKnown,
        career: c.career.length ? c.career : hit.career, education: c.education.length ? c.education : hit.education,
        expertise: c.derivedExpertise ? [...new Set([...hit.expertise, ...c.expertise])] : c.expertise,
        derivedExpertise: c.derivedExpertise && hit.derivedExpertise, knows: [...new Set([...hit.knows, ...c.knows])],
        headline: c.headline || hit.headline, url: hit.url ?? c.url, source: hit.source === "linkedin" ? "linkedin" : "finn",
      });
    } else {
      // A LinkedIn row for someone already here (an earlier export, or the sheet). LinkedIn only
      // owns the profile link and the current job; ties, history and your edits are kept.
      const cur = hit.career.find((x) => x.to == null && !x.ended);
      const job = c.career[0];
      let career = hit.career, headline = hit.headline;
      if (job && !cur) { career = [...hit.career, job]; headline = c.headline; }
      else if (job && cur && !sameOrg(cur.org, job.org)) { career = [...hit.career.map((x) => (x === cur ? { ...x, ended: true } : x)), job]; headline = c.headline; } // moved jobs
      else if (job && cur && !cur.role && job.role) { career = hit.career.map((x) => (x === cur ? { ...x, role: job.role } : x)); }
      Object.assign(hit, {
        url: c.url ?? hit.url, career, headline,
        expertise: hit.derivedExpertise ? [...new Set([...hit.expertise, ...c.expertise])] : hit.expertise,
        howMet: hit.howMet && hit.howMet !== "From your FINN sheet" ? hit.howMet : c.howMet,
        lastSpoke: hit.spokeKnown ? hit.lastSpoke : c.lastSpoke || hit.lastSpoke,
      });
    }
  }
  // Unique ids (two different people called "Rahul Sharma"), then resolve "knows" names to ids.
  const used = new Set<string>();
  for (const c of out) {
    let id = c.id, k = 1;
    while (used.has(id)) id = `${c.id}-${++k}`;
    used.add((c.id = id));
  }
  const idByName = new Map(out.map((c) => [nameKey(c.name), c.id]));
  const ids = new Set(out.map((c) => c.id));
  for (const c of out) c.knows = [...new Set(c.knows.map((k) => (ids.has(k) ? k : idByName.get(nameKey(k)))).filter((k): k is string => !!k && k !== c.id))];
  return out;
}

export function mergeMe(a: Me | null | undefined, b: Partial<Me> | undefined): Me | null {
  if (!b) return a ?? null;
  return { career: b.career?.length ? b.career : a?.career ?? [], education: b.education?.length ? b.education : a?.education ?? [] };
}
