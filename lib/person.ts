// People named in exchange filings: who they are, from the filing's own words.
//
// Used by the brief (a management-change card) and by "before you meet management" (lib/people.ts).
// PRIVACY: the model sees only the public exchange filing and NSE's one-line summary of it.
// Network/contact data never enters this module — overlaps are matched afterwards, by rules.
import { llmJSON } from "./llm";
import { orgsInText, resolveOrg, sameOrg } from "./network";

type Raw = {
  name: string; role: string; joining_or_leaving: string; bio: string;
  employers: { org: string; role?: string; from?: number; to?: number }[];
  education: { school: string; from?: number; to?: number }[];
};
const HONORIFIC = /^(?:mr|ms|mrs|dr|shri|smt|sh|prof)\.?\s+/i;
const NOT_PERSON = /\b(llp|limited|ltd|chartered|accountants|& co|and co|company|bank|board|committee|auditors?|trust|exchange|government|associates|partners|consultants?|advisors?|solicitors|secretaries|services)\b|^m\/s\b|&/i;
const NOT_EMPLOYER = /^(sebi|rbi|reserve bank|nse|bse|national stock exchange|mca|ministry|stock exchange|securities and exchange board|registrar of companies)/i;
const PERSON_SYSTEM =
  "You extract facts from Indian stock-exchange filings about management changes. Use ONLY the document text. Never add outside knowledge. If a field is absent from the document, return an empty string or an empty list.";

export const cleanName = (s?: string) => (s || "").replace(HONORIFIC, "").replace(/\s*\(DIN[^)]*\)/i, "").replace(/\s+/g, " ").trim();
const plausibleName = (n: string, corpus: string) => {
  const parts = n.split(" ").filter(Boolean);
  // Longest run of letters in the surname ("D’Souza" → "Souza"), which must appear in the filing.
  const last = (parts[parts.length - 1]?.match(/[A-Za-z]+/g) ?? []).sort((a, b) => b.length - a.length)[0];
  return parts.length >= 2 && parts.length <= 5 && !NOT_PERSON.test(n) && !!last && last.length >= 2 && new RegExp(`\\b${last}\\b`, "i").test(corpus);
};
// A bio is kept only if it is (nearly) all words from the filing itself.
const grounded = (bio: string, corpus: string) => {
  const words = (bio.toLowerCase().match(/[a-z]{5,}/g) ?? []);
  if (!words.length) return false;
  const c = corpus.toLowerCase();
  return words.filter((w) => c.includes(w)).length / words.length >= 0.75;
};
export const profileSection = (doc: string) => {
  const i = doc.search(/brief profile|profile of (?:the )?(?:director|appointee|mr|ms)|brief resume|background of/i);
  return i >= 0 ? doc.slice(i, i + 2000) : "";
};

// The "who" of a management-change card, as a stable key ("Noel N. Tata" = "Noel N Tata").
export const personKey = (summary: string) => {
  const m = summary.match(/(?:Mr|Ms|Mrs|Dr|Shri|Smt)\.?\s+([A-Z][A-Za-z.'’]*(?:\s+[A-Z][A-Za-z.'’]*){1,3})/);
  const k = m ? cleanName(m[1]).toLowerCase().replace(/[^a-z]/g, "") : "";
  return k.length >= 6 ? k : "";
};
export const CONTINUING = /re-?appoint|re-?designat|extension of (?:the |his |her )?(?:term|tenure)|continuation (?:of|as)|approval .{0,60}for (?:the )?re-?appointment/i;

export type Extracted = {
  name: string; role?: string; bio?: string;
  employers: { org: string; role?: string; from?: number; to?: number }[];
  education: { school: string; from?: number; to?: number }[];
  direction: "joining" | "leaving" | "continuing";
  extractedBy: string;
};

/**
 * The person a filing line is about. The fast model copies name, role, a ≤40-word bio, employers
 * and schools from the filing; code then refuses anything it cannot find in the filing itself
 * (a name whose surname is not in the text, a bio that is not ≥75% the filing's own words).
 * With no model or no document, name and direction still come from the line by rules.
 */
