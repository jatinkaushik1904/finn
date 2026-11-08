// Number formatting for an Indian investor: ₹ crore, Indian digit grouping
// (1,23,456), lakh-crore compaction only where space is tight.

const grp = (v: number, d = 0) => v.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });

/** ₹20,614 cr · −₹541 cr · ₹4.44L cr (≥ 1 lakh crore) */
export function inr(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  const s = a >= 1e5 ? `${(a / 1e5).toFixed(2)}L` : grp(a, a < 10 ? 1 : 0);
  return `${v < 0 ? "−" : ""}₹${s} cr`;
}

/** Compact label for chart columns (unit stated in the caption): 20,614 · 2.4L */
export function inrShort(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return "";
  const a = Math.abs(v);
  const s = a >= 1e5 ? `${(a / 1e5).toFixed(1)}L` : grp(a, a < 10 ? 1 : 0);
  return `${v < 0 ? "−" : ""}${s}`;
}

/** +12% · −3.4% · — */
export function pct(v: number | null | undefined, d = 0) {
  if (v == null || !Number.isFinite(v)) return "—";
  const r = Number(v.toFixed(d));
  return `${r > 0 ? "+" : r < 0 ? "−" : ""}${Math.abs(r).toFixed(d)}%`;
}

export const tone = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "text-mute" : v >= 0 ? "text-up" : "text-down");

export function ago(iso: string) {
  const m = (Date.now() - new Date(iso).getTime()) / 60000;
  if (!Number.isFinite(m)) return "";
  return m < 1 ? "now" : m < 60 ? `${Math.round(m)}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}

export const months = (m: number) => (m < 1 ? "<1 mo" : `${m} mo`);

export function clock(iso?: string) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date().toDateString() === d.toDateString();
  return d.toLocaleString("en-IN", today ? { hour: "2-digit", minute: "2-digit", hour12: false } : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
}

/** Screener ratio strings ("₹ 4,43,582 Cr.", "20.5 %") → compact, consistent. */
export function ratio(raw: string | undefined | null) {
  if (!raw) return "—";
  const s = raw.replace(/\s+/g, " ").trim();
  const cr = s.match(/^₹\s?([\d,.]+)\s?Cr\.?$/i);
  if (cr) return inr(Number(cr[1].replace(/,/g, "")));
  return s.replace(/\s%$/, "%").replace(/^₹\s/, "₹");
}
