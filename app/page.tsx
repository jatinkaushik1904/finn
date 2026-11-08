"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Brief, Item } from "@/lib/brief";
import type { Research } from "@/lib/research";

type Tab = "brief" | "ask" | "people";
const CATS = ["results", "M&A", "management_change", "litigation", "fund_raise", "capex", "credit_rating", "pledging", "insider_trading"] as const;
const CAT_NAME: Record<string, string> = { results: "Results", "M&A": "M&A", management_change: "Mgmt change", litigation: "Litigation", fund_raise: "Fund raise", capex: "Capex", credit_rating: "Rating", pledging: "Pledge", insider_trading: "Insider" };
const WINDOWS = [{ h: 24, l: "24h" }, { h: 72, l: "3d" }, { h: 168, l: "7d" }, { h: 720, l: "30d" }];
const PICKS = ["TITAN", "DIXON", "PERSISTENT", "HAL", "NAVINFLUOR"];

const ago = (iso: string) => {
  const m = (Date.now() - new Date(iso).getTime()) / 60000;
  return m < 60 ? `${Math.round(m)}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};
const cr = (v: number | null | undefined) => (v == null ? "—" : `₹${Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + "k" : v.toFixed(0)} cr`);
const pc = (v: number | null | undefined, d = 0) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(d)}%`);
const tone = (v: number | null | undefined) => (v == null ? "text-mute" : v >= 0 ? "text-up" : "text-down");

function useSettings() {
  const [s, setS] = useState({ hours: 24, volX: 2, movePct: 4, cares: ["results", "M&A", "management_change", "litigation"] as string[] });
  useEffect(() => { try { const v = localStorage.getItem("finn.settings"); if (v) setS(JSON.parse(v)); } catch {} }, []);
  const save = (n: typeof s) => { setS(n); try { localStorage.setItem("finn.settings", JSON.stringify(n)); } catch {} };
  return [s, save] as const;
}

export default function App() {
  const [tab, setTab] = useState<Tab>("brief");
  const [symbol, setSymbol] = useState<string | null>(null);
  const [person, setPerson] = useState<string | null>(null);
  const openCompany = (s: string) => { setSymbol(s); setTab("ask"); window.scrollTo(0, 0); };
  return (
    <div className="mx-auto min-h-dvh max-w-md pb-24">
      <header className="sticky top-0 z-20 flex items-center justify-between bg-bg/90 px-4 pb-2 pt-4 backdrop-blur">
        <div className="flex items-baseline gap-2">
          <span className="text-lg font-semibold tracking-tight">FINN</span>
          <span className="text-xs text-mute">{new Date().toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })}</span>
        </div>
        <span className="rounded-full border border-line px-2 py-0.5 text-[10px] uppercase tracking-wider text-mute">Demo · synthetic network</span>
      </header>
      {tab === "brief" && <BriefView onCompany={openCompany} onPerson={setPerson} />}
      {tab === "ask" && <AskView symbol={symbol} setSymbol={setSymbol} onPerson={setPerson} />}
      {tab === "people" && <PeopleView onPerson={setPerson} onCompany={openCompany} />}
      {person && <PersonSheet id={person} onClose={() => setPerson(null)} onCompany={(s) => { setPerson(null); openCompany(s); }} />}
      <nav className="fixed inset-x-0 bottom-0 z-30 mx-auto flex max-w-md justify-around border-t border-line bg-bg/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
        {([["brief", "Brief", "Push"], ["ask", "Ask", "Pull"], ["people", "People", "Network"]] as const).map(([t, l, sub]) => (
          <button key={t} onClick={() => setTab(t)} className={`flex-1 py-3 text-center ${tab === t ? "text-ink" : "text-mute"}`}>
            <div className="text-sm font-medium">{l}</div>
            <div className="text-[10px] uppercase tracking-wider opacity-70">{sub}</div>
          </button>
        ))}
      </nav>
    </div>
  );
}

