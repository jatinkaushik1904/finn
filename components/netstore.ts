// Which network FINN matches against, and where the investor's own network lives.
//
// PRIVACY DESIGN: an imported network is kept ONLY in this browser (localStorage, every access in
// try/catch) and matched here with the same lib/network.ts functions the server uses for the
// demo. It is never sent to FINN's API, never put in a model prompt, and "Forget" deletes it.
// The server only ever sends public data (filings, people named in filings, company numbers).
import { useSyncExternalStore } from "react";
import { CONTACTS, INVESTOR } from "@/data/network";
import type { Me, NetContact, NetEdu, NetStint, Tie } from "@/lib/network";
import { mergeMe, mergeNetwork, parseNetworkFile, ParsedFile } from "./netimport";

export type Mode = "demo" | "mine";
export type FileNote = { name: string; kind: string; rows: number; added: number; at: string };
export type Mine = { v: 1; importedAt: string; files: FileNote[]; contacts: NetContact[]; me: Me | null };
type State = { ready: boolean; mode: Mode; mine: Mine | null; persisted: boolean };

const KEY = "finn.mynetwork.v1";
const MODE_KEY = "finn.network.mode";
const MAX = 8000;

const SERVER: State = { ready: false, mode: "demo", mine: null, persisted: true };
let state: State = SERVER;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

// Stored data is re-validated on load: a malformed entry must never crash the app.
const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const TIES: Tie[] = ["close", "friend", "professional", "acquaintance"];
function clean(c: unknown): NetContact | null {
  if (!c || typeof c !== "object") return null;
  const x = c as Record<string, unknown>;
  if (!str(x.id) || !str(x.name)) return null;
  const career: NetStint[] = (Array.isArray(x.career) ? x.career : []).filter((s) => s && typeof s === "object" && str((s as NetStint).org))
    .map((s: NetStint) => ({ org: str(s.org), role: str(s.role) || undefined, from: num(s.from), to: num(s.to), ended: s.ended === true || undefined }));
  const education: NetEdu[] = (Array.isArray(x.education) ? x.education : []).filter((e) => e && typeof e === "object" && str((e as NetEdu).school))
    .map((e: NetEdu) => ({ school: str(e.school), degree: str(e.degree) || undefined, from: num(e.from), to: num(e.to) }));
  return {
    id: str(x.id).replace(/[^a-z0-9_-]/gi, "").slice(0, 60) || "contact", name: str(x.name).slice(0, 120), headline: str(x.headline).slice(0, 200),
    city: str(x.city), tie: TIES.includes(x.tie as Tie) ? (x.tie as Tie) : "acquaintance", howMet: str(x.howMet), lastSpoke: str(x.lastSpoke),
    career, education, expertise: (Array.isArray(x.expertise) ? x.expertise : []).map(str).filter(Boolean),
    knows: (Array.isArray(x.knows) ? x.knows : []).map(str).filter(Boolean),
    source: x.source === "finn" ? "finn" : "linkedin", spokeKnown: x.spokeKnown === true, derivedExpertise: x.derivedExpertise === true,
    url: /^https:\/\/([a-z]+\.)?linkedin\.com\//i.test(str(x.url)) ? str(x.url) : undefined,
  };
}

function load() {
  if (state.ready || typeof window === "undefined") return;
  let mine: Mine | null = null, mode: Mode = "demo";
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (raw && raw.v === 1 && Array.isArray(raw.contacts)) {
      const contacts = raw.contacts.map(clean).filter((c: NetContact | null): c is NetContact => !!c);
      const self = raw.me && typeof raw.me === "object" ? clean({ id: "me", name: "me", ...raw.me }) : null;
      const me = self ? { career: self.career, education: self.education } : null;
      mine = { v: 1, importedAt: str(raw.importedAt), files: Array.isArray(raw.files) ? raw.files : [], contacts, me };
    }
  } catch {}
  try { if (localStorage.getItem(MODE_KEY) === "mine" && mine) mode = "mine"; } catch {}
  state = { ready: true, mode, mine, persisted: true };
}

