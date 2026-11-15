import { createHash } from "crypto";
import { deflateSync } from "zlib";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { cached, DAY, hash } from "./cache";
import { fetchPdf } from "./nse";

// Page-aware PDF reading for results filings. Two things the plain text dump can't do:
//  1. keep page boundaries and table rows — a results statement is a grid, and a reader that
//     emits items in content-stream order splits a row's columns across lines (the year-ago
//     column of Reliance's table came out as a separate block below the table);
//  2. keep the bytes, so a scanned filing (no text layer) can be handed to a model as a PDF.
// Bytes are cached on local disk (size-capped, oldest evicted); page text is cached as JSON.

const DIR = path.join(os.tmpdir(), "finn-cache");
const DISK_CAP = 400 * 1024 * 1024; // total bytes kept on disk across PDFs (Vercel /tmp is 512 MB)
const MAX_PAGES = 60;

// At most two downloads from the exchange at a time (the brief fetches filings ≤4-wide too).
let active = 0;
const queue: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= 2) await new Promise<void>((r) => queue.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    queue.shift()?.();
  }
}

const inflight = new Map<string, Promise<Uint8Array>>();

async function evict() {
  try {
    const files = (await fs.readdir(DIR)).filter((f) => f.startsWith("pdfbytes-"));
    const stats = await Promise.all(files.map(async (f) => ({ f, s: await fs.stat(path.join(DIR, f)).catch(() => null) })));
    const live = stats.filter((x) => x.s).sort((a, b) => a.s!.mtimeMs - b.s!.mtimeMs);
    let total = live.reduce((a, x) => a + x.s!.size, 0);
    for (const x of live) {
      if (total <= DISK_CAP) break;
      await fs.unlink(path.join(DIR, x.f)).catch(() => {});
      total -= x.s!.size;
    }
  } catch {}
}

const fileFor = (url: string) => path.join(DIR, `pdfbytes-${hash(url)}.pdf`);

/** The raw bytes of a filing, from local disk when we have them (whole files only: see fetchPdf). */
export async function pdfBytes(url: string, timeoutMs = 30_000): Promise<Uint8Array> {
  const file = fileFor(url);
  try {
    return new Uint8Array(await fs.readFile(file));
  } catch {}
  const running = inflight.get(url);
  if (running) return running;
  const p = slot(async () => {
    const buf = await fetchPdf(url, timeoutMs);
    try {
      await fs.mkdir(DIR, { recursive: true });
      await fs.writeFile(file, buf);
      void evict();
    } catch {}
    return buf;
  }).finally(() => inflight.delete(url));
  inflight.set(url, p);
  return p;
}

/** Forget the stored bytes of a filing (they turned out not to be a readable PDF). */
export const dropPdfBytes = (url: string) => fs.unlink(fileFor(url)).catch(() => {});

export const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export type PdfDoc = {
  url: string;
  numPages: number;
  pages: string[]; // layout text per page (index 0 = page 1), rows kept on one line
  sha: string; // of the bytes: keys model calls that read the PDF itself
  size: number;
  textChars: number;
};

type Item = { str: string; transform: number[]; width: number; height: number; fontName?: string };
type Pt = { s: string; x: number; y: number; w: number; h: number; f: string };