export async function extractPerson(summary: string, doc: string | undefined, company: { name: string; symbol?: string }, deadline: number): Promise<Extracted | undefined> {
  const text = (doc ?? "").replace(/\s+/g, " ");
  const prof = profileSection(text);
  // The cover letter, plus the "brief profile" annexure wherever in the filing it sits.
  const filing = prof && text.indexOf(prof) > 8000 ? `${text.slice(0, 7000)} … ${prof}` : text.slice(0, 12000);
  const ai = filing
    ? await llmJSON<Raw>(
        "fast",
        PERSON_SYSTEM,
        `The filing line this card is about: "${summary}"\n\nReturn JSON {"name":"","role":"","joining_or_leaving":"joining|leaving","bio":"<=40 words, only from the document's brief profile; empty if the document has no profile","employers":[{"org":"","role":"","from":null,"to":null}],"education":[{"school":"","from":null,"to":null}]} for the person that line is about (if several, the most senior). Employers and education only as stated in the document.\n\nDOCUMENT:\n${filing}`,
        900,
        { timeoutMs: Math.max(3000, deadline - Date.now()) },
      )
    : null;
  const corpus = `${summary} ${filing}`;
  const rx = summary.match(/(?:Mr|Ms|Mrs|Dr|Shri|Smt)\.?\s+([A-Z][A-Za-z.'’]*(?:\s+[A-Z][A-Za-z.'’]*){1,3})/);
  const aiName = cleanName(ai?.name);
  const name = plausibleName(aiName, corpus) ? aiName : rx && plausibleName(cleanName(rx[1]), corpus) ? cleanName(rx[1]) : "";
  if (!name) return undefined;
  const usedAI = !!ai && name === aiName;
  const leaving = /leav|retir|resign|ceas|superannu|vacat|cessation|demise|step(?:ped|s)? down/i.test(usedAI ? ai!.joining_or_leaving || summary : summary) && !CONTINUING.test(summary);
  const continuing = !leaving && CONTINUING.test(summary);
  const isCo = (org: string) => (!!company.symbol && resolveOrg(org)?.symbol === company.symbol) || sameOrg(org, company.name);
  let employers = (usedAI ? ai!.employers ?? [] : [])
    .filter((e) => e?.org && !NOT_EMPLOYER.test(e.org.trim()))
    .map((e) => ({ org: e.org, role: e.role || undefined, from: Number(e.from) || undefined, to: Number(e.to) || undefined }));
  if (!employers.length && prof) employers = orgsInText(prof).filter((o) => !NOT_EMPLOYER.test(o.name)).map((o) => ({ org: o.name, role: undefined, from: undefined, to: undefined }));
  // Joining: the company itself is where they are going, not shared history. Leaving or staying: it is.
  if (leaving || continuing) {
    if (!employers.some((e) => isCo(e.org))) employers.push({ org: company.name, role: undefined, from: undefined, to: undefined });
    // A re-appointment letter dates the NEW term, not when they joined: don't present it as tenure.
    if (continuing) employers = employers.map((e) => (isCo(e.org) ? { ...e, from: undefined, to: undefined } : e));
  } else employers = employers.filter((e) => !isCo(e.org));
  const education = (usedAI ? ai!.education ?? [] : [])
    .filter((e) => e?.school)
    .map((e) => ({ school: e.school, from: Number(e.from) || undefined, to: Number(e.to) || undefined }));
  if (!education.length && prof)
    for (const m of prof.match(/\b(IIT [A-Z][a-z]+|IIM [A-Z][a-z]+|XLRI|ISB|SRCC|NMIMS|BITS Pilani|ICAI|Harvard|Wharton|INSEAD|Stanford)\b/g) ?? []) education.push({ school: m, from: undefined, to: undefined });
  return {
    name, role: usedAI ? ai!.role || undefined : undefined,
    bio: usedAI && ai!.bio && grounded(ai!.bio, filing) ? ai!.bio : undefined,
    employers, education, direction: leaving ? "leaving" : continuing ? "continuing" : "joining",
    extractedBy: usedAI ? "LLM (fast tier) on filing PDF" : filing ? "Rules on filing PDF" : "Rules on filing summary",
  };
}
