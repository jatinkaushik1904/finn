"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Alert, Brief, Item } from "@/lib/brief";
import type { Research } from "@/lib/research";
import { ago, inr, inrShort, months, pct, ratio } from "@/components/format";
import { findOrg, interpret, parseHash, Route, symbolFor, Tab, toHash } from "@/components/route";
import { Avatar, Bars, Chevron, Label, ResultsTable, Section, Skeleton, SourceBadge, Stats, Warmth } from "@/components/ui";

const CATS = ["results", "M&A", "management_change", "litigation", "fund_raise", "capex", "credit_rating", "pledging", "insider_trading"] as const;
const CAT_NAME: Record<string, string> = { results: "Results", "M&A": "M&A", management_change: "Mgmt change", litigation: "Litigation", fund_raise: "Fund raise", capex: "Capex", credit_rating: "Rating", pledging: "Pledge", insider_trading: "Insider" };
const WINDOWS = [{ h: 24, l: "24h", long: "24 hours" }, { h: 72, l: "3d", long: "3 days" }, { h: 168, l: "7d", long: "7 days" }, { h: 720, l: "30d", long: "30 days" }];
const PICKS = ["TITAN", "DIXON", "PERSISTENT", "HAL", "NAVINFLUOR"];
const MATERIAL = 45;

type Go = (r: Route, opts?: { replace?: boolean }) => void;
const keyOf = (r: Route) => `${r.tab}/${r.symbol ?? ""}`;