// Signed or re-scanned filings often carry two text layers over each other (the original and an
// OCR copy, in different fonts and split into different runs): read naively, "Revenue from
// operations 21,793.64" comes out as "RevenueRevenue from operatoperationsions 21,793.6421,793.64".
// Find the fonts whose characters mostly sit on top of characters already placed by other fonts —
// that is the second layer — and drop it, keeping only its runs that say something new.
function dedupeLayers(pts: Pt[]): Pt[] {
  const seen = new Map<string, { x: number; y: number; i: number }[]>();
  const key = (ch: string, x: number, y: number) => `${ch}|${Math.round(x / 3)}|${Math.round(y / 3)}`;
  const dupOf = pts.map(() => 0);
  pts.forEach((p, i) => {
    const n = p.s.length, cw = n ? p.w / n : 0;
    const tol = Math.max(1, 0.6 * (cw || p.h * 0.5));
    for (let k = 0; k < n; k++) {
      const ch = p.s[k];
      if (ch === " ") continue;
      const x = p.x + cw * k, y = p.y;
      let dup = false;
      for (let dx = -1; dx <= 1 && !dup; dx++)
        for (let dy = -1; dy <= 1 && !dup; dy++)
          dup = (seen.get(`${ch}|${Math.round(x / 3) + dx}|${Math.round(y / 3) + dy}`) ?? []).some(
            (q) => q.i !== i && Math.abs(q.x - x) <= tol && Math.abs(q.y - y) <= 0.6 * p.h,
          );
      if (dup) dupOf[i]++;
      else {
        const list = seen.get(key(ch, x, y)) ?? [];
        list.push({ x, y, i });
        seen.set(key(ch, x, y), list);
      }
    }
  });
  const chars = pts.reduce((a, p) => a + p.s.replace(/ /g, "").length, 0);
  const dups = dupOf.reduce((a, b) => a + b, 0);
  if (!chars || dups / chars < 0.05) return pts;
  const byFont = new Map<string, { n: number; d: number }>();
  pts.forEach((p, i) => {
    const f = byFont.get(p.f) ?? { n: 0, d: 0 };
    f.n += p.s.replace(/ /g, "").length;
    f.d += dupOf[i];
    byFont.set(p.f, f);
  });
  const second = new Set([...byFont].filter(([, f]) => f.d / Math.max(1, f.n) > 0.4).map(([k]) => k));
  if (!second.size) return pts;
  const first = pts.filter((p) => !second.has(p.f));
  const norm = (s: string) => s.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  const near = (p: Pt) =>
    first.some((q) => Math.abs(q.y - p.y) <= 3 * p.h && Math.abs(q.x - p.x) <= 4 * p.h && (norm(q.s).includes(norm(p.s)) || norm(p.s).includes(norm(q.s))));
  return [...first, ...pts.filter((p, i) => second.has(p.f) && dupOf[i] === 0 && norm(p.s) && !near(p))];
}

// Rebuild a page's rows from positioned text items (what `pdftotext -layout` does, compactly):
// cluster by baseline, order by x, keep column gaps as runs of spaces. Rotated pages are
// handled by measuring positions along the dominant text direction.
function layout(items: Item[]): string {
  const its = items.filter((it) => it.str && it.str.trim() && it.transform);
  if (!its.length) return "";
  const angles = new Map<number, number>();
  for (const it of its) {
    const a = Math.round((Math.atan2(it.transform[1], it.transform[0]) * 180) / Math.PI / 90) * 90;
    angles.set(a, (angles.get(a) ?? 0) + it.str.length);
  }
  const deg = [...angles.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const th = (deg * Math.PI) / 180, cos = Math.cos(th), sin = Math.sin(th);
  const raw = its.map((it) => {
    const [, , c, d, e, f] = it.transform;
    const h = Math.max(1, Math.hypot(c, d) || it.height || 8);
    return { s: it.str.replace(/\s+/g, " "), x: e * cos + f * sin, y: -e * sin + f * cos, w: Math.abs(it.width), h, f: it.fontName ?? "" };
  });
  const pts = dedupeLayers(raw);
  if (!pts.length) return "";
  pts.sort((a, b) => b.y - a.y || a.x - b.x);
  // Rows: join an item to the current row when its baseline is within ~2/3 of a text height of
  // the row's mean baseline (OCR'd layers give every word its own slightly different baseline).
  const rows: Pt[][] = [];
  let mean = 0;
  for (const p of pts) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(mean - p.y) <= Math.max(1.5, 0.65 * Math.min(row[0].h, p.h))) {
      row.push(p);
      mean += (p.y - mean) / row.length;
    } else {
      rows.push([p]);
      mean = p.y;
    }
  }
  const minX = Math.min(...pts.map((p) => p.x));
  const maxX = Math.max(...pts.map((p) => p.x + p.w));
  const charW = Math.max(2, (maxX - minX) / 150); // the widest row maps to ~150 characters
  return rows
    .map((row) => {
      row.sort((a, b) => a.x - b.x);
      let line = "";
      let end = -Infinity;
      for (const p of row) {
        const gap = p.x - end;
        const col = Math.round((p.x - minX) / charW);
        if (line) {
          if (gap > 1.2 * p.h) line += " ".repeat(Math.max(2, col - line.length));
          else if (gap > 0.12 * p.h && !line.endsWith(" ") && !p.s.startsWith(" ")) line += " ";
        } else line = " ".repeat(col);
        line += p.s;
        end = p.x + p.w;
      }
      return line.replace(/\s+$/, "");
    })
    .join("\n");
}