function save(next: State) {
  let persisted = true;
  try {
    if (next.mine) localStorage.setItem(KEY, JSON.stringify(next.mine));
    else localStorage.removeItem(KEY);
    localStorage.setItem(MODE_KEY, next.mode);
  } catch { persisted = false; } // private mode / quota: keep it in memory for this tab only
  state = { ...next, persisted: next.mine ? persisted : true };
  emit();
}

const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
const snapshot = () => { load(); return state; };

export function useNetworkState() {
  return useSyncExternalStore(subscribe, snapshot, () => SERVER);
}

/** The network every view matches against right now. */
export function activeNetwork(s: State): { mode: Mode; contacts: readonly NetContact[]; me: Me | null } {
  return s.mode === "mine" && s.mine ? { mode: "mine", contacts: s.mine.contacts, me: s.mine.me } : { mode: "demo", contacts: CONTACTS, me: INVESTOR };
}

export function setMode(mode: Mode) {
  load();
  save({ ...state, mode: mode === "mine" && state.mine ? "mine" : "demo" });
}

export type ImportReport = { files: (ParsedFile & { added?: number; merged?: number })[]; total: number; added: number; me: boolean; persisted: boolean; capped: boolean };

/** Parse files in the browser and merge them into the on-device network. */
export async function importFiles(files: File[]): Promise<ImportReport> {
  load();
  const parsed: (ParsedFile & { added?: number; merged?: number })[] = [];
  for (const f of files) {
    try {
      if (f.size > 25 * 1024 * 1024) { parsed.push({ name: f.name, kind: null, rows: 0, contacts: [], skipped: 0, error: "Too big for a contacts file (over 25 MB)." }); continue; }
      parsed.push(parseNetworkFile(await f.text(), f.name));
    } catch {
      parsed.push({ name: f.name, kind: null, rows: 0, contacts: [], skipped: 0, error: "Couldn't read this file." });
    }
  }
  const before = state.mine?.contacts ?? [];
  let contacts = before;
  let me = state.mine?.me ?? null;
  for (const p of parsed) {
    if (p.error) continue;
    if (p.contacts.length) {
      const n0 = contacts.length;
      contacts = mergeNetwork(contacts, p.contacts);
      p.added = contacts.length - n0;
      p.merged = p.contacts.length - p.added; // rows that enriched someone already imported
    }
    if (p.me) me = mergeMe(me, p.me);
  }
  const capped = contacts.length > MAX;
  if (capped) contacts = contacts.slice(0, MAX);
  const ok = parsed.filter((p) => !p.error);
  if (!ok.length) return { files: parsed, total: before.length, added: 0, me: false, persisted: state.persisted, capped: false };
  const at = new Date().toISOString();
  const notes: FileNote[] = [...(state.mine?.files ?? []), ...ok.map((p) => ({ name: p.name.slice(0, 80), kind: p.kind ?? "?", rows: p.rows, added: p.contacts.length, at }))].slice(-12);
  save({ ...state, mode: contacts.length ? "mine" : state.mode, mine: { v: 1, importedAt: at, files: notes, contacts, me } });
  return { files: parsed, total: contacts.length, added: contacts.length - before.length, me: ok.some((p) => !!p.me), persisted: state.persisted, capped };
}

/** "Spoke today", or a corrected tie — the investor's own edits, on the device. */
export function updateContact(id: string, patch: Partial<Pick<NetContact, "tie" | "lastSpoke" | "spokeKnown">>) {
  load();
  if (!state.mine) return;
  save({ ...state, mine: { ...state.mine, contacts: state.mine.contacts.map((c) => (c.id === id ? { ...c, ...patch } : c)) } });
}

export function forgetNetwork() {
  load();
  try { localStorage.removeItem(KEY); localStorage.setItem(MODE_KEY, "demo"); } catch {}
  state = { ready: true, mode: "demo", mine: null, persisted: true };
  emit();
}
