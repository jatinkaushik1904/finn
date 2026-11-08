// Small presentational primitives shared by the three tabs.
import type { ReactNode } from "react";
import { clock, inrShort, pct, tone } from "./format";

export function Section({ title, aside, children }: { title: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-card p-4">
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-mute">{title}</h2>
        {aside ? <div className="ml-auto shrink-0 whitespace-nowrap text-[11px] text-mute">{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function Label({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <h2 className={`text-[11px] font-semibold uppercase tracking-wider text-mute ${className}`}>{children}</h2>;
}

export function Stats({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
      {items.map(([k, v]) => (
        <div key={k}>
          <dt className="text-[10px] uppercase tracking-wide text-mute">{k}</dt>
          <dd className="text-sm font-medium tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Column chart in plain divs: values on top, period below, optional second series as text. */
export function Bars({ labels, values, sub }: { labels: string[]; values: (number | null)[]; sub?: string[] }) {
  const max = Math.max(...values.map((v) => v ?? 0), 1);
  return (
    <div className="flex items-end gap-1" role="img" aria-label={labels.map((l, i) => `${l}: ${values[i] ?? "n/a"}`).join(", ")}>
      {values.map((v, i) => (
        <div key={i} className="flex min-w-0 flex-1 flex-col items-center gap-1">
          <div className="text-[9px] tabular-nums text-mute">{inrShort(v)}</div>
          <div className={`w-full rounded-t ${i === values.length - 1 ? "bg-accent" : "bg-accent/55"}`} style={{ height: `${Math.max(2, (Math.max(0, v ?? 0) / max) * 64)}px` }} />
          <div className="whitespace-nowrap text-[9px] text-mute">{labels[i]?.replace(/^(\w{3}) 20(\d\d)$/, "$1 ’$2")}</div>
          {sub && <div className="text-[10px] font-medium tabular-nums">{sub[i] || "—"}</div>}
        </div>
      ))}
    </div>
  );
}

type Line = { label: string; value: number | null; qoq: number | null; yoy: number | null };
/** Revenue / EBITDA / PBT / PAT: this quarter vs QoQ and YoY. Numbers right-aligned in tabular figures. */
export function ResultsTable({ period, prevPeriod, yoyPeriod, lines, ebitdaNote, source }: { period: string; prevPeriod?: string; yoyPeriod?: string; lines: Line[]; ebitdaNote?: string; source?: string }) {
  return (
    <div className="rounded-xl bg-bg p-3">
      <div className="grid grid-cols-[minmax(0,1fr)_auto_3.5rem_3.5rem] items-baseline gap-x-3 gap-y-1 tabular-nums">
        <span className="text-[10px] font-medium uppercase tracking-wider text-mute">{period}</span>
        <span className="text-right text-[10px] uppercase tracking-wider text-mute">₹ cr</span>
        <span className="text-right text-[10px] uppercase tracking-wider text-mute">QoQ</span>
        <span className="text-right text-[10px] uppercase tracking-wider text-mute">YoY</span>
        {lines.map((l) => (
          <div key={l.label} className="contents text-sm">
            <span className="text-mute">{l.label}</span>
            <span className="text-right font-medium">{inrShort(l.value) || "—"}</span>
            <span className={`text-right ${tone(l.qoq)}`}>{pct(l.qoq)}</span>
            <span className={`text-right ${tone(l.yoy)}`}>{pct(l.yoy)}</span>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[10px] leading-snug text-mute">
        {prevPeriod && yoyPeriod ? `QoQ vs ${prevPeriod}, YoY vs ${yoyPeriod}` : null}
        {ebitdaNote ? ` · ${ebitdaNote}` : null}
        {source ? <> · <a href={source} target="_blank" rel="noreferrer" className="py-3.5 underline decoration-line underline-offset-2">source ↗</a></> : null}
      </p>
    </div>
  );
}

export function Avatar({ name, big }: { name: string; big?: boolean }) {
  const ini = name.split(/\s+/).map((x) => x[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
  const hue = [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  return (
    <span aria-hidden className={`grid shrink-0 place-items-center rounded-full font-semibold text-white ${big ? "h-12 w-12 text-base" : "h-8 w-8 text-[11px]"}`} style={{ background: `oklch(0.55 0.09 ${hue})` }}>
      {ini}
    </span>
  );
}

export function Warmth({ v, months }: { v: number; months: number }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-[11px] tabular-nums text-mute" title={`Warmth ${v}/100`}>
      <span className="h-1.5 w-8 overflow-hidden rounded-full bg-line">
        <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.max(6, Math.min(100, v))}%` }} />
      </span>
      <span className="w-9 text-right">{months < 1 ? "<1 mo" : `${months} mo`}</span>
    </span>
  );
}

export function Skeleton({ lines, label }: { lines: number; label?: string }) {
  return (
    <div className="space-y-2 py-4" aria-busy="true" aria-live="polite">
      {label ? <p className="text-xs text-mute">{label}</p> : null}
      {Array.from({ length: lines }).map((_, i) => <div key={i} className="h-16 animate-pulse rounded-2xl bg-card" />)}
    </div>
  );
}

/** Honest provenance: live exchange data vs a stored snapshot. */
export function SourceBadge({ live, at, what = "NSE" }: { live: boolean; at?: string; what?: string }) {
  return live ? (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><span className="h-1.5 w-1.5 rounded-full bg-up" /><span className="text-up">Live · {what}</span>{at ? <span className="tabular-nums">{clock(at)}</span> : null}</span>
  ) : (
    <span className="inline-flex items-center gap-1.5 text-warn" title={`${what} was unreachable, so this is the last stored copy`}><span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" />Snapshot{at ? <span className="tabular-nums">{clock(at)}</span> : null}<span>· {what} unreachable</span></span>
  );
}

export function Chevron({ open }: { open?: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className={`transition-transform ${open ? "rotate-180" : ""}`}>
      <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