/** Layout text of each page of a PDF held in memory (first 60 pages). */
export async function parsePages(buf: Uint8Array): Promise<{ numPages: number; pages: string[] }> {
  const { getDocumentProxy } = await import("unpdf");
  const doc = await getDocumentProxy(new Uint8Array(buf)); // pdf.js may take ownership of the array: hand it a copy
  const pages: string[] = [];
  try {
    for (let i = 1; i <= Math.min(doc.numPages, MAX_PAGES); i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      pages.push(layout(content.items as Item[]));
    }
    return { numPages: doc.numPages, pages };
  } finally {
    doc.destroy().catch(() => {});
  }
}

/** Page-by-page layout text of a filing, cached for 30 days. */
export async function pdfPages(url: string): Promise<PdfDoc> {
  return cached(`pdfpages:v1:${url}`, 30 * DAY, async () => {
    let buf = await pdfBytes(url);
    let parsed: { numPages: number; pages: string[] };
    try {
      parsed = await parsePages(buf);
    } catch {
      // Stored bytes that don't parse (a download cut short by an older build): fetch them again, once.
      await dropPdfBytes(url);
      buf = await pdfBytes(url);
      parsed = await parsePages(buf);
    }
    const { numPages, pages } = parsed;
    return { url, numPages, pages, sha: sha256(buf), size: buf.length, textChars: pages.reduce((a, p) => a + p.replace(/\s/g, "").length, 0) };
  }, undefined, { immutable: true });
}

/** Little or no text layer: the filing is a scan and has to be read as an image. */
export const isScanned = (d: PdfDoc) => d.textChars < 250 * Math.min(d.numPages, MAX_PAGES);

export type Basis = "consolidated" | "standalone";
export type TablePick = { pages: number[]; basis: Basis | null; score: number; text: string };

const NUM = /\(?-?\d{1,3}(?:[,.]\d{2,3})+(?:\.\d+)?\)?|\b\d+\.\d{1,2}\b|\b\d{4,}\b/g;

/**
 * The page(s) holding the quarter-column results table, best first. Pages are scored on the
 * statement's own lines (revenue from operations / interest earned, profit before tax, profit for
 * the period, "quarter ended"), on how many figures they carry, and against look-alikes (segment
 * tables, balance sheet, cash flow, the auditor's review report). The title near the top says
 * which basis the table is; a continuation page inherits it.
 */
export function findResultsTable(d: PdfDoc, lender?: "bank" | "nbfc"): TablePick[] {
  const rev = lender === "bank" ? /interest\s*earned/ : /revenue\s*(from\s*)?operations?|income\s*from\s*operations|total\s*revenue/;
  const feats = d.pages.map((p) => {
    const t = p.toLowerCase().replace(/\s+/g, " ");
    const head = p.split("\n").slice(0, 18).join(" ").toLowerCase().replace(/\s+/g, " ");
    const c = head.search(/consolidated/), s = head.search(/standalone/);
    const basis: Basis | null = c < 0 && s < 0 ? null : c >= 0 && (s < 0 || c < s) ? "consolidated" : "standalone";
    const nums = (p.match(NUM) ?? []).length;
    const hasRev = rev.test(t), hasPBT = /profit.{0,40}before\s*(tax|exceptional)/.test(t);
    const hasPAT = /profit.{0,40}(for\s*the\s*(period|quarter)|after\s*tax)|net\s*profit/.test(t);
    const hasQtr = /quarter\s*ended|three\s*months\s*ended|3\s*months\s*ended|quarter\s*end/.test(t);
    const seg = (t.match(/segment/g) ?? []).length >= 3 || /segment/.test(head);
    const other = /assets\s*and\s*liabilities|balance\s*sheet|cash\s*flows?/.test(head) && !/financial\s*results/.test(head);
    const review = /review\s*report|we\s*have\s*reviewed|independent\s*auditor/.test(t) && nums < 40;
    const score = (hasRev ? 3 : 0) + (hasPBT ? 2 : 0) + (hasPAT ? 1 : 0) + (hasQtr ? 1 : 0) + Math.min(nums, 120) / 40 - (seg ? 3 : 0) - (other ? 3 : 0) - (review ? 4 : 0);
    return { basis, nums, hasRev, hasPBT, hasPAT, score };
  });
  const picks: TablePick[] = [];
  feats.forEach((f, i) => {
    if (!f.hasRev || f.nums < 25 || f.score < 4) return;
    const pages = [i];
    const next = feats[i + 1];
    if ((!f.hasPBT || !f.hasPAT) && next && next.nums >= 15 && (next.hasPBT || next.hasPAT)) pages.push(i + 1);
    let basis = f.basis;
    for (let j = i - 1; basis == null && j >= Math.max(0, i - 2); j--) basis = feats[j].basis;
    picks.push({ pages, basis, score: f.score + (pages.length > 1 ? 1 : 0), text: pages.map((j) => `--- page ${j + 1} ---\n${d.pages[j]}`).join("\n") });
  });
  return picks.sort((a, b) => b.score - a.score);
}

