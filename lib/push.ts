// Closed-app push: standard Web Push (VAPID) to the investor's phone or laptop, even when FINN
// is not open. The browser hands us a push-service endpoint; the cron (app/api/cron) builds the
// brief with THAT subscriber's thresholds and pushes only what is new and material for them.
//
// What is stored, and where: one small JSON document — per subscriber the push endpoint, its two
// public encryption keys, their alert thresholds and the ids already sent (so nothing is pushed
// twice). No name, no email, nothing about their network. On Vercel it lives in a PRIVATE Blob
// store (BLOB_READ_WRITE_TOKEN); locally, in the OS temp dir. "Turn off" deletes the entry.
// A notification carries public filing facts only — the "who to call" hint is added on the
// device when the app opens, because the investor's network never reaches this server.
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { createHash } from "crypto";
import webpush from "web-push";
import type { Brief, Settings } from "./brief";

export type PushSettings = Pick<Settings, "volX" | "movePct" | "cares">;
export type Sub = {
  id: string; endpoint: string; keys: { p256dh: string; auth: string };
  settings: PushSettings; createdAt: string; sent: string[]; lastAt?: string;
};
export type Payload = { title: string; body: string; url?: string; tag?: string };

const FILE = "push/subscriptions.json";
const LOCAL = path.join(os.tmpdir(), "finn-cache", "push-subscriptions.json");
const MAX_SUBS = 200;
// The server POSTs to whatever endpoint a subscription names, so only real push services are accepted.
const PUSH_HOSTS = /(^|\.)(fcm\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com|push\.apple\.com)$/i;

export const vapidPublicKey = () => process.env.VAPID_PUBLIC_KEY ?? "";
export const pushConfigured = () => !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
export const pushDurable = () => !!process.env.BLOB_READ_WRITE_TOKEN;
const idOf = (endpoint: string) => createHash("sha256").update(endpoint).digest("hex").slice(0, 32);

export function validEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== "string" || endpoint.length > 1000) return false;
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && PUSH_HOSTS.test(u.hostname);
  } catch {
    return false;
  }
}

async function load(): Promise<Sub[]> {
  try {
    if (pushDurable()) {
      const { get } = await import("@vercel/blob");
      const r = await get(FILE, { access: "private", useCache: false });
      if (!r) return [];
      const j = JSON.parse(await new Response(r.stream).text());
      return Array.isArray(j) ? (j as Sub[]) : [];
    }
    const j = JSON.parse(await fs.readFile(LOCAL, "utf8"));
    return Array.isArray(j) ? (j as Sub[]) : [];
  } catch {
    return [];
  }
}

async function save(subs: Sub[]) {
  const body = JSON.stringify(subs.slice(-MAX_SUBS));
  if (pushDurable()) {
    const { put } = await import("@vercel/blob");
    await put(FILE, body, { access: "private", addRandomSuffix: false, allowOverwrite: true, contentType: "application/json" });
    return;
  }
  await fs.mkdir(path.dirname(LOCAL), { recursive: true });
  await fs.writeFile(LOCAL, body);
}

const cleanSettings = (s: Partial<PushSettings> | undefined): PushSettings => ({
  volX: Math.min(20, Math.max(1, Number(s?.volX) || 2)),
  movePct: Math.min(50, Math.max(0.1, Number(s?.movePct) || 4)),
  cares: Array.isArray(s?.cares) ? s!.cares.filter((c) => typeof c === "string").slice(0, 20) : ["results", "M&A", "management_change", "litigation"],
});

/** Add or update a subscription (same endpoint = same subscriber; their thresholds are replaced). */
export async function subscribe(input: { endpoint: string; keys?: { p256dh?: string; auth?: string } }, settings?: Partial<PushSettings>, seen: string[] = []): Promise<{ sub: Sub; isNew: boolean }> {
  if (!validEndpoint(input.endpoint) || !input.keys?.p256dh || !input.keys?.auth) throw new Error("not a web-push subscription");
  const subs = await load();
  const id = idOf(input.endpoint);
  const cur = subs.find((x) => x.id === id);
  const sub: Sub = {
    id, endpoint: input.endpoint, keys: { p256dh: String(input.keys.p256dh).slice(0, 200), auth: String(input.keys.auth).slice(0, 100) },
    settings: cleanSettings(settings), createdAt: cur?.createdAt ?? new Date().toISOString(),
    // What this device has already shown is not news: seed the sent list with it.
    sent: [...new Set([...(cur?.sent ?? []), ...seen.filter((x) => typeof x === "string").slice(-300)])].slice(-400), lastAt: cur?.lastAt,
  };
  await save([...subs.filter((x) => x.id !== id), sub]);
  return { sub, isNew: !cur };
}

