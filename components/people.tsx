"use client";
// Network UI pieces: the demo/mine switch + import, what FINN noticed, overlap rows, and the
// "Before you meet management" research section. All matching happens in this browser.
import { useEffect, useMemo, useRef, useState } from "react";
import { knowsGraph, noticed, PersonProfile, sameOrg } from "@/lib/network";
import { PORTFOLIO } from "@/data/universe";
import { Avatar, Chevron, Label, Section, Skeleton } from "./ui";
import { forgetNetwork, importFiles, ImportReport, setMode, useNetworkState } from "./netstore";
import { coverage, Net, overlapsFor, UIOverlap, useNet } from "./netview";

const KIND: Record<string, string> = { "worked-with": "Worked with them", "studied-with": "Studied with them", "one-away": "One step away", "same-alma-mater": "Same alma mater" };
const KIND_LABEL: Record<string, string> = { linkedin: "LinkedIn connections", finn: "FINN sheet", positions: "your positions", education: "your education" };
const dateShort = (iso?: string) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "";
};
const grp = (n: number) => n.toLocaleString("en-IN");
const plural = (n: number, one: string, many = `${one}s`) => `${grp(n)} ${n === 1 ? one : many}`;

/** A person from a filing ↔ someone in your network, with the warmer route when there is one. */
export function OverlapRow({ o, onPerson }: { o: UIOverlap; onPerson: (id: string) => void }) {
  return (
    <button onClick={() => onPerson(o.id)} className="mt-1 flex min-h-10 w-full items-start gap-2 py-0.5 text-left text-xs leading-snug">
      <Avatar name={o.name} />
      <span className="min-w-0 pt-0.5">
        <b className="font-medium">{o.name}</b> <span className="text-mute">· {KIND[o.kind] ?? o.kind.replace(/-/g, " ")}: {o.why}</span>
        {o.via ? <span className="block text-accent">Warmer route via {o.via}{o.viaWhy ? ` (${o.viaWhy})` : ""}<span className="tabular-nums"> · strength {o.path}</span></span> : null}
      </span>
    </button>
  );
}