/** Every number printed on the given text, as values (thousands separators and OCR dots handled). */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\(?-?\d[\d,. ]*\d\)?|\b\d\b/g)) {
    // A run like "1,234.56  7,890.12" is two numbers; split on double spaces first.
    for (const tok of m[0].split(/\s{2,}/)) {
      const t = tok.replace(/[()\s]/g, "");
      if (!t) continue;
      const parts = t.split(/[.,]/);
      const last = parts[parts.length - 1];
      const head = parts.slice(0, -1).join("");
      const seps = t.replace(/[^.,]/g, "");
      const cands: string[] = [];
      if (parts.length === 1) cands.push(t);
      // "9,898.901" / "1.234,56": mixed separators — the last one is the decimal point.
      else if (seps.includes(",") && seps.includes(".")) cands.push(`${head}.${last}`);
      // "17.369.35" (OCR'd thousands dot), "15285,48" (OCR'd decimal comma): a final group of
      // 1–2 digits is decimals; 3 digits is ambiguous for a single "." ("9898.901"), so keep both.
      else if (last.length <= 2) cands.push(`${head}.${last}`);
      else if (seps === ".") cands.push(`${head}.${last}`, parts.join(""));
      else cands.push(parts.join(""));
      for (const c of cands) {
        const n = Number(c);
        if (Number.isFinite(n)) out.push(Math.abs(n));
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ page images

// A minimal PNG encoder (zlib is built in): 1-bit or 8-bit greyscale is all a scanned table needs.
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(b: Uint8Array) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  Buffer.from(data.buffer, data.byteOffset, data.byteLength).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function png(w: number, h: number, bitDepth: 1 | 8, rowBytes: number, row: (y: number, dst: Buffer, off: number) => void): Uint8Array {
  const raw = Buffer.alloc((rowBytes + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (rowBytes + 1)] = 0; row(y, raw, y * (rowBytes + 1) + 1); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = bitDepth; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 6 })), chunk("IEND", new Uint8Array())]));
}

/**
 * The scanned image of a page, as a greyscale PNG — for filings whose text layer is an OCR guess.
 * A model handed the PDF reads that (wrong) text layer back; handed the picture, it reads the print.
 * Every image and stencil mask on the page is painted through its transform onto a page-sized
 * canvas (~200 dpi): a plain scan is one image; a "mixed raster" scan is a faint background JPEG
 * with the text in a 1-bit mask on top. Null when images cover less than half the page (not a scan).
 */