export async function unsubscribe(endpoint: string) {
  const subs = await load();
  const id = idOf(String(endpoint));
  if (subs.some((x) => x.id === id)) await save(subs.filter((x) => x.id !== id));
}

export async function send(sub: Pick<Sub, "endpoint" | "keys">, payload: Payload): Promise<"sent" | "gone" | "failed"> {
  if (!pushConfigured()) return "failed";
  try {
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(payload), {
      vapidDetails: { subject: process.env.VAPID_SUBJECT ?? "https://finn-psi-one.vercel.app", publicKey: process.env.VAPID_PUBLIC_KEY!, privateKey: process.env.VAPID_PRIVATE_KEY! },
      TTL: 6 * 3600, urgency: "normal", timeout: 10_000,
    });
    return "sent";
  } catch (e) {
    const code = (e as { statusCode?: number }).statusCode;
    if (code === 404 || code === 410) return "gone"; // the browser dropped the subscription
    console.error("push failed", code, String((e as Error).message).slice(0, 120));
    return "failed";
  }
}

const MATERIAL = 45;
const alertKey = (a: Brief["alerts"][number]) => `alert:${a.symbol}:${a.kind}:${a.date}`;

/** What is new for one subscriber in a brief built with their own thresholds. */
export function digestFor(b: Brief, sent: Set<string>): { payload: Payload; ids: string[] } | null {
  const items = b.items.filter((i) => i.priority >= MATERIAL && !i.collapsedInto && !sent.has(i.id));
  const alerts = b.alerts.filter((a) => !sent.has(alertKey(a)));
  if (!items.length && !alerts.length) return null;
  const lines = [
    ...items.slice(0, 3).map((i) => {
      const pat = i.results?.lines?.find((l) => l.label === "PAT");
      return `${i.company} · ${i.label}${pat?.yoy != null ? ` · PAT ${pat.yoy >= 0 ? "+" : ""}${pat.yoy.toFixed(0)}% YoY` : ""}: ${i.summary.slice(0, 80)}`;
    }),
    ...alerts.slice(0, 2).map((a) => `${a.symbol}: ${a.text}`),
  ];
  const more = items.length + alerts.length - lines.length;
  const n = items.length + alerts.length;
  return {
    payload: {
      title: items.length ? `${n} new thing${n > 1 ? "s" : ""} worth your time` : `${alerts.length} unusual move${alerts.length > 1 ? "s" : ""} at the close`,
      body: lines.join("\n") + (more > 0 ? `\n+${more} more` : ""), url: "/#brief", tag: "finn-brief",
    },
    ids: [...items.map((i) => i.id), ...alerts.map(alertKey)],
  };
}

/** The cron's job: every subscriber gets what is new under THEIR thresholds, once. */
export async function pushAll(build: (s: PushSettings) => Promise<Brief>): Promise<{ subscribers: number; sent: number; gone: number; failed: number }> {
  const out = { subscribers: 0, sent: 0, gone: 0, failed: 0 };
  if (!pushConfigured()) return out;
  const subs = await load();
  out.subscribers = subs.length;
  if (!subs.length) return out;
  let changed = false;
  const keep: Sub[] = [];
  for (const sub of subs) {
    try {
      const d = digestFor(await build(sub.settings), new Set(sub.sent));
      if (!d) { keep.push(sub); continue; }
      const r = await send(sub, d.payload);
      if (r === "gone") { out.gone++; changed = true; continue; }
      if (r === "sent") {
        out.sent++; changed = true;
        keep.push({ ...sub, sent: [...sub.sent, ...d.ids].slice(-400), lastAt: new Date().toISOString() });
      } else { out.failed++; keep.push(sub); }
    } catch {
      out.failed++; keep.push(sub);
    }
  }
  if (changed) await save(keep);
  return out;
}