/* ----------------------------- PUSH ----------------------------- */
function BriefView({ onCompany, onPerson }: { onCompany: (s: string) => void; onPerson: (id: string) => void }) {
  const [s, save] = useSettings();
  const [b, setB] = useState<Brief | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showRoutine, setShowRoutine] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const load = useCallback(async () => {
    setB(null); setErr(null);
    const q = new URLSearchParams({ hours: String(s.hours), volX: String(s.volX), movePct: String(s.movePct), cares: s.cares.join(",") });
    const r = await fetch(`/api/brief?${q}`);
    const j = await r.json();
    if (j.error) setErr(j.error); else setB(j);
  }, [s]);
  useEffect(() => { load(); }, [load]);
  const material = b?.items.filter((i) => i.priority >= 45) ?? [];
  const routine = b?.items.filter((i) => i.priority < 45) ?? [];
  return (
    <main className="px-4">
      <div className="flex items-center gap-1.5 py-2">
        {WINDOWS.map((w) => (
          <button key={w.h} onClick={() => save({ ...s, hours: w.h })} className={`rounded-full px-3 py-1 text-xs ${s.hours === w.h ? "bg-ink text-bg" : "border border-line text-mute"}`}>{w.l}</button>
        ))}
        <button onClick={() => setShowSettings(!showSettings)} className="ml-auto rounded-full border border-line px-3 py-1 text-xs text-mute">Alerts ⚙</button>
      </div>
      {showSettings && (
        <div className="mb-3 rounded-2xl border border-line bg-card p-4 text-sm">
          <label className="flex items-center justify-between py-1">Volume spike <span className="tabular-nums text-mute">{s.volX}× 20d avg</span></label>
          <input type="range" min={1.5} max={5} step={0.5} value={s.volX} onChange={(e) => save({ ...s, volX: Number(e.target.value) })} className="w-full" />
          <label className="flex items-center justify-between py-1">Price move <span className="tabular-nums text-mute">±{s.movePct}% / day</span></label>
          <input type="range" min={1} max={10} step={0.5} value={s.movePct} onChange={(e) => save({ ...s, movePct: Number(e.target.value) })} className="w-full" />
          <div className="mt-2 text-xs text-mute">Always surface</div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {CATS.map((c) => (
              <button key={c} onClick={() => save({ ...s, cares: s.cares.includes(c) ? s.cares.filter((x) => x !== c) : [...s.cares, c] })}
                className={`rounded-full px-2.5 py-1 text-xs ${s.cares.includes(c) ? "bg-accent/15 text-accent" : "border border-line text-mute"}`}>{CAT_NAME[c]}</button>
            ))}
          </div>
        </div>
      )}
      {!b && !err && <Skeleton lines={4} label="Reading today's filings across 18 holdings…" />}
      {err && <p className="py-8 text-sm text-down">{err}</p>}
      {b && (
        <>
          <h1 className="pb-1 pt-2 text-[22px] font-semibold leading-tight tracking-tight">
            {material.length ? `${material.length} thing${material.length > 1 ? "s" : ""} worth your time` : "Nothing material"}
          </h1>
          <p className="pb-3 text-xs text-mute">
            {b.stats.total} filings across {b.stats.companies} holdings · {routine.length} routine folded · {b.source === "snapshot" ? "cached snapshot" : "live from NSE"}
          </p>
          {b.alerts.length > 0 && (
            <div className="-mx-4 mb-3 flex gap-2 overflow-x-auto px-4 pb-1">
              {b.alerts.map((a, i) => (
                <button key={i} onClick={() => onCompany(a.symbol)} className="shrink-0 rounded-xl border border-line bg-card px-3 py-2 text-left">
                  <div className="text-xs font-semibold">{a.symbol} <span className={a.kind === "price" ? tone(a.value) : "text-accent"}>{a.kind === "price" ? pc(a.value, 1) : `${a.value.toFixed(1)}× vol`}</span></div>
                  <div className="text-[11px] text-mute">{a.text}</div>
                </button>
              ))}
            </div>
          )}
          {!material.length && s.hours < 168 && (
            <button onClick={() => save({ ...s, hours: 168 })} className="mb-3 w-full rounded-2xl border border-dashed border-line p-4 text-left text-sm text-mute">
              Quiet window. Widen to the last 7 days →
            </button>
          )}
          <div className="space-y-3">
            {material.map((it) => <Card key={it.id} it={it} onCompany={onCompany} onPerson={onPerson} />)}
          </div>
          {b.nudges.length > 0 && (
            <section className="mt-6">
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-mute">Natural reasons to reconnect</h2>
              <div className="divide-y divide-line rounded-2xl border border-line bg-card">
                {b.nudges.map((n) => (
                  <button key={n.id} onClick={() => onPerson(n.id)} className="block w-full p-3 text-left">
                    <div className="text-sm"><b className="font-medium">{n.name}</b> <span className="text-mute">· last spoke {n.months} mo ago</span></div>
                    <div className="text-xs text-mute">{n.reason}</div>
                  </button>
                ))}
              </div>
            </section>
          )}
          {routine.length > 0 && (
            <section className="mt-6">
              <button onClick={() => setShowRoutine(!showRoutine)} className="flex w-full items-center justify-between text-xs font-medium uppercase tracking-wider text-mute">
                <span>{routine.length} routine filings</span><span>{showRoutine ? "Hide" : "Show"}</span>
              </button>
              {showRoutine && (
                <ul className="mt-2 divide-y divide-line">
                  {routine.map((it) => (
                    <li key={it.id} className="flex gap-2 py-2 text-xs">
                      <span className="w-20 shrink-0 font-medium">{it.symbol}</span>
                      <a href={it.url} target="_blank" rel="noreferrer" className="flex-1 text-mute">{it.label} · {it.summary.slice(0, 90)}</a>
                      <span className="text-mute">{ago(it.time)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </>
      )}
    </main>
  );
}

function Card({ it, onCompany, onPerson }: { it: Item; onCompany: (s: string) => void; onPerson: (id: string) => void }) {
  return (
    <article className="rounded-2xl border border-line bg-card p-4">
      <div className="flex items-center gap-2 text-xs">
        <button onClick={() => onCompany(it.symbol)} className="font-semibold">{it.company}</button>
        <span className="rounded-full bg-accent/12 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent">{it.label}</span>
        <span className="ml-auto text-mute">{ago(it.time)}</span>
      </div>
      <p className="mt-2 text-[15px] leading-snug">{it.summary}</p>
      {it.results && (
        <div className="mt-3 rounded-xl bg-bg p-3">
          <div className="mb-1 flex text-[10px] uppercase tracking-wider text-mute">
            <span className="flex-1">{it.results.period}</span><span className="w-16 text-right">QoQ</span><span className="w-16 text-right">YoY</span>
          </div>
          {it.results.lines.map((l) => (
            <div key={l.label} className="flex py-0.5 text-sm tabular-nums">
              <span className="w-16 text-mute">{l.label}</span><span className="flex-1">{cr(l.value)}</span>
              <span className={`w-16 text-right ${tone(l.qoq)}`}>{pc(l.qoq)}</span><span className={`w-16 text-right ${tone(l.yoy)}`}>{pc(l.yoy)}</span>
            </div>
          ))}
          <div className="mt-1 text-[10px] text-mute">vs {it.results.prevPeriod} and {it.results.yoyPeriod} · EBITDA = operating profit</div>
        </div>
      )}
      {it.person && (
        <div className="mt-3 rounded-xl bg-bg p-3 text-sm">
          <div className="font-medium">{it.person.name}{it.person.role ? <span className="font-normal text-mute"> · {it.person.role}</span> : null}</div>
          {it.person.bio && <p className="mt-1 text-xs leading-relaxed text-mute">{it.person.bio}</p>}
          {it.person.profile.employers.length > 0 && <p className="mt-1 text-xs text-mute">Career: {it.person.profile.employers.map((e) => e.org).slice(0, 4).join(" → ")}</p>}
          {it.person.you && <p className="mt-2 text-xs text-accent">★ {it.person.you}</p>}
          {it.person.overlaps.map((o) => (
            <button key={o.id} onClick={() => onPerson(o.id)} className="mt-2 block text-left text-xs"><b className="font-medium">{o.name}</b> <span className="text-mute">· {o.kind.replace(/-/g, " ")} — {o.why}</span></button>
          ))}
          {!it.person.overlaps.length && !it.person.you && <p className="mt-2 text-xs text-mute">No one in your network overlaps directly.</p>}
          <p className="mt-2 text-[10px] text-mute">Profile from the filing&apos;s mandatory disclosure · {it.person.extractedBy}</p>
        </div>
      )}
      {it.leads && it.leads.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {it.leads.map((l) => (
            <button key={l.id + (l.via ?? "")} onClick={() => onPerson(l.id)} className="flex w-full items-start gap-2 text-left">
              <Avatar name={l.name} />
              <div className="text-xs leading-snug"><span className="font-medium">Call {l.name.split(" ")[0]}</span>{l.via ? <span className="text-mute"> via {l.via}</span> : null}<div className="text-mute">{l.why}</div></div>
            </button>
          ))}
        </div>
      )}
      <div className="mt-3 flex gap-3 text-xs text-mute">
        <a href={it.url} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">Filing ↗</a>
        <button onClick={() => onCompany(it.symbol)} className="underline-offset-2 hover:underline">Research {it.symbol} →</button>
        {it.signals?.length ? <span className="ml-auto">{it.signals.join(" · ")}</span> : null}
      </div>
    </article>
  );
}

/* ----------------------------- PULL ----------------------------- */
function AskView({ symbol, setSymbol, onPerson }: { symbol: string | null; setSymbol: (s: string) => void; onPerson: (id: string) => void }) {
  const [q, setQ] = useState("");
  const [r, setR] = useState<Research | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!symbol) return;
    setR(null); setErr(null);
    fetch(`/api/research/${symbol}`).then((x) => x.json()).then((j) => (j.error ? setErr(j.error) : setR(j)));
  }, [symbol]);
  const go = (e?: React.FormEvent) => { e?.preventDefault(); const t = q.trim().toUpperCase().replace(/\.NS$/, ""); if (t) setSymbol(t); };
  return (
    <main className="px-4">
      <form onSubmit={go} className="sticky top-14 z-10 bg-bg pb-2 pt-1">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Any NSE symbol — e.g. DIXON" autoCapitalize="characters"
          className="w-full rounded-2xl border border-line bg-card px-4 py-3 text-[15px] outline-none focus:border-accent" />
      </form>
      {!symbol && (
        <div className="py-4">
          <p className="text-sm text-mute">Research is grounded only in primary sources: exchange filings, annual reports and earnings-call transcripts.</p>
          <div className="mt-3 flex flex-wrap gap-2">{PICKS.map((p) => <button key={p} onClick={() => setSymbol(p)} className="rounded-full border border-line px-3 py-1.5 text-sm">{p}</button>)}</div>
        </div>
      )}
      {symbol && !r && !err && <Skeleton lines={5} label={`Reading ${symbol}'s filings…`} />}
      {err && <p className="py-6 text-sm text-down">{err}</p>}
      {r && <ResearchView r={r} onPerson={onPerson} />}
    </main>
  );
}

function ResearchView({ r, onPerson }: { r: Research; onPerson: (id: string) => void }) {
  const ratio = (k: string) => r.ratios[k]?.replace(/\s+/g, " ");
  const t = r.trajectory;
  return (
    <div className="space-y-3 pb-6">
      <div className="pt-2">
        <h1 className="text-[22px] font-semibold leading-tight tracking-tight">{r.name}</h1>
        <p className="text-xs text-mute">{[r.industry, r.sector].filter(Boolean).join(" · ")} · {r.basis}</p>
        <div className="mt-3 grid grid-cols-4 gap-2 text-center">
          {[["Mkt cap", ratio("Market Cap")], ["P/E", ratio("Stock P/E")], ["ROCE", ratio("ROCE")], ["ROE", ratio("ROE")]].map(([k, v]) => (
            <div key={k} className="rounded-xl bg-card py-2"><div className="text-[10px] uppercase text-mute">{k}</div><div className="text-xs font-medium tabular-nums">{v ?? "—"}</div></div>
          ))}
        </div>
      </div>
      {r.network.length > 0 && (
        <Section title="Who can help you understand this">
          {r.network.map((l) => (
            <button key={l.id + (l.via ?? "")} onClick={() => onPerson(l.id)} className="flex w-full items-start gap-2 py-1.5 text-left">
              <Avatar name={l.name} />
              <div className="text-xs leading-snug"><span className="font-medium">{l.name}</span>{l.via ? <span className="text-mute"> via {l.via}</span> : null} <span className="text-mute">· {l.headline}</span><div className="text-mute">{l.why}</div></div>
            </button>
          ))}
        </Section>
      )}
      <Narrative symbol={r.symbol} fallback={r.signals} />
      <Section title="Last 8 quarters">
        <Bars labels={r.quarters.periods} values={r.quarters.revenue} sub={r.quarters.opm.map((x) => (x == null ? "" : `${x}%`))} />
        <p className="mt-1 text-[10px] text-mute">Revenue (bars), operating margin (below) · ₹ cr</p>
      </Section>
      <Section title={`Trajectory · revenue ${pc(t.salesCagr3)} / PAT ${pc(t.patCagr3)} 3-yr CAGR`}>
        <Bars labels={t.years} values={t.sales} sub={t.pat.map((x) => cr(x).replace(" cr", ""))} />
        <p className="mt-1 text-[10px] text-mute">Revenue (bars), PAT (below)</p>
      </Section>
      <Section title="Balance sheet">
        <Stats items={[["Debt/equity", r.balance.de == null ? "—" : `${r.balance.de.toFixed(2)}×`], ["Borrowings", cr(r.balance.borrowings.at(-1))], ["Cash cycle", r.balance.ccc == null ? "—" : `${r.balance.ccc}d (was ${r.balance.ccc0}d)`], ["ROCE", r.balance.roce == null ? "—" : `${r.balance.roce}%`]]} />
      </Section>
      <Section title={`Cash quality · ${r.cash.conversion == null ? "—" : r.cash.conversion.toFixed(0) + "%"} of profit became cash`}>
        <div className="space-y-1">
          {r.cash.rows.map((c) => (
            <div key={c.year} className="flex items-center gap-2 text-xs tabular-nums">
              <span className="w-16 text-mute">{c.year}</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg"><div className={`h-full rounded-full ${(c.conversion ?? 0) >= 80 ? "bg-up" : "bg-down"}`} style={{ width: `${Math.min(100, Math.max(4, c.conversion ?? 0) / 1.5)}%` }} /></div>
              <span className="w-12 text-right">{c.conversion == null ? "—" : `${c.conversion.toFixed(0)}%`}</span>
            </div>
          ))}
        </div>
        <p className="mt-1 text-[10px] text-mute">Cash from operations ÷ PAT, per year</p>
      </Section>
      {r.about && <Section title="Business"><p className="text-xs leading-relaxed text-mute">{r.about}</p></Section>}
      <Section title="Sources">
        <div className="flex flex-wrap gap-1.5 text-xs">
          {r.concalls.filter((c) => c.transcript).slice(0, 4).map((c) => <a key={c.month} href={c.transcript} target="_blank" rel="noreferrer" className="rounded-full border border-line px-2 py-1">Call {c.month} ↗</a>)}
          {r.annualReports.map((a) => <a key={a.url} href={a.url} target="_blank" rel="noreferrer" className="rounded-full border border-line px-2 py-1">{a.title} ↗</a>)}
          <a href={r.source} target="_blank" rel="noreferrer" className="rounded-full border border-line px-2 py-1">Financials ↗</a>
        </div>
      </Section>
    </div>
  );
}

type Narr = { calls: { call: string; url: string; found: number; sentences: string[] }[]; verdicts: { call: string; metric: string; promise: string; horizon: string; delivered: string; verdict: string; note: string; quote: string }[] | null; bullBear: { bull: string[]; bear: string[] } | null; model: { provider: string; fast: string; smart: string } | null; error?: string };
function Narrative({ symbol, fallback }: { symbol: string; fallback: { bull: string[]; bear: string[] } }) {
  const [n, setN] = useState<Narr | null>(null);
  useEffect(() => { setN(null); fetch(`/api/narrative/${symbol}`).then((x) => x.json()).then(setN).catch(() => setN({ calls: [], verdicts: null, bullBear: null, model: null, error: "failed" })); }, [symbol]);
  const bb = n?.bullBear ?? fallback;
  const V: Record<string, string> = { delivered: "text-up", missed: "text-down", partly: "text-accent", "too early": "text-mute" };
  return (
    <>
      <Section title="Promised vs delivered · last 4 calls">
        {!n && <Skeleton lines={3} label="Reading the last 4 earnings-call transcripts…" />}
        {n?.verdicts?.length ? (
          <div className="divide-y divide-line">
            {n.verdicts.map((v, i) => (
              <div key={i} className="py-2 text-xs">
                <div className="flex gap-2"><span className="text-mute">{v.call}</span><span className="flex-1 font-medium">{v.promise}</span><span className={`font-semibold uppercase ${V[v.verdict] ?? ""}`}>{v.verdict}</span></div>
                <div className="mt-0.5 text-mute">→ {v.delivered}{v.note ? ` · ${v.note}` : ""}</div>
              </div>
            ))}
          </div>
        ) : n ? (
          <div className="space-y-2 text-xs text-mute">
            {n.calls.flatMap((c) => c.sentences.slice(0, 2).map((s, i) => <p key={c.call + i}><b className="font-medium text-ink">{c.call}:</b> “{s.slice(0, 220)}”</p>))}
            {!n.calls.length && <p>No transcripts found for this company.</p>}
            {!n.model && <p className="text-[10px]">Add an LLM key to score these against reported numbers.</p>}
          </div>
        ) : null}
        {n?.model && <p className="mt-2 text-[10px] text-mute">Guidance extracted by {n.model.fast}; judged by {n.model.smart} against reported numbers only</p>}
      </Section>
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-2xl border border-line bg-card p-3"><div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-up">Bull</div>{bb.bull.map((x, i) => <p key={i} className="py-0.5 text-xs leading-snug">{x}</p>)}</div>
        <div className="rounded-2xl border border-line bg-card p-3"><div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-down">Bear</div>{bb.bear.map((x, i) => <p key={i} className="py-0.5 text-xs leading-snug">{x}</p>)}</div>
      </div>
    </>
  );
}

/* ----------------------------- NETWORK ----------------------------- */
type C = { id: string; name: string; headline: string; city: string; tie: string; howMet: string; lastSpoke: string; months: number; warmth: number; expertise: string[]; career: { org: string; role: string; from: number; to?: number }[]; education: { school: string; degree: string; from: number; to: number }[]; knows: string[] };
type Net = { contacts: C[]; themes: { theme: string; people: { id: string; name: string }[] }[] };
let netCache: Net | null = null;
function useNet() {
  const [n, setN] = useState<Net | null>(netCache);
  useEffect(() => { if (!netCache) fetch("/api/network").then((r) => r.json()).then((j) => { netCache = j; setN(j); }); }, []);
  return n;
}

function PeopleView({ onPerson, onCompany }: { onPerson: (id: string) => void; onCompany: (s: string) => void }) {
  const net = useNet();
  const [theme, setTheme] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [leads, setLeads] = useState<{ company: string; leads: { id: string; name: string; why: string; via?: string; headline: string }[] } | null>(null);
  const ask = (e: React.FormEvent) => { e.preventDefault(); if (q.trim()) fetch(`/api/network?company=${encodeURIComponent(q.trim())}`).then((r) => r.json()).then(setLeads); };
  const shown = useMemo(() => (theme ? net?.contacts.filter((c) => c.expertise.includes(theme)) : net?.contacts) ?? [], [net, theme]);
  if (!net) return <main className="px-4"><Skeleton lines={4} label="Loading your network…" /></main>;
  return (
    <main className="px-4">
      <form onSubmit={ask} className="pb-2 pt-1">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Who should I call about… (company)" className="w-full rounded-2xl border border-line bg-card px-4 py-3 text-[15px] outline-none focus:border-accent" />
      </form>
      {leads && (
        <Section title={`About ${leads.company}`}>
          {leads.leads.length ? leads.leads.map((l) => (
            <button key={l.id + (l.via ?? "")} onClick={() => onPerson(l.id)} className="flex w-full items-start gap-2 py-1.5 text-left"><Avatar name={l.name} /><div className="text-xs"><b className="font-medium">{l.name}</b>{l.via ? <span className="text-mute"> via {l.via}</span> : null}<div className="text-mute">{l.why}</div></div></button>
          )) : <p className="text-xs text-mute">No one yet — a gap worth filling.</p>}
        </Section>
      )}
      <h2 className="mb-2 mt-4 text-xs font-medium uppercase tracking-wider text-mute">Expertise map</h2>
      <div className="flex flex-wrap gap-1.5">
        {net.themes.filter((t) => t.people.length > 1).map((t) => (
          <button key={t.theme} onClick={() => setTheme(theme === t.theme ? null : t.theme)} className={`rounded-full px-2.5 py-1 text-xs ${theme === t.theme ? "bg-ink text-bg" : "border border-line"}`}>{t.theme} <span className="opacity-60">{t.people.length}</span></button>
        ))}
      </div>
      <h2 className="mb-2 mt-5 text-xs font-medium uppercase tracking-wider text-mute">{theme ? `Go-to people for ${theme}` : "Everyone, warmest first"}</h2>
      <div className="divide-y divide-line rounded-2xl border border-line bg-card">
        {shown.map((c) => (
          <button key={c.id} onClick={() => onPerson(c.id)} className="flex w-full items-center gap-3 p-3 text-left">
            <Avatar name={c.name} />
            <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{c.name}</div><div className="truncate text-xs text-mute">{c.headline}</div></div>
            <Warmth v={c.warmth} months={c.months} />
          </button>
        ))}
      </div>
      <p className="mt-3 text-[10px] text-mute">All people are synthetic. Employers are real, so the network overlaps the portfolio.</p>
      <button onClick={() => onCompany("DIXON")} className="hidden" />
    </main>
  );
}

function PersonSheet({ id, onClose, onCompany }: { id: string; onClose: () => void; onCompany: (s: string) => void }) {
  const net = useNet();
  const c = net?.contacts.find((x) => x.id === id);
  const SYM: Record<string, string> = { "Titan Company": "TITAN", "Dixon Technologies": "DIXON", "Kaynes Technology": "KAYNES", "Deepak Nitrite": "DEEPAKNTR", "CreditAccess Grameen": "CREDITACC", "Bajaj Finance": "BAJFINANCE", "HDFC Bank": "HDFCBANK", "Asian Paints": "ASIANPAINT", "Sun Pharmaceutical": "SUNPHARMA", "Tata Consultancy Services": "TCS", "Larsen & Toubro": "LT", "Indian Hotels": "INDHOTEL", "Central Depository Services": "CDSL", "Maruti Suzuki": "MARUTI", "Polycab India": "POLYCAB", "Trent": "TRENT", "Reliance Industries": "RELIANCE", "Hindustan Aeronautics": "HAL", "SRF": "SRF", "Aarti Industries": "AARTIIND" };
  return (
    <div className="fixed inset-0 z-40 flex items-end bg-black/40" onClick={onClose}>
      <div className="mx-auto max-h-[85dvh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-bg p-5 pb-10" onClick={(e) => e.stopPropagation()}>
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-line" />
        {!c ? <Skeleton lines={3} label="" /> : (
          <>
            <div className="flex items-center gap-3"><Avatar name={c.name} big /><div><div className="text-lg font-semibold">{c.name}</div><div className="text-xs text-mute">{c.headline} · {c.city}</div></div></div>
            <div className="mt-3 flex items-center gap-2 text-xs text-mute"><Warmth v={c.warmth} months={c.months} /> {c.tie} · {c.howMet}</div>
            <h3 className="mb-1 mt-4 text-[10px] font-medium uppercase tracking-wider text-mute">Career</h3>
            <ol className="border-l border-line pl-3">
              {[...c.career].reverse().map((s, i) => (
                <li key={i} className="py-1 text-sm">
                  {SYM[s.org] ? <button onClick={() => onCompany(SYM[s.org])} className="font-medium underline decoration-line underline-offset-2">{s.org}</button> : <span className="font-medium">{s.org}</span>}
                  <span className="text-mute"> · {s.role} · {s.from}–{s.to ?? "now"}</span>
                </li>
              ))}
            </ol>
            <h3 className="mb-1 mt-3 text-[10px] font-medium uppercase tracking-wider text-mute">Education</h3>
            {c.education.map((e, i) => <p key={i} className="text-sm">{e.school} <span className="text-mute">· {e.degree} · {e.from}–{e.to}</span></p>)}
            <h3 className="mb-1 mt-3 text-[10px] font-medium uppercase tracking-wider text-mute">Ask them about</h3>
            <div className="flex flex-wrap gap-1.5">{c.expertise.map((e) => <span key={e} className="rounded-full border border-line px-2 py-0.5 text-xs">{e}</span>)}</div>
            {c.knows.length > 0 && (<><h3 className="mb-1 mt-3 text-[10px] font-medium uppercase tracking-wider text-mute">Can introduce you to</h3><p className="text-sm">{c.knows.map((k) => net?.contacts.find((x) => x.id === k)?.name).filter(Boolean).join(", ")}</p></>)}
          </>
        )}
      </div>
    </div>
  );
}

/* ----------------------------- bits ----------------------------- */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="rounded-2xl border border-line bg-card p-4"><h2 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-mute">{title}</h2>{children}</section>;
}
function Stats({ items }: { items: [string, string][] }) {
  return <div className="grid grid-cols-2 gap-y-2">{items.map(([k, v]) => <div key={k}><div className="text-[10px] uppercase text-mute">{k}</div><div className="text-sm tabular-nums">{v}</div></div>)}</div>;
}
function Bars({ labels, values, sub }: { labels: string[]; values: (number | null)[]; sub?: string[] }) {
  const max = Math.max(...values.map((v) => v ?? 0), 1);
  return (
    <div className="flex items-end gap-1">
      {values.map((v, i) => (
        <div key={i} className="flex flex-1 flex-col items-center gap-1">
          <div className="text-[9px] tabular-nums text-mute">{v == null ? "" : v >= 1000 ? (v / 1000).toFixed(1) + "k" : v.toFixed(0)}</div>
          <div className="w-full rounded-t bg-accent/70" style={{ height: `${Math.max(2, ((v ?? 0) / max) * 64)}px` }} />
          <div className="text-[9px] text-mute">{labels[i]?.replace(/20(\d\d)/, "’$1")}</div>
          {sub && <div className="text-[9px] tabular-nums">{sub[i]}</div>}
        </div>
      ))}
    </div>
  );
}
function Avatar({ name, big }: { name: string; big?: boolean }) {
  const ini = name.split(" ").map((x) => x[0]).slice(0, 2).join("");
  const hue = [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  return <span className={`grid shrink-0 place-items-center rounded-full font-semibold text-white ${big ? "h-12 w-12 text-base" : "h-7 w-7 text-[10px]"}`} style={{ background: `oklch(0.6 0.09 ${hue})` }}>{ini}</span>;
}
function Warmth({ v, months }: { v: number; months: number }) {
  return <span className="flex items-center gap-1 text-[10px] text-mute" title={`warmth ${v}`}><span className="h-1.5 w-8 overflow-hidden rounded-full bg-bg"><span className="block h-full rounded-full bg-accent" style={{ width: `${v}%` }} /></span>{months}mo</span>;
}
function Skeleton({ lines, label }: { lines: number; label: string }) {
  return <div className="space-y-2 py-4">{label && <p className="text-xs text-mute">{label}</p>}{Array.from({ length: lines }).map((_, i) => <div key={i} className="h-16 animate-pulse rounded-2xl bg-card" />)}</div>;
}