export async function pageImage(buf: Uint8Array, pageNo: number, dpi = 200): Promise<Uint8Array | null> {
  const { getDocumentProxy, getResolvedPDFJS } = await import("unpdf");
  const { OPS } = (await getResolvedPDFJS()) as unknown as { OPS: Record<string, number> };
  const doc = await getDocumentProxy(new Uint8Array(buf));
  try {
    const page = await doc.getPage(pageNo);
    const [vx0, vy0, vx1, vy1] = page.view as number[];
    const sc = dpi / 72;
    const W = Math.round((vx1 - vx0) * sc), H = Math.round((vy1 - vy0) * sc);
    if (W * H > 40_000_000) return null;
    const canvas = new Uint8Array(W * H).fill(255);
    const ops = await page.getOperatorList();
    type M = number[];
    const mul = (m: M, n: M): M => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
    const get = (store: unknown, id: string) =>
      new Promise<Record<string, unknown> | null>((resolve) => {
        const t = setTimeout(() => resolve(null), 5000);
        try {
          const v = (store as { get: (n: string, cb: (v: Record<string, unknown>) => void) => Record<string, unknown> | undefined }).get(id, (v) => { clearTimeout(t); resolve(v); });
          if (v) { clearTimeout(t); resolve(v); }
        } catch { clearTimeout(t); resolve(null); }
      });
    let ctm: M = [1, 0, 0, 1, 0, 0];
    const stack: M[] = [];
    let covered = 0;
    // Sample a w×h source onto the canvas through ctm (unit square → page), nearest neighbour.
    const paint = (w: number, h: number, m: M, px: (sx: number, sy: number) => number | null) => {
      const det = m[0] * m[3] - m[1] * m[2];
      if (!det || w < 2 || h < 2) return;
      const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]]);
      const xs = corners.map((c) => (c[0] - vx0) * sc), ys = corners.map((c) => H - (c[1] - vy0) * sc);
      const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(W, Math.ceil(Math.max(...xs)));
      const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(H, Math.ceil(Math.max(...ys)));
      if (x1 <= x0 || y1 <= y0) return;
      covered += (x1 - x0) * (y1 - y0);
      const inv = [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det];
      for (let cy = y0; cy < y1; cy++) {
        const py = vy0 + (H - cy - 0.5) / sc;
        for (let cx = x0; cx < x1; cx++) {
          const pxx = vx0 + (cx + 0.5) / sc;
          const dx = pxx - m[4], dy = py - m[5];
          const u = inv[0] * dx + inv[2] * dy, v = inv[1] * dx + inv[3] * dy;
          if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
          const val = px(Math.floor(u * w), Math.floor((1 - v) * h)); // image row 0 is the top
          if (val != null) canvas[cy * W + cx] = val;
        }
      }
    };
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i], a = ops.argsArray[i] as unknown[];
      if (fn === OPS.save) stack.push(ctm);
      else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
      else if (fn === OPS.transform) ctm = mul(ctm, a as M);
      else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm); if (Array.isArray(a[0])) ctm = mul(ctm, a[0] as M); }
      else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
      else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
        const img = fn === OPS.paintImageXObject ? await get(String(a[0]).startsWith("g_") ? page.commonObjs : page.objs, String(a[0])) : (a[0] as Record<string, unknown>);
        const data = img?.data as Uint8Array | undefined, w = Number(img?.width), h = Number(img?.height), kind = Number(img?.kind);
        if (!data || !w || !h) continue;
        if (kind === 1) { const rb = Math.ceil(w / 8); paint(w, h, ctm, (x, y) => ((data[y * rb + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0)); }
        else if (kind === 2 || kind === 3) { const ch = kind === 2 ? 3 : 4; paint(w, h, ctm, (x, y) => { const k = (y * w + x) * ch; return Math.round(0.299 * data[k] + 0.587 * data[k + 1] + 0.114 * data[k + 2]); }); }
      } else if (fn === OPS.paintImageMaskXObject) {
        const ref = a[0] as { data?: unknown; width?: number; height?: number };
        const img = typeof ref?.data === "string" ? await get(page.objs, ref.data) : (ref as Record<string, unknown>);
        const data = img?.data as Uint8Array | undefined, w = Number(img?.width), h = Number(img?.height);
        if (!data || !w || !h) continue;
        const rb = Math.ceil(w / 8);
        // A stencil's ink is whichever bit value is the minority (text is a small share of a page).
        let ones = 0;
        for (let k = 0; k < Math.min(data.length, rb * h); k++) { let b = data[k]; while (b) { ones += b & 1; b >>= 1; } }
        const ink = ones < (w * h) / 2 ? 1 : 0;
        paint(w, h, ctm, (x, y) => (((data[y * rb + (x >> 3)] >> (7 - (x & 7))) & 1) === ink ? 0 : null));
      }
    }
    if (covered < 0.5 * W * H) return null;
    return png(W, H, 8, W, (y, dst, off) => Buffer.from(canvas.buffer, y * W, W).copy(dst, off));
  } finally {
    doc.destroy().catch(() => {});
  }
}
