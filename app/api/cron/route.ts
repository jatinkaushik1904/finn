import { buildBrief, DEFAULT_SETTINGS } from "@/lib/brief";
import { cached, DAY } from "@/lib/cache";
import { pushAll } from "@/lib/push";

export const runtime = "nodejs";
export const maxDuration = 60;

// Real push. A scheduler calls this — Vercel Cron once a day after the close (vercel.json), and
// the repo's GitHub Actions "pulse" every 15 minutes in market hours. It builds the brief and:
//   1. Web Push: each subscribed device gets what is new under ITS OWN thresholds, once
//      (lib/push.ts) — this is the alert that arrives with FINN closed;
//   2. optionally, the same digest to a Telegram bot (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID) or
//      any Slack-style webhook (WEBHOOK_URL).
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) return new Response("unauthorized", { status: 401 });
  const b = await buildBrief({ ...DEFAULT_SETTINGS, hours: 24 });
  const material = b.items.filter((i) => i.priority >= 45);
  const lines = [
    `FINN · ${material.length} thing${material.length === 1 ? "" : "s"} worth your time`,
    ...material.slice(0, 8).map((i) => {
      const r = i.results?.lines?.find((l) => l.label === "PAT");
      const call = i.leads?.[0] ? ` — call ${i.leads[0].name.split(" ")[0]}` : "";
      return `• ${i.company} · ${i.label}: ${i.summary.slice(0, 110)}${r?.yoy != null ? ` (PAT ${r.yoy >= 0 ? "+" : ""}${r.yoy.toFixed(0)}% YoY)` : ""}${call}`;
    }),
    ...b.alerts.slice(0, 5).map((a) => `▲ ${a.symbol}: ${a.text}`),
  ];
  const text = lines.join("\n");
  // Same digest twice in a day is not news.
  let fresh = false;
  await cached(`cron:${new Date().toISOString().slice(0, 10)}:${text}`, DAY, async () => { fresh = true; return true; });
  const sent: string[] = [];
  if (fresh && (material.length || b.alerts.length)) {
    const tg = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
    if (tg && chat) {
      const r = await fetch(`https://api.telegram.org/bot${tg}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }), signal: AbortSignal.timeout(10_000),
      }).catch(() => null);
      sent.push(`telegram:${r?.status ?? "failed"}`);
    }
    if (process.env.WEBHOOK_URL) {
      const r = await fetch(process.env.WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(10_000) }).catch(() => null);
      sent.push(`webhook:${r?.status ?? "failed"}`);
    }
  }
  const push = await pushAll((s) => buildBrief({ ...s, hours: 24 })).catch((e) => ({ error: String((e as Error).message).slice(0, 120) }));
  return Response.json({ material: material.length, alerts: b.alerts.length, sent, push, preview: text });
}