/* ============================== shell ============================== */
export default function App() {
  const [route, setRoute] = useState<Route | null>(null);
  const [today, setToday] = useState("");
  const [seen, setSeen] = useState<Tab[]>([]);
  const [last, setLast] = useState<Partial<Record<Tab, Route>>>({}); // each tab remembers where it was
  const routeRef = useRef<Route | null>(null);
  const scrolls = useRef<Record<string, number>>({});
  const sheetPushed = useRef(false);

  const apply = useCallback((next: Route) => {
    const prev = routeRef.current;
    if (prev) scrolls.current[keyOf(prev)] = window.scrollY;
    if (!next.person) sheetPushed.current = false;
    routeRef.current = next;
    setRoute(next);
    setSeen((s) => (s.includes(next.tab) ? s : [...s, next.tab]));
    setLast((l) => ({ ...l, [next.tab]: { ...next, person: undefined } }));
  }, []);

  useEffect(() => {
    setToday(new Date().toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" }));
    const read = () => apply(parseHash(window.location.hash));
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, [apply]);

  const go: Go = useCallback((r, opts) => {
    const h = toHash(r);
    if (opts?.replace || window.location.hash === h) { history.replaceState(null, "", h); apply(r); }
    else window.location.hash = h; // pushes history; hashchange → apply
  }, [apply]);

  useEffect(() => {
    if (!route) return;
    document.title = route.tab === "ask" && route.symbol ? `${route.symbol} · FINN` : route.tab === "people" ? `${route.theme ?? route.co ?? "People"} · FINN` : route.tab === "ask" ? "Ask · FINN" : "FINN";
  }, [route]);

  // Restore each view's scroll position (top for a view never seen).
  const viewKey = route ? keyOf(route) : "";
  useLayoutEffect(() => { if (viewKey) window.scrollTo(0, scrolls.current[viewKey] ?? 0); }, [viewKey]);

  const openCompany = useCallback((symbol: string) => go({ tab: "ask", symbol }), [go]);
  const openPerson = useCallback((id: string) => {
    const r = routeRef.current; if (!r) return;
    if (!r.person) sheetPushed.current = true;
    go({ ...r, person: id }, { replace: !!r.person });
  }, [go]);
  const closePerson = useCallback(() => {
    const r = routeRef.current; if (!r) return;
    if (sheetPushed.current) { sheetPushed.current = false; history.back(); }
    else go({ ...r, person: undefined }, { replace: true });
  }, [go]);

  const tab = route?.tab;
  return (
    <div className="mx-auto min-h-dvh max-w-md pb-[calc(5.5rem+env(safe-area-inset-bottom))]">
      <header className="sticky top-0 z-30 flex h-14 items-center gap-2 bg-bg/90 px-4 backdrop-blur-md">
        <button onClick={() => go({ tab: "brief" })} className="flex h-10 items-center" aria-label="FINN, go to brief">
          <span className="flex items-baseline gap-2"><span className="text-lg font-semibold tracking-tight">FINN</span><span className="text-xs text-mute">{today}</span></span>
        </button>
        <span className="ml-auto rounded-full border border-line px-2.5 py-1 text-[10px] font-medium uppercase tracking-wider text-mute" title="All contacts are fictional; employers are real companies.">Synthetic network</span>
      </header>

      {!route && <main className="px-4"><Skeleton lines={3} /></main>}
      {seen.includes("brief") && <div hidden={tab !== "brief"}><BriefView onCompany={openCompany} onPerson={openPerson} /></div>}
      {seen.includes("ask") && <div hidden={tab !== "ask"}><AskView symbol={last.ask?.symbol} go={go} onPerson={openPerson} /></div>}
      {seen.includes("people") && <div hidden={tab !== "people"}><PeopleView theme={last.people?.theme} co={last.people?.co} go={go} onPerson={openPerson} onCompany={openCompany} /></div>}

      {route?.person && <PersonSheet id={route.person} onClose={closePerson} onCompany={openCompany} onPerson={openPerson} onTheme={(theme) => go({ tab: "people", theme })} />}

      <nav className="fixed inset-x-0 bottom-0 z-30 mx-auto flex max-w-md border-t border-line bg-bg/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md" aria-label="Sections">
        {([["brief", "Brief", "Push"], ["ask", "Ask", "Pull"], ["people", "People", "Network"]] as const).map(([t, l, sub]) => (
          <button key={t} onClick={() => go(tab === t ? { tab: t } : last[t] ?? { tab: t })}
            aria-current={tab === t ? "page" : undefined}
            className={`relative flex h-14 flex-1 flex-col items-center justify-center ${tab === t ? "text-ink" : "text-mute"}`}>
            {tab === t && <span className="absolute top-0 h-0.5 w-8 rounded-full bg-ink" />}
            <span className="text-sm font-medium">{l}</span>
            <span className="text-[10px] uppercase tracking-wider opacity-70">{sub}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

/* ============================== PUSH ============================== */
type Settings = { hours: number; volX: number; movePct: number; cares: string[] };
const DEFAULTS: Settings = { hours: 24, volX: 2, movePct: 4, cares: ["results", "M&A", "management_change", "litigation"] };
function loadSettings(): Settings {
  try {
    const v = JSON.parse(localStorage.getItem("finn.settings") ?? "null");
    if (v && typeof v.hours === "number" && Array.isArray(v.cares)) return { ...DEFAULTS, ...v };
  } catch {}
  return DEFAULTS;
}

function BriefView({ onCompany, onPerson }: { onCompany: (s: string) => void; onPerson: (id: string) => void }) {
  const [s, setS] = useState<Settings>(loadSettings);
  const [b, setB] = useState<Brief | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const [showRoutine, setShowRoutine] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const slow = useRef(false);
  const manual = useRef(false);
  const [widened, setWidened] = useState<number | null>(null);

  const save = (n: Settings, debounce = false) => {
    slow.current = debounce;
    setS(n);
    try { localStorage.setItem("finn.settings", JSON.stringify(n)); } catch {}
  };

  const key = `${s.hours}|${s.volX}|${s.movePct}|${s.cares.join(",")}|${nonce}`;
  useEffect(() => {
    const ac = new AbortController();
    const t = setTimeout(async () => {
      setLoading(true); setErr(null);
      try {
        // A quiet default window shouldn't open on "nothing": widen 24h → 3d → 7d until something
        // material shows up — unless the investor picked the window themself.
        const tries = manual.current ? [s.hours] : [s.hours, ...[72, 168].filter((h) => h > s.hours)];
        let got: Brief | null = null;
        for (const h of tries) {
          const q = new URLSearchParams({ hours: String(h), volX: String(s.volX), movePct: String(s.movePct), cares: s.cares.join(",") });
          const r = await fetch(`/api/brief?${q}`, { signal: ac.signal });
          const j = await r.json();
          if (j?.error || !Array.isArray(j?.items)) { setErr(j?.error ?? "The brief came back empty."); got = null; break; }
          got = j as Brief;
          if (got.items.some((i) => i.priority >= MATERIAL)) break;
        }
        if (got) { setB(got); setWidened((got.settings?.hours ?? s.hours) !== s.hours ? s.hours : null); }
      } catch {
        if (!ac.signal.aborted) setErr("Couldn't reach FINN's server.");
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    }, slow.current ? 450 : 0);
    slow.current = false;
    return () => { clearTimeout(t); ac.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const items = b?.items ?? [];
  const material = items.filter((i) => i.priority >= MATERIAL);
  const routine = items.filter((i) => i.priority < MATERIAL);
  const shownHours = b?.settings?.hours ?? s.hours;
  const win = WINDOWS.find((w) => w.h === shownHours);
  const folded = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of routine) m.set(i.label, (m.get(i.label) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [routine]);

  return (
    <main className="px-4">
      <div className="flex items-center gap-2 py-2">
        <div className="flex rounded-full border border-line bg-card" role="radiogroup" aria-label="Digest window">
          {WINDOWS.map((w) => (
            <button key={w.h} role="radio" aria-checked={shownHours === w.h} onClick={() => { manual.current = true; save({ ...s, hours: w.h }); }}
              className={`h-10 min-w-11 rounded-full px-3 text-xs font-medium tabular-nums ${shownHours === w.h ? "bg-ink text-bg" : "text-mute"}`}>{w.l}</button>
          ))}
        </div>
        <button onClick={() => setShowSettings(!showSettings)} aria-expanded={showSettings}
          className={`ml-auto flex h-10 items-center gap-1.5 rounded-full border px-3 text-xs tabular-nums ${showSettings ? "border-ink text-ink" : "border-line text-mute"}`}>
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden><path d="M2 4h7M13 4h1M2 12h1M7 12h7M11 2v4M5 10v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" /></svg>
          ±{s.movePct}% · {s.volX}×
        </button>
      </div>

      {showSettings && (
        <div className="mb-3 rounded-2xl border border-line bg-card p-4 text-sm">
          <label className="flex items-center justify-between">
            <span>Price move at close</span><span className="tabular-nums text-mute">beyond ±{s.movePct}%</span>
          </label>
          <input type="range" min={1} max={10} step={0.5} value={s.movePct} aria-label="Price move threshold" onChange={(e) => save({ ...s, movePct: Number(e.target.value) }, true)} className="h-10 w-full" />
          <label className="flex items-center justify-between">
            <span>Volume spike</span><span className="tabular-nums text-mute">{s.volX}× its 20-day average</span>
          </label>
          <input type="range" min={1.5} max={5} step={0.5} value={s.volX} aria-label="Volume spike threshold" onChange={(e) => save({ ...s, volX: Number(e.target.value) }, true)} className="h-10 w-full" />
          <div className="mt-2 text-xs text-mute">Filing types you track (ranked higher)</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {CATS.map((c) => {
              const on = s.cares.includes(c);
              return (
                <button key={c} aria-pressed={on} onClick={() => save({ ...s, cares: on ? s.cares.filter((x) => x !== c) : [...s.cares, c] })}
                  className={`h-10 rounded-full px-3 text-xs ${on ? "bg-accent/15 font-medium text-accent" : "border border-line text-mute"}`}>{CAT_NAME[c]}</button>
              );
            })}
          </div>
          <p className="mt-3 text-[11px] leading-snug text-mute">Moves are checked on each holding&apos;s latest NSE end-of-day bar. Saved on this device.</p>
        </div>
      )}

      {!b && !err && <Skeleton lines={4} label="Reading every NSE filing across 18 holdings…" />}
      {err && (
        <div className="my-4 rounded-2xl border border-line bg-card p-4 text-sm">
          <p className="text-down">{err}</p>
          <button onClick={() => setNonce((n) => n + 1)} className="mt-2 h-10 rounded-full border border-line px-4 text-xs">Try again</button>
        </div>
      )}

      {b && (
        <div className={loading ? "opacity-60 transition-opacity" : "transition-opacity"} aria-busy={loading}>
          <h1 className="pt-2 text-[22px] font-semibold leading-tight tracking-tight">
            {material.length ? `${material.length} thing${material.length > 1 ? "s" : ""} worth your time` : `Nothing material in ${win?.long ?? `${shownHours}h`}`}
          </h1>
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 pb-3 pt-1 text-xs text-mute">
            <span className="tabular-nums">{b.stats.total} filings · {b.stats.companies} holdings · {routine.length} folded</span>
            {loading ? <span>Updating…</span> : <SourceBadge live={b.source !== "snapshot"} at={b.generatedAt} />}
          </div>

          {widened != null && (
            <p className="mb-3 rounded-xl bg-accent/10 px-3 py-2 text-xs text-accent">
              Nothing material in the last {widened}h, so FINN widened to {win?.long ?? `${shownHours}h`}.
            </p>
          )}

          <Alerts alerts={b.alerts ?? []} s={s} onCompany={onCompany} />

          {!material.length && shownHours < 168 && (
            <button onClick={() => save({ ...s, hours: 168 })} className="mb-3 w-full rounded-2xl border border-dashed border-line p-4 text-left text-sm">
              <span className="text-mute">{b.quietHint ?? "A quiet window."}</span> <span className="font-medium">Widen to the last 7 days →</span>
            </button>
          )}

          <div className="space-y-3">
            {material.map((it, i) => <Card key={it.id} it={it} rank={i + 1} onCompany={onCompany} onPerson={onPerson} />)}
          </div>

          {(b.nudges?.length ?? 0) > 0 && (
            <section className="mt-6">
              <Label className="mb-2">Natural reasons to reconnect</Label>
              <div className="divide-y divide-line rounded-2xl border border-line bg-card">
                {b.nudges.map((n) => (
                  <button key={n.id} onClick={() => onPerson(n.id)} className="flex min-h-12 w-full items-start gap-3 p-3 text-left">
                    <Avatar name={n.name} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm"><b className="font-medium">{n.name}</b> <span className="text-mute">· last spoke {months(n.months)} ago</span></div>
                      <div className="text-xs leading-snug text-mute">{n.reason}</div>
                    </div>
                  </button>
                ))}
              </div>
            </section>
          )}

          {routine.length > 0 && (
            <section className="mt-6">
              <button onClick={() => setShowRoutine(!showRoutine)} aria-expanded={showRoutine} className="flex h-10 w-full items-center justify-between text-left">
                <Label>{routine.length} routine filings, folded</Label>
                <span className="flex items-center gap-1 text-xs text-mute">{showRoutine ? "Hide" : "Show"} <Chevron open={showRoutine} /></span>
              </button>
              {!showRoutine && <p className="text-xs leading-relaxed text-mute tabular-nums">{folded.map(([l, n]) => `${l} ${n}`).join(" · ")}</p>}
              {showRoutine && (
                <ul className="mt-1 divide-y divide-line rounded-2xl border border-line bg-card">
                  {routine.map((it) => (
                    <li key={it.id}>
                      <a href={it.url} target="_blank" rel="noreferrer" className="grid min-h-11 grid-cols-[5.5rem_minmax(0,1fr)_auto] items-center gap-2 px-3 py-2 text-xs">
                        <span className="truncate font-medium">{it.symbol}</span>
                        <span className="truncate text-mute"><span className="text-ink">{it.label}</span> · {it.summary}</span>
                        <span className="tabular-nums text-mute">{ago(it.time)}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
      )}
    </main>
  );
}

function Alerts({ alerts, s, onCompany }: { alerts: Alert[]; s: Settings; onCompany: (sym: string) => void }) {
  if (!alerts.length)
    return <p className="mb-3 rounded-xl border border-line px-3 py-2 text-xs text-mute">No unusual moves at the last close: nothing beyond ±{s.movePct}% or {s.volX}× average volume.</p>;
  return (
    <div className="no-scrollbar -mx-4 mb-3 flex gap-2 overflow-x-auto px-4 pb-1">
      {alerts.map((a, i) => (
        <button key={`${a.symbol}-${a.kind}-${i}`} onClick={() => onCompany(a.symbol)} className="min-h-12 max-w-[16rem] shrink-0 rounded-xl border border-line bg-card px-3 py-2 text-left">
          <div className="text-xs font-semibold tabular-nums">
            {a.symbol}{" "}
            <span className={a.kind === "price" ? (a.value >= 0 ? "text-up" : "text-down") : "text-accent"}>
              {a.kind === "price" ? pct(a.value, 1) : a.kind === "volume" ? `${Number(a.value).toFixed(1)}× vol` : ""}
            </span>
          </div>
          <div className="text-[11px] leading-snug text-mute">{a.text}</div>
        </button>
      ))}
    </div>
  );
}

type LeadLike = { id: string; name: string; why: string; via?: string; headline?: string; relation?: string; ask?: string };
/** One row per person: a direct line first, with a warmer second-degree route folded in. */
function mergeLeads<T extends LeadLike>(ls: T[]): (T & { alsoVia?: string })[] {
  const out: (T & { alsoVia?: string })[] = [];
  for (const l of ls) {
    const cur = out.find((x) => x.id === l.id);
    if (!cur) { out.push({ ...l }); continue; }
    if (cur.via && !l.via) { const via = cur.via; Object.assign(cur, l, { via: undefined, alsoVia: via }); }
    else if (l.via && !cur.via && !cur.alsoVia) cur.alsoVia = l.via;
  }
  return out;
}

const first = (n: string) => n.split(" ")[0];
function LeadRow({ l, onPerson, verb = "Call" }: { l: LeadLike & { alsoVia?: string }; onPerson: (id: string) => void; verb?: string }) {
  return (
    <button onClick={() => onPerson(l.id)} className="flex min-h-11 w-full items-start gap-2.5 py-1 text-left">
      <Avatar name={l.name} />
      <div className="min-w-0 text-xs leading-snug">
        <div><span className="font-medium">{l.via ? `Reach ${first(l.name)}` : `${verb} ${first(l.name)}`}</span>{l.via ? <span className="text-mute"> via {l.via}</span> : null}{l.headline && !/^Works there now/.test(l.why) ? <span className="text-mute"> · {l.headline}</span> : null}</div>
        <div className="text-mute">{l.why}</div>
        {l.ask ? <div className="mt-0.5 text-ink/80">Ask: “{l.ask}”</div> : null}
        {l.alsoVia ? <div className="text-accent">Warmer route: intro via {l.alsoVia}</div> : null}
      </div>
    </button>
  );
}

const KIND: Record<string, string> = { "worked-with": "Worked with them", "studied-with": "Studied with them", "one-away": "One step away", "same-alma-mater": "Same alma mater" };

function rankReasons(it: Item) {
  const r: string[] = [`${it.label.toLowerCase()} filing`];
  for (const s of it.signals ?? []) r.push(s.charAt(0).toLowerCase() + s.slice(1));
  const lead = it.leads?.[0] as (LeadLike & { relation?: string }) | undefined;
  if (lead && (lead.relation === "inside" || lead.relation === "alumni" || /^Works there now|there \d{4}–\d{4}/.test(lead.why))) r.push("you know someone there");
  if (it.results) r.push("numbers attached");
  return r;
}

function Card({ it, rank, onCompany, onPerson }: { it: Item; rank: number; onCompany: (s: string) => void; onPerson: (id: string) => void }) {
  const leads = mergeLeads(it.leads ?? []);
  const p = it.person;
  return (
    <article className="rounded-2xl border border-line bg-card p-4">
      <div className="flex items-center gap-2 text-xs">
        <button onClick={() => onCompany(it.symbol)} className="-my-3 truncate py-3 font-semibold">{it.company}</button>
        <span className="shrink-0 rounded-full bg-accent/12 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent">{it.label}</span>
        <span className="ml-auto shrink-0 tabular-nums text-mute">{ago(it.time)}</span>
      </div>
      <p className="mt-2 text-[15px] leading-snug">{it.summary}</p>

      {it.results && (
        <div className="mt-3">
          <ResultsTable period={it.results.period} prevPeriod={it.results.prevPeriod} yoyPeriod={it.results.yoyPeriod} lines={it.results.lines ?? []}
            ebitdaNote={it.results.ebitdaLabel === "EBITDA" || !it.results.ebitdaLabel ? "EBITDA = operating profit" : `PPOP = ${it.results.ebitdaLabel.toLowerCase()}`}
            source={it.results.source} />
        </div>
      )}

      {p && (
        <div className="mt-3 rounded-xl bg-bg p-3 text-sm">
          <div className="font-medium">{p.name}{p.role ? <span className="font-normal text-mute"> · {p.role}</span> : null}</div>
          {p.bio && <p className="mt-1 text-xs leading-relaxed text-mute">{p.bio}</p>}
          {(p.profile?.employers?.length ?? 0) > 0 && <p className="mt-1 text-xs text-mute">Career: {p.profile.employers.map((e) => e.org).slice(0, 4).join(" → ")}</p>}
          {p.you && <p className="mt-2 text-xs font-medium text-accent">{p.you}</p>}
          {(p.overlaps ?? []).map((o) => (
            <button key={o.id} onClick={() => onPerson(o.id)} className="mt-1 flex min-h-10 w-full items-center gap-2 text-left text-xs">
              <Avatar name={o.name} />
              <span className="min-w-0"><b className="font-medium">{o.name}</b> <span className="text-mute">· {KIND[o.kind] ?? o.kind.replace(/-/g, " ")}: {o.why}</span></span>
            </button>
          ))}
          {!p.overlaps?.length && !p.you && <p className="mt-2 text-xs text-mute">No one in your network overlaps with them directly.</p>}
          <p className="mt-2 text-[10px] text-mute">Profile from the filing&apos;s mandatory disclosure · {p.extractedBy}</p>
        </div>
      )}

      {leads.length > 0 && <div className="mt-2">{leads.map((l) => <LeadRow key={l.id + (l.via ?? "")} l={l} onPerson={onPerson} />)}</div>}

      <p className="mt-2 text-[11px] leading-snug text-mute">
        <span className="font-medium tabular-nums text-ink/70">#{rank} · {Math.round(it.priority)}/100</span> · {rankReasons(it).join(" · ")}
      </p>
      <div className="-mb-2 mt-1 flex gap-4 text-xs text-mute">
        <a href={it.url} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center">Filing ↗</a>
        <button onClick={() => onCompany(it.symbol)} className="inline-flex h-10 items-center">Research {it.symbol} →</button>
      </div>
    </article>
  );
}

/* ============================== PULL ============================== */
type R = Research & { isFinancial?: boolean; snapshot?: unknown };
type Verdict = { call?: string; metric?: string; promise: string; horizon?: string; delivered: string; verdict: string; note?: string; quote?: string; speaker?: string; scope?: string };
type NarrStats = { ms?: { total?: number }; transcripts?: { call: string; pdfChars?: number; charsToFast?: number }[]; smart?: { promptChars?: number } };
type Narr = {
  calls: { call: string; url: string; found: number; sentences: string[] }[];
  verdicts: Verdict[] | null;
  bullBear: { bull: string[]; bear: string[] } | null;
  model: { provider: string; fast: string; smart: string } | null;
  // Optional, added by newer API versions.
  snapshot?: unknown; error?: string; partial?: boolean; asOf?: string; cached?: boolean; stats?: NarrStats;
};
const researchCache = new Map<string, R>();
const narrCache = new Map<string, Narr>();
const snapAt = (x: unknown) => (typeof x === "string" ? x : x && typeof x === "object" && "at" in x ? String((x as { at: unknown }).at) : undefined);

function AskView({ symbol, go, onPerson }: { symbol?: string; go: Go; onPerson: (id: string) => void }) {
  const net = useNet();
  const themes = useMemo(() => net.data?.themes.map((t) => t.theme) ?? [], [net.data]);
  const [q, setQ] = useState("");
  const [r, setR] = useState<R | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!symbol) { setR(null); setErr(null); return; }
    const hit = researchCache.get(symbol);
    if (hit) { setR(hit); setErr(null); return; }
    const ac = new AbortController();
    setR(null); setErr(null);
    fetch(`/api/research/${encodeURIComponent(symbol)}`, { signal: ac.signal })
      .then((x) => x.json())
      .then((j) => { if (j?.error || !j?.symbol) setErr(j?.error ?? `Couldn't load ${symbol}.`); else { researchCache.set(symbol, j); setR(j); } })
      .catch(() => { if (!ac.signal.aborted) setErr("Couldn't reach FINN's server."); });
    return () => ac.abort();
  }, [symbol, nonce]);

  const submit = (text: string) => {
    const i = interpret(text, themes);
    if (i.kind === "symbol") go({ tab: "ask", symbol: i.symbol });
    else if (i.kind === "people") go({ tab: "people", theme: i.theme, co: i.co });
    setQ("");
    (document.activeElement as HTMLElement | null)?.blur();
  };

  return (
    <main className="px-4">
      <form onSubmit={(e) => { e.preventDefault(); submit(q); }} className="sticky top-14 z-20 -mx-4 bg-bg px-4 pb-2" role="search">
        <div className="relative">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ticker, company, or “who knows semis”" aria-label="Research a company or ask your network"
            autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="search"
            className="h-12 w-full rounded-2xl border border-line bg-card pl-4 pr-12 text-[15px] outline-none placeholder:text-mute focus:border-accent" />
          <button type="submit" aria-label="Go" disabled={!q.trim()} className="absolute right-1 top-1 grid h-10 w-10 place-items-center rounded-xl text-mute disabled:opacity-40">
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><path d="M3 8h10M9 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        </div>
      </form>

      {!symbol && (
        <div className="space-y-5 py-3">
          <p className="text-sm leading-relaxed text-mute">Any NSE company. FINN reads only primary sources: results filings, annual reports and earnings-call transcripts. No news, no broker notes.</p>
          <div>
            <Label className="mb-2">Research</Label>
            <div className="flex flex-wrap gap-2">{PICKS.map((p) => <button key={p} onClick={() => go({ tab: "ask", symbol: p })} className="h-10 rounded-full border border-line bg-card px-4 text-sm font-medium">{p}</button>)}</div>
          </div>
          <div>
            <Label className="mb-2">Or ask your network</Label>
            <div className="flex flex-wrap gap-2">{["who knows semiconductors", "who can I call about Dixon", "anyone at HDFC Bank"].map((p) => <button key={p} onClick={() => submit(p)} className="h-10 rounded-full border border-line px-4 text-sm">{p}</button>)}</div>
          </div>
          <p className="text-xs leading-relaxed text-mute">Each report: promised vs delivered on the last 4 calls, latest quarter vs QoQ and YoY, 6-year trajectory, balance sheet, cash quality, bull vs bear, and who in your network to call.</p>
        </div>
      )}
      {symbol && !r && !err && <Skeleton lines={5} label={`Reading ${symbol}'s results, annual reports and call transcripts…`} />}
      {symbol && err && (
        <div className="my-4 rounded-2xl border border-line bg-card p-4 text-sm">
          <p className="font-medium">Couldn&apos;t load {symbol}</p>
          <p className="mt-1 text-xs leading-snug text-mute">
            {/\b404\b|not found/i.test(err) ? "No listed company with that NSE ticker. Try the exact symbol, e.g. ASIANPAINT or BAJAJ-AUTO." : `${err.replace(/^Couldn't load [^:]+:\s*/, "")}`}
          </p>
          {!/\b404\b|not found/i.test(err) && <button onClick={() => setNonce((n) => n + 1)} className="mt-3 h-10 rounded-full border border-line px-4 text-xs">Try again</button>}
        </div>
      )}
      {r && r.symbol === symbol && <ResearchView r={r} onPerson={onPerson} />}
    </main>
  );
}

function ResearchView({ r, onPerson }: { r: R; onPerson: (id: string) => void }) {
  const [more, setMore] = useState(false);
  const t = r.trajectory;
  const qtr = r.quarters;
  const n = qtr?.periods?.length ?? 0;
  const at = (a: (number | null)[] | undefined, i: number) => (a && i >= 0 ? a[i] ?? null : null);
  const chg = (a: (number | null)[] | undefined, i: number, j: number) => { const x = at(a, i), y = at(a, j); return x == null || y == null || y === 0 ? null : ((x - y) / Math.abs(y)) * 100; };
  const row = (label: string, a: (number | null)[] | undefined) => ({ label, value: at(a, n - 1), qoq: chg(a, n - 1, n - 2), yoy: chg(a, n - 1, n - 5) });
  const snap = snapAt(r.snapshot);
  const leads = mergeLeads(r.network ?? []);
  const b = r.balance;
  const days = [["Debtor", b?.debtorDays], ["Inventory", b?.inventoryDays], ["Payable", b?.payableDays]].filter(([, v]) => v != null).map(([k, v]) => `${k} ${v}d`);

  return (
    <div className="space-y-3 pb-6">
      <div className="pt-2">
        <h1 className="text-[22px] font-semibold leading-tight tracking-tight">{r.name}</h1>
        <p className="mt-0.5 text-xs text-mute">
          <span className="font-medium text-ink">{r.symbol}</span> · {[r.industry, r.basis].filter(Boolean).join(" · ")}
          {r.snapshot ? <> · <SourceBadge live={false} at={snap} what="screener" /></> : null}
        </p>
        <div className="mt-3 grid grid-cols-4 gap-2 text-center">
          {[["Mkt cap", ratio(r.ratios?.["Market Cap"])], ["P/E", ratio(r.ratios?.["Stock P/E"])], ["ROCE", ratio(r.ratios?.["ROCE"])], ["ROE", ratio(r.ratios?.["ROE"])]].map(([k, v]) => (
            <div key={k} className="rounded-xl border border-line bg-card px-1 py-2">
              <div className="text-[10px] uppercase tracking-wide text-mute">{k}</div>
              <div className="whitespace-nowrap text-xs font-semibold tabular-nums">{v}</div>
            </div>
          ))}
        </div>
        {r.about && (
          <button onClick={() => setMore(!more)} className="mt-3 block text-left text-xs leading-relaxed text-mute">
            <span className={more ? "" : "line-clamp-3"}>{r.about.replace(/\s*\[\d+\]\s*$/, "")}</span>
            {!more && <span className="text-ink"> More</span>}
          </button>
        )}
      </div>

      <Narrative symbol={r.symbol} fallback={r.signals ?? { bull: [], bear: [] }} />

      {n >= 5 && (
        <Section title={`Latest quarter · ${qtr.periods[n - 1]}`}>
          <ResultsTable period={qtr.periods[n - 1]} prevPeriod={qtr.periods[n - 2]} yoyPeriod={qtr.periods[n - 5]}
            lines={[row("Revenue", qtr.revenue), row(r.isFinancial ? "PPOP" : "EBITDA", qtr.ebitda), row("PBT", qtr.pbt), row("PAT", qtr.pat)]}
            ebitdaNote={r.isFinancial ? "PPOP = financing profit" : "EBITDA = operating profit"} source={r.source} />
        </Section>
      )}

      {leads.length > 0 && (
        <Section title="Who can help you understand this">
          {leads.map((l) => <LeadRow key={l.id + (l.via ?? "")} l={l} onPerson={onPerson} verb="Call" />)}
        </Section>
      )}

      {n > 0 && (
        <Section title="Last 8 quarters" aside="₹ cr">
          <Bars labels={qtr.periods} values={qtr.revenue} sub={qtr.opm.map((x) => (x == null ? "" : `${x}%`))} />
          <p className="mt-2 text-[10px] text-mute">Revenue (bars) · {r.isFinancial ? "financing" : "operating"} margin below</p>
        </Section>
      )}

      {t && t.years?.length > 0 && (
        <Section title={<>Trajectory · revenue <span className="tabular-nums">{pct(t.salesCagr3)}</span> / PAT <span className="tabular-nums">{pct(t.patCagr3)}</span> 3-yr CAGR</>} aside="₹ cr">
          <Bars labels={t.years} values={t.sales} sub={t.pat.map((x) => inrShort(x))} />
          <p className="mt-2 text-[10px] text-mute">Revenue (bars) · PAT below</p>
        </Section>
      )}

      {b && (
        <Section title="Balance sheet">
          <Stats items={([
            ["Debt / equity", b.de == null || r.isFinancial ? null : `${b.de.toFixed(2)}×`],
            ["Borrowings", b.borrowings?.at(-1) == null ? null : inr(b.borrowings.at(-1))],
            ["Cash cycle", b.ccc == null ? null : <>{b.ccc}d {b.ccc0 != null ? <span className="font-normal text-mute">(was {b.ccc0}d)</span> : null}</>],
            ["ROCE", b.roce == null ? null : `${b.roce}%`],
          ] as [string, React.ReactNode][]).filter(([, v]) => v != null)} />
          {days.length > 0 && <p className="mt-3 text-[11px] tabular-nums text-mute">{days.join(" · ")}</p>}
          {r.isFinancial && <p className="mt-3 text-[11px] leading-snug text-mute">A lender: deposits and borrowings are its raw material, so debt/equity, cash cycle and cash conversion don&apos;t apply. Asset quality and capital adequacy are in the annual report.</p>}
        </Section>
      )}

      {!r.isFinancial && r.cash?.rows?.some((c) => c.conversion != null) && (
        <Section title={<>Cash quality · <span className="tabular-nums">{r.cash.conversion == null ? "—" : `${r.cash.conversion.toFixed(0)}%`}</span> of profit became cash</>}>
          <div className="space-y-1.5">
            {r.cash.rows.map((c) => (
              <div key={c.year} className="grid grid-cols-[4.5rem_minmax(0,1fr)_3rem] items-center gap-2 text-xs tabular-nums">
                <span className="text-mute">{c.year}</span>
                <div className="h-1.5 overflow-hidden rounded-full bg-bg"><div className={`h-full rounded-full ${(c.conversion ?? 0) >= 80 ? "bg-up" : "bg-down"}`} style={{ width: `${Math.min(100, Math.max(3, c.conversion ?? 0) / 1.5)}%` }} /></div>
                <span className="text-right">{c.conversion == null ? "—" : pct(c.conversion).replace("+", "")}</span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[10px] text-mute">Cash from operations ÷ PAT, per year · green ≥ 80%</p>
        </Section>
      )}

      <Section title="Sources">
        <div className="flex flex-wrap gap-1.5 text-xs">
          {(r.concalls ?? []).filter((c) => c.transcript).slice(0, 4).map((c) => <a key={c.month} href={c.transcript} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center rounded-full border border-line px-3">Call {c.month} ↗</a>)}
          {(r.annualReports ?? []).map((a) => <a key={a.url} href={a.url} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center rounded-full border border-line px-3">{a.title} ↗</a>)}
          {r.source && <a href={r.source} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center rounded-full border border-line px-3">Financials ↗</a>}
        </div>
      </Section>
    </div>
  );
}

const V: Record<string, string> = { delivered: "bg-up/12 text-up", missed: "bg-down/12 text-down", partly: "bg-warn/15 text-warn", "too early": "bg-line text-mute", unverifiable: "border border-line text-mute" };
const ORDER = ["missed", "partly", "delivered", "too early"];
const kChars = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

function VerdictRow({ v, url }: { v: Verdict; url?: string }) {
  return (
    <li className="py-2.5">
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 text-sm font-medium leading-snug">{v.promise}</span>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${V[v.verdict] ?? "bg-line text-mute"}`}>{v.verdict}</span>
      </div>
      <div className="mt-0.5 text-[11px] text-mute">
        {[v.call && `${v.call} call`, v.speaker, v.horizon && `by ${v.horizon}`, v.scope && v.scope !== "company" ? `${v.scope} only` : null].filter(Boolean).join(" · ")}
      </div>
      <p className="mt-1 text-xs leading-snug"><span className="text-mute">Reported: </span>{v.delivered}{v.note ? <span className="text-mute"> {v.note}</span> : null}</p>
      {v.quote && (
        <blockquote className="mt-1.5 border-l-2 border-line pl-2 text-[11px] leading-snug text-mute">
          <span className="line-clamp-2 italic">“{v.quote}”</span>
          {url ? <a href={url} target="_blank" rel="noreferrer" className="py-3.5 underline decoration-line underline-offset-2">transcript ↗</a> : null}
        </blockquote>
      )}
    </li>
  );
}

function Narrative({ symbol, fallback }: { symbol: string; fallback: { bull: string[]; bear: string[] } }) {
  const [nr, setN] = useState<Narr | null>(narrCache.get(symbol) ?? null);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    setShowAll(false);
    const hit = narrCache.get(symbol);
    if (hit) { setN(hit); return; }
    setN(null);
    const ac = new AbortController();
    fetch(`/api/narrative/${encodeURIComponent(symbol)}`, { signal: ac.signal })
      .then((x) => x.json())
      .then((j: Narr) => { const v: Narr = { ...j, calls: j?.calls ?? [], verdicts: j?.verdicts ?? null, bullBear: j?.bullBear ?? null, model: j?.model ?? null }; if (!v.error) narrCache.set(symbol, v); setN(v); })
      .catch(() => { if (!ac.signal.aborted) setN({ calls: [], verdicts: null, bullBear: null, model: null, error: "failed" }); });
    return () => ac.abort();
  }, [symbol]);

  const all = nr?.verdicts ?? [];
  // Verdicts the numbers can actually judge come first; "unverifiable" (e.g. segment margins) folds away.
  const judged = all.filter((v) => v.verdict !== "unverifiable").sort((a, b) => (ORDER.indexOf(a.verdict) + 9) % 9 - (ORDER.indexOf(b.verdict) + 9) % 9);
  const unver = all.filter((v) => v.verdict === "unverifiable");
  const score = [...ORDER, "unverifiable"].map((x) => [x, all.filter((v) => v.verdict === x).length] as const).filter(([, c]) => c > 0);
  const bb = nr?.bullBear ?? fallback;
  const callUrl = (c?: string) => nr?.calls.find((x) => x.call === c)?.url;
  const tr = nr?.stats?.transcripts ?? [];
  const pdfChars = tr.reduce((a, t) => a + (t.pdfChars ?? 0), 0);
  const fastChars = tr.reduce((a, t) => a + (t.charsToFast ?? 0), 0);

  return (
    <>
      <Section title="Promised vs delivered · last 4 calls">
        {!nr && <Skeleton lines={2} label="Reading the last 4 earnings-call transcripts… (~20s the first time)" />}
        {score.length > 0 && (
          <div className="mb-1 flex flex-wrap gap-1.5 text-[10px] font-semibold uppercase tracking-wide tabular-nums">
            {score.map(([x, c]) => <span key={x} className={`rounded-full px-2 py-0.5 ${V[x] ?? "bg-line text-mute"}`}>{c} {x}</span>)}
          </div>
        )}
        {judged.length > 0 && <ul className="divide-y divide-line">{judged.map((v, i) => <VerdictRow key={i} v={v} url={callUrl(v.call)} />)}</ul>}
        {nr && !judged.length && unver.length > 0 && <p className="py-2 text-xs text-mute">Management&apos;s numeric guidance in these calls can&apos;t be checked against reported company-level numbers.</p>}
        {unver.length > 0 && (
          <>
            <button onClick={() => setShowAll(!showAll)} aria-expanded={showAll} className="flex h-10 w-full items-center justify-between border-t border-line text-left text-xs text-mute">
              <span>{unver.length} more {unver.length > 1 ? "promises" : "promise"} the reported numbers can&apos;t verify</span><Chevron open={showAll} />
            </button>
            {showAll && <ul className="divide-y divide-line">{unver.map((v, i) => <VerdictRow key={i} v={v} url={callUrl(v.call)} />)}</ul>}
          </>
        )}
        {nr && !all.length && (
          <div className="space-y-2 text-xs text-mute">
            {nr.calls.flatMap((c) => c.sentences.slice(0, 2).map((s, i) => <p key={c.call + i}><b className="font-medium text-ink">{c.call}:</b> “{s.slice(0, 220)}”</p>))}
            {!nr.calls.length && <p>{nr.error ? "Couldn't read the call transcripts right now." : "No earnings-call transcripts found for this company."}</p>}
            {nr.calls.length > 0 && !nr.model && <p className="text-[11px]">Showing guidance sentences only. Add an LLM key to score them against reported numbers.</p>}
            {nr.calls.length > 0 && nr.model && <p className="text-[11px]">No explicit numeric guidance found to score.</p>}
          </div>
        )}
        {nr && nr.calls.length > 0 && (
          <p className="mt-2 text-[10px] leading-relaxed text-mute">
            Read {nr.calls.map((c, i) => <span key={c.call}>{i ? ", " : ""}<a href={c.url} target="_blank" rel="noreferrer" className="py-3.5 underline decoration-line underline-offset-2">{c.call}</a></span>)}
            {nr.asOf ? ` · judged against numbers to ${nr.asOf}` : null}
            {pdfChars > 0 && fastChars > 0 ? <span className="tabular-nums"> · {kChars(pdfChars)} chars of transcript → {kChars(fastChars)} of management guidance sent to the model</span> : null}
            {nr.model ? ` · extracted by ${nr.model.fast}, judged by ${nr.model.smart}` : null}
            {nr.cached ? " · cached" : null}
            {nr.partial ? " · some calls couldn't be read" : null}
            {nr.snapshot ? " · from a stored snapshot" : null}
          </p>
        )}
      </Section>

      {(bb.bull.length > 0 || bb.bear.length > 0) && (
        <Section title="Bull vs bear" aside={nr?.bullBear ? "from numbers + guidance" : "from reported numbers"}>
          <ul className="space-y-1.5 text-xs leading-snug">
            {bb.bull.map((x, i) => <li key={`b${i}`} className="flex gap-2"><span className="w-3 shrink-0 font-semibold text-up">+</span><span>{x}</span></li>)}
            {bb.bear.map((x, i) => <li key={`s${i}`} className="flex gap-2"><span className="w-3 shrink-0 font-semibold text-down">−</span><span>{x}</span></li>)}
          </ul>
        </Section>
      )}
    </>
  );
}

/* ============================== NETWORK ============================== */
type C = { id: string; name: string; headline: string; city: string; tie: string; howMet: string; lastSpoke: string; months: number; warmth: number; expertise: string[]; career: { org: string; role: string; from: number; to?: number }[]; education: { school: string; degree: string; from: number; to: number }[]; knows: string[] };
type Net = { contacts: C[]; themes: { theme: string; people: { id: string; name: string }[] }[] };
let netCache: Net | null = null;
let netReq: Promise<Net> | null = null;
function useNet() {
  const [data, setData] = useState<Net | null>(netCache);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (netCache) return;
    netReq ??= fetch("/api/network").then((r) => r.json()).then((j: Net) => { if (!Array.isArray(j?.contacts)) throw new Error("bad"); netCache = j; return j; });
    netReq.then(setData).catch(() => { netReq = null; setError(true); });
  }, []);
  return { data, error };
}

type Leads = { company: string; leads: (LeadLike & { relation?: string; score?: number })[] };
const REL: Record<string, string> = { inside: "Inside", alumni: "Alumni", peer: "Peer", theme: "Expert", second: "Intro" };

function PeopleView({ theme, co, go, onPerson, onCompany }: { theme?: string; co?: string; go: Go; onPerson: (id: string) => void; onCompany: (s: string) => void }) {
  const { data: net, error } = useNet();
  const [q, setQ] = useState("");
  const [leads, setLeads] = useState<Leads | null>(null);
  const [leadsErr, setLeadsErr] = useState(false);

  useEffect(() => {
    if (!co) { setLeads(null); return; }
    const ac = new AbortController();
    setLeads(null); setLeadsErr(false);
    fetch(`/api/network?company=${encodeURIComponent(co)}`, { signal: ac.signal })
      .then((r) => r.json()).then((j: Leads) => setLeads({ company: j?.company ?? co, leads: j?.leads ?? [] }))
      .catch(() => { if (!ac.signal.aborted) setLeadsErr(true); });
    return () => ac.abort();
  }, [co]);

  const themes = useMemo(() => net?.themes.map((t) => t.theme) ?? [], [net]);
  const ask = (e: React.FormEvent) => {
    e.preventDefault();
    const text = q.trim(); if (!text) return;
    const i = interpret(text, themes);
    if (i.kind === "people" && (i.theme || i.co)) go({ tab: "people", theme: i.theme, co: i.co });
    else go({ tab: "people", co: findOrg(text)?.name ?? text });
    setQ("");
    (document.activeElement as HTMLElement | null)?.blur();
  };
  const shown = useMemo(() => (theme ? net?.contacts.filter((c) => c.expertise.includes(theme)) : net?.contacts) ?? [], [net, theme]);
  const chips = useMemo(() => {
    const base = net?.themes.filter((t) => t.people.length > 1) ?? [];
    const sel = theme && !base.some((t) => t.theme === theme) ? net?.themes.find((t) => t.theme === theme) : undefined;
    return sel ? [sel, ...base] : base;
  }, [net, theme]);

  if (error) return <main className="px-4 py-6 text-sm text-down">Couldn&apos;t load your network.</main>;
  if (!net) return <main className="px-4"><Skeleton lines={4} label="Loading your network…" /></main>;
  const coSymbol = leads ? symbolFor(leads.company) : undefined;
  const merged = mergeLeads(leads?.leads ?? []);

  return (
    <main className="px-4">
      <form onSubmit={ask} className="pb-2" role="search">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Who should I call about… (company or topic)" aria-label="Find people by company or topic"
          autoCapitalize="none" autoCorrect="off" enterKeyHint="search"
          className="h-12 w-full rounded-2xl border border-line bg-card px-4 text-[15px] outline-none placeholder:text-mute focus:border-accent" />
      </form>

      {co && (
        <Section title={`Who to call about ${leads?.company ?? co}`} aside={<button onClick={() => go({ tab: "people", theme })} className="-my-3 h-10 px-1 text-mute" aria-label="Clear company">Clear ×</button>}>
          {!leads && !leadsErr && <Skeleton lines={1} />}
          {leadsErr && <p className="text-xs text-down">Couldn&apos;t look that up.</p>}
          {leads && (merged.length ? merged.map((l) => (
            <div key={l.id + (l.via ?? "")} className="flex items-start gap-2">
              <div className="min-w-0 flex-1"><LeadRow l={l} onPerson={onPerson} /></div>
              {l.relation && <span className="mt-2 shrink-0 rounded-full border border-line px-2 py-0.5 text-[10px] uppercase tracking-wide text-mute">{REL[l.relation] ?? l.relation}</span>}
            </div>
          )) : <p className="text-xs text-mute">No one in your network yet. A gap worth filling before you need it.</p>)}
          {coSymbol && <button onClick={() => onCompany(coSymbol)} className="mt-1 h-10 text-xs font-medium text-accent">Research {coSymbol} →</button>}
        </Section>
      )}

      <Label className="mb-2 mt-4">Expertise map</Label>
      <div className="flex flex-wrap gap-1.5">
        {chips.map((t) => (
          <button key={t.theme} aria-pressed={theme === t.theme} onClick={() => go({ tab: "people", co, theme: theme === t.theme ? undefined : t.theme }, { replace: true })}
            className={`h-10 rounded-full px-3 text-xs ${theme === t.theme ? "bg-ink text-bg" : "border border-line bg-card"}`}>
            {t.theme} <span className="tabular-nums opacity-60">{t.people.length}</span>
          </button>
        ))}
      </div>

      <div className="mb-2 mt-5 flex items-baseline justify-between">
        <Label>{theme ? `Go-to people for ${theme}` : "Everyone, warmest first"}</Label>
        <span className="text-[10px] text-mute">warmth · last spoke</span>
      </div>
      <div className="divide-y divide-line rounded-2xl border border-line bg-card">
        {shown.map((c) => (
          <button key={c.id} onClick={() => onPerson(c.id)} className="flex min-h-14 w-full items-center gap-3 px-3 py-2.5 text-left">
            <Avatar name={c.name} />
            <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{c.name}</div><div className="truncate text-xs text-mute">{c.headline}</div></div>
            <Warmth v={c.warmth} months={c.months} />
          </button>
        ))}
        {!shown.length && <p className="p-3 text-xs text-mute">No one tagged with {theme} yet.</p>}
      </div>
      <p className="mt-3 text-[11px] leading-snug text-mute">All people are synthetic; their employers are real, so the network overlaps the portfolio. Warmth = tie strength × how recently you spoke.</p>
    </main>
  );
}

function PersonSheet({ id, onClose, onCompany, onPerson, onTheme }: { id: string; onClose: () => void; onCompany: (s: string) => void; onPerson: (id: string) => void; onTheme: (t: string) => void }) {
  const { data: net } = useNet();
  const c = net?.contacts.find((x) => x.id === id);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus({ preventScroll: true });
    return () => { window.removeEventListener("keydown", k); document.body.style.overflow = prev; };
  }, [onClose]);

  return (
    <div className="scrim fixed inset-0 z-40 flex items-end bg-black/45" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={c?.name ?? "Contact"} onClick={(e) => e.stopPropagation()}
        className="sheet relative mx-auto max-h-[85dvh] w-full max-w-md overflow-y-auto overscroll-contain rounded-t-3xl border-t border-line bg-bg px-5 pt-3 pb-[calc(2rem+env(safe-area-inset-bottom))]">
        <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-line" />
        <button ref={closeRef} onClick={onClose} aria-label="Close" className="absolute right-3 top-3 grid h-10 w-10 place-items-center rounded-full text-mute">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        </button>
        {!net ? <Skeleton lines={3} /> : !c ? <p className="py-6 text-sm text-mute">That person isn&apos;t in your network.</p> : (
          <>
            <div className="flex items-center gap-3 pr-10"><Avatar name={c.name} big /><div className="min-w-0"><div className="text-lg font-semibold leading-tight">{c.name}</div><div className="text-xs text-mute">{c.headline} · {c.city}</div></div></div>
            <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-mute"><Warmth v={c.warmth} months={c.months} /><span>{c.tie} · {c.howMet}</span></div>

            <Label className="mb-1 mt-5">Career</Label>
            <ol className="border-l border-line pl-3">
              {[...c.career].reverse().map((s, i) => {
                const sym = symbolFor(s.org);
                return (
                  <li key={i} className="py-1 text-sm leading-snug">
                    {sym ? <button onClick={() => onCompany(sym)} className="-my-3 py-3 font-medium underline decoration-line underline-offset-4">{s.org}</button> : <span className="font-medium">{s.org}</span>}
                    <span className="text-mute"> · {s.role} · <span className="tabular-nums">{s.from}–{s.to ?? "now"}</span></span>
                  </li>
                );
              })}
            </ol>

            <Label className="mb-1 mt-4">Education</Label>
            {c.education.map((e, i) => <p key={i} className="py-0.5 text-sm">{e.school} <span className="text-mute">· {e.degree} · <span className="tabular-nums">{e.from}–{e.to}</span></span></p>)}

            <Label className="mb-2 mt-4">Ask them about</Label>
            <div className="flex flex-wrap gap-1.5">{c.expertise.map((e) => <button key={e} onClick={() => onTheme(e)} className="h-10 rounded-full border border-line bg-card px-3 text-xs">{e}</button>)}</div>

            {c.knows.length > 0 && (
              <>
                <Label className="mb-1 mt-4">Can introduce you to</Label>
                {c.knows.map((k) => net.contacts.find((x) => x.id === k)).filter((x): x is C => !!x).map((k) => (
                  <button key={k.id} onClick={() => onPerson(k.id)} className="flex min-h-11 w-full items-center gap-2.5 text-left">
                    <Avatar name={k.name} /><span className="min-w-0 text-sm"><span className="font-medium">{k.name}</span> <span className="text-xs text-mute">· {k.headline}</span></span>
                  </button>
                ))}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