/* ---------------------------------------------------------------- demo / mine + import */
/** `compact`: a search result is showing, so keep the import instructions out of its way. */
export function NetworkPanel({ compact = false }: { compact?: boolean }) {
  const s = useNetworkState();
  const net = useNet();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [forgot, setForgot] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [drag, setDrag] = useState(false);
  const mine = s.mine;
  const n = mine?.contacts.length ?? 0;
  const stats = useMemo(() => {
    if (!mine) return null;
    const g = knowsGraph(mine.contacts);
    let links = 0;
    for (const l of g.values()) links += l.length;
    return { inside: coverage(mine.contacts).length, links: links / 2 };
  }, [mine]);
  const showImport = open || (!mine && !compact);

  const run = async (files: FileList | File[] | null) => {
    const list = files ? [...files] : [];
    if (!list.length) return;
    setBusy(true); setForgot(null);
    try { const r = await importFiles(list); setReport(r); if (r.total > 0) setOpen(false); } finally { setBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  };

  return (
    <section className={`rounded-2xl border bg-card p-4 ${drag ? "border-accent" : "border-line"}`}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); run(e.dataTransfer.files); }}>
      <div className="flex rounded-full border border-line bg-bg p-0.5" role="radiogroup" aria-label="Which network FINN uses">
        {([["demo", "Demo network", 0], ["mine", "My network", n]] as const).map(([m, l, count]) => (
          <button key={m} role="radio" aria-checked={net.mode === m} disabled={m === "mine" && !mine}
            onClick={() => setMode(m)}
            className={`h-10 flex-1 rounded-full text-xs font-medium tabular-nums disabled:opacity-45 ${net.mode === m ? "bg-ink text-bg" : "text-mute"}`}>
            {l}{m === "mine" && mine ? <span className="opacity-60"> · {grp(count)}</span> : null}
          </button>
        ))}
      </div>

      {net.mode === "demo" ? (
        <p className="mt-2 text-[11px] leading-snug text-mute">Demo: {net.people.length} fictional people at real companies, so it overlaps the portfolio.{mine ? " Switch to see your own." : " Import yours to see who you actually know."}</p>
      ) : mine && (
        <p className="mt-2 text-[11px] leading-snug text-mute tabular-nums">
          {grp(n)} people · inside {stats?.inside ?? 0} of {PORTFOLIO.length} holdings · {plural(stats?.links ?? 0, "likely-know link")} · imported {dateShort(mine.importedAt)} · {s.persisted ? "stored only on this device" : <span className="text-warn">not saved: this browser blocks storage, so it lasts until you close the tab</span>}
        </p>
      )}

      {!mine && !showImport && <button onClick={() => setOpen(true)} className="mt-1 h-10 text-xs font-medium text-accent">Import your network</button>}
      {mine && !open && (
        <div className="mt-1 flex items-center gap-3 text-xs">
          <button onClick={() => setOpen(true)} className="h-10 font-medium text-accent">Add a file</button>
          <button onClick={() => { const k = n; forgetNetwork(); setReport(null); setForgot(k); }} className="ml-auto h-10 text-down">Forget my network</button>
        </div>
      )}
      {forgot != null && !mine && <p className="mt-2 text-xs text-up">Forgotten: {grp(forgot)} people deleted from this device. FINN is back on the demo network.</p>}

      {showImport && (
        <div className={mine ? "mt-2 border-t border-line pt-3" : "mt-3"}>
          {!mine && <h3 className="text-sm font-medium">Import your network</h3>}
          <p className="mt-1 text-xs leading-snug text-mute">
            LinkedIn: Settings → Data privacy → Get a copy of your data → Connections, then drop in <b className="font-medium text-ink">Connections.csv</b>. For past roles, schools and how close you are, add the FINN sheet. Files combine.
          </p>
          <div className="mt-3 flex gap-2">
            <button onClick={() => fileRef.current?.click()} disabled={busy} className="h-10 flex-1 rounded-full bg-ink text-xs font-medium text-bg disabled:opacity-60">{busy ? "Reading…" : "Choose CSV files"}</button>
            <a href="/finn-network-template.csv" download="finn-network-template.csv" className="inline-flex h-10 items-center rounded-full border border-line px-4 text-xs font-medium">Template ↓</a>
            {(mine || compact) && open && <button onClick={() => setOpen(false)} className="h-10 px-2 text-xs text-mute">Done</button>}
          </div>
          <input ref={fileRef} type="file" accept=".csv,text/csv" multiple className="hidden" aria-hidden tabIndex={-1} onChange={(e) => run(e.target.files)} />
          <p className="mt-2 flex gap-1.5 text-[11px] leading-snug text-mute">
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className="mt-0.5 shrink-0"><rect x="2" y="5.5" width="8" height="5.5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M4 5.5V4a2 2 0 0 1 4 0v1.5" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>
            <span>Never uploaded: read and matched in this browser, kept only on this device. Email addresses are dropped as the file is read.</span>
          </p>
        </div>
      )}

      {report && (
        <div className="mt-3 rounded-xl bg-bg p-3 text-xs leading-snug" aria-live="polite">
          {report.files.map((f) => (
            <p key={f.name} className={f.error ? "text-down" : ""}>
              <b className="font-medium">{f.name}</b>{" "}
              {f.error ? `· ${f.error}` : <span className="text-mute tabular-nums">· {KIND_LABEL[f.kind ?? ""] ?? f.kind} · {f.kind === "positions" || f.kind === "education" ? "used for “you both…”" : `${plural(f.contacts.length, "person", "people")}${f.merged ? ` (${grp(f.merged)} merged into people already imported)` : ""}${f.selfRow ? " + your own row" : ""}${f.skipped ? ` · ${plural(f.skipped, "row")} skipped` : ""}`}</span>}
            </p>
          ))}
          {report.total > 0 && <p className="mt-1 font-medium text-up tabular-nums">Now matching {grp(report.total)} people{report.added ? ` (${grp(report.added)} new)` : ""}. Brief, research and People use your network.</p>}
          {report.total === 0 && report.me && <p className="mt-1 text-mute">Saved your own background for the “you both…” line. Add Connections.csv or the FINN sheet to match people.</p>}
          {report.capped && <p className="mt-1 text-warn">Kept the first 8,000 people; larger networks don&apos;t fit in this browser&apos;s storage.</p>}
        </div>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------- what FINN noticed */
const DOT: Record<string, string> = { route: "bg-accent", cold: "bg-warn", gap: "bg-mute", hub: "bg-up" };
export function Noticed({ net, onPerson, onCompanyPeople }: { net: Net; onPerson: (id: string) => void; onCompanyPeople: (co: string) => void }) {
  const list = useMemo(() => noticed(net.contacts), [net.contacts]);
  if (!list.length) return null;
  return (
    <section className="mt-4">
      <Label className="mb-2">What FINN noticed</Label>
      <ul className="divide-y divide-line rounded-2xl border border-line bg-card">
        {list.map((x, i) => (
          <li key={i} className="flex gap-2.5 p-3">
            <span aria-hidden className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${DOT[x.kind]}`} />
            <div className="min-w-0 text-xs leading-snug">
              <p>{x.text}</p>
              {(x.ids.length > 0 || x.symbols.length > 0) && (
                <div className="mt-1 flex flex-wrap gap-x-3">
                  {x.ids.slice(0, 2).map((id) => {
                    const p = net.byId.get(id);
                    return p ? <button key={id} onClick={() => onPerson(id)} className="h-10 font-medium text-accent">{p.name.split(" ")[0]} →</button> : null;
                  })}
                  {x.kind === "gap" && x.symbols.slice(0, 4).map((sym) => {
                    const co = PORTFOLIO.find((h) => h.symbol === sym)?.name ?? sym;
                    return <button key={sym} onClick={() => onCompanyPeople(co)} className="h-10 font-medium text-accent">{sym} peers →</button>;
                  })}
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ---------------------------------------------------------------- before you meet management */
type Stint = { org: string; role?: string | null; from?: number | null; to?: number | null };
type MPerson = {
  name: string; role?: string | null; since?: string | null; source?: "filing" | "concall" | string; filingUrl?: string | null; bio?: string | null;
  career?: Stint[]; education?: { school: string; from?: number | null; to?: number | null }[];
  overlaps?: UIOverlap[]; you?: string | null;
};
type MResp = { symbol: string; people: MPerson[]; askAbout?: { topic: string; why: string; verdict?: string; url?: string }[]; snapshot?: boolean; partial?: boolean };
const meetCache = new Map<string, MResp>();
const V: Record<string, string> = { delivered: "bg-up/12 text-up", missed: "bg-down/12 text-down", partly: "bg-warn/15 text-warn", "too early": "bg-line text-mute", unverifiable: "border border-line text-mute" };
const yy = (y?: number | null) => (y ? `’${String(y).slice(-2)}` : "");
// A filing's profile often gives only the year someone joined: say "from ’90", never "–now".
const years = (from?: number | null, to?: number | null) => (from && to ? `${yy(from)}–${yy(to)}` : from ? `from ${yy(from)}` : to ? `to ${yy(to)}` : "");
const n0 = (v?: number | null) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

// Their PAST employers and schools only: everyone in management "works with" your insider at the
// company itself, and that line is already in "Who can help you understand this".
function profileOf(p: MPerson, company: string): PersonProfile {
  const employers = (p.career ?? []).filter((c) => c?.org && !sameOrg(c.org, company)).map((c) => ({ org: c.org, role: c.role ?? undefined, from: n0(c.from), to: n0(c.to) }));
  return { name: p.name, role: p.role ?? undefined, employers, education: (p.education ?? []).filter((e) => e?.school).map((e) => ({ school: e.school, from: n0(e.from), to: n0(e.to) })) };
}

export function MeetManagement({ symbol, company, onPerson }: { symbol: string; company: string; onPerson: (id: string) => void }) {
  const net = useNet();
  const [d, setD] = useState<MResp | "none" | "error" | null>(meetCache.get(symbol) ?? null);
  const [nonce, setNonce] = useState(0);
  const [all, setAll] = useState(false);
  const tries = useRef(0);
  const lastSymbol = useRef("");
  useEffect(() => {
    setAll(false);
    const hit = meetCache.get(symbol);
    if (hit) { setD(hit); return; }
    if (lastSymbol.current !== symbol) { lastSymbol.current = symbol; tries.current = 0; setD(null); }
    let retry: ReturnType<typeof setTimeout> | undefined;
    const ac = new AbortController();
    fetch(`/api/people/${encodeURIComponent(symbol)}`, { signal: ac.signal })
      .then(async (r) => {
        if (r.status === 404) return setD("none");
        if (!r.ok) return setD("error");
        const j = await r.json().catch(() => null);
        if (!j || !Array.isArray(j.people)) return setD("error");
        const v: MResp = { symbol, people: j.people.filter((p: MPerson) => p && typeof p.name === "string" && p.name.trim()), askAbout: Array.isArray(j.askAbout) ? j.askAbout.filter((a: { topic?: unknown }) => a && typeof a.topic === "string") : [], snapshot: !!j.snapshot, partial: !!j.partial };
        // Still being read (the call transcripts take the longest): show what there is, look again shortly.
        if (v.partial && tries.current < 3) { tries.current++; retry = setTimeout(() => setNonce((x) => x + 1), 12_000); }
        else meetCache.set(symbol, v);
        setD(v);
      })
      .catch(() => { if (!ac.signal.aborted) setD("error"); });
    return () => { ac.abort(); if (retry) clearTimeout(retry); };
  }, [symbol, nonce]);

  // Overlaps are recomputed here, against whichever network is active (demo or your own).
  const people = useMemo(() => (d && typeof d === "object" ? d.people.map((p) => ({ p, ...overlapsFor(profileOf(p, company), undefined, net) })) : []), [d, company, net]);

  if (d === "none") return null;
  const ask = d && typeof d === "object" ? d.askAbout ?? [] : [];
  const shown = all ? people : people.slice(0, 3);
  return (
    <Section title="Before you meet management" aside={d && typeof d === "object" && d.snapshot ? "stored copy" : undefined}>
      {d === null && <Skeleton lines={1} label="Reading management disclosures in recent filings…" />}
      {d === "error" && (
        <div className="text-xs text-mute">Couldn&apos;t load management profiles. <button onClick={() => setNonce((x) => x + 1)} className="h-10 font-medium text-ink">Try again</button></div>
      )}
      {d && typeof d === "object" && !people.length && !ask.length && <p className="text-xs text-mute">No management profiles in recent filings or call transcripts.</p>}
      {shown.length > 0 && (
        <ul className="divide-y divide-line">
          {shown.map(({ p, overlaps, you }, i) => (
            <li key={p.name + i} className="py-2.5 first:pt-0">
              <div className="text-sm leading-snug"><span className="font-medium">{p.name}</span>{p.role ? <span className="text-mute"> · {p.role}</span> : null}</div>
              <div className="text-[11px] text-mute">
                {p.since && dateShort(p.since) ? `appointment filed ${dateShort(p.since)} · ` : ""}
                {p.source === "filing" && p.filingUrl ? <a href={p.filingUrl} target="_blank" rel="noreferrer" className="py-3.5 underline decoration-line underline-offset-2">from the filing ↗</a> : p.source === "concall" ? "named on the earnings call" : "from the filing"}
              </div>
              {(p.career?.length ?? 0) > 0 && (
                <p className="mt-1 text-xs leading-snug"><span className="text-mute">Career </span>
                  {(p.career ?? []).map((c, k) => <span key={k}>{k ? <span className="text-mute"> → </span> : null}{c.org}{years(c.from, c.to) ? <span className="tabular-nums text-mute"> {years(c.from, c.to)}</span> : null}</span>)}
                </p>
              )}
              {(p.education?.length ?? 0) > 0 && (
                <p className="text-xs leading-snug"><span className="text-mute">Studied </span>{(p.education ?? []).map((e) => `${e.school}${e.from || e.to ? ` ${years(e.from, e.to)}` : ""}`).join(" · ")}</p>
              )}
              {p.bio ? <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-mute">{p.bio}</p> : null}
              {you ? <p className="mt-1.5 text-xs font-medium text-accent">{you}</p> : null}
              {overlaps.map((o) => <OverlapRow key={o.id} o={o} onPerson={onPerson} />)}
              {!overlaps.length && !you && <p className="mt-1 text-[11px] text-mute">No one in your {net.mode === "mine" ? "" : "demo "}network overlaps with them.</p>}
            </li>
          ))}
        </ul>
      )}
      {people.length > 3 && (
        <button onClick={() => setAll(!all)} aria-expanded={all} className="flex h-10 w-full items-center justify-between border-t border-line text-left text-xs text-mute">
          <span>{all ? "Fewer people" : `${people.length - 3} more in management`}</span><Chevron open={all} />
        </button>
      )}
      {ask.length > 0 && (
        <div className={people.length ? "mt-2 border-t border-line pt-2.5" : ""}>
          <Label className="mb-1">Worth asking about</Label>
          <ul className="space-y-2">
            {ask.map((a, i) => (
              <li key={i} className="text-xs leading-snug">
                <div className="flex items-start gap-2">
                  <span className="min-w-0 flex-1 font-medium">{a.topic}</span>
                  {a.verdict ? <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${V[a.verdict] ?? "bg-line text-mute"}`}>{a.verdict}</span> : null}
                </div>
                {a.why ? <p className="mt-0.5 text-mute">{a.why}{a.url ? <> <a href={a.url} target="_blank" rel="noreferrer" className="py-3.5 underline decoration-line underline-offset-2">source ↗</a></> : null}</p> : null}
              </li>
            ))}
          </ul>
        </div>
      )}
      {d && typeof d === "object" && (people.length > 0 || ask.length > 0) && (
        <p className="mt-2 text-[10px] leading-snug text-mute">Profiles only from the company&apos;s own filings and calls. Overlaps matched on this device against your {net.mode === "mine" ? "own" : "demo"} network.</p>
      )}
    </Section>
  );
}
