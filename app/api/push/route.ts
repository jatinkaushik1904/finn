import { NextRequest } from "next/server";
import { pushConfigured, pushDurable, send, subscribe, unsubscribe, validEndpoint, vapidPublicKey } from "@/lib/push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Web Push subscriptions for closed-app alerts. No account, no identity: a subscription is a push
// endpoint plus the thresholds its owner chose. See lib/push.ts for what is stored and why.
export async function GET() {
  return Response.json({ enabled: pushConfigured(), publicKey: vapidPublicKey(), durable: pushDurable() }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  if (!pushConfigured()) return Response.json({ error: "push is not configured on this deployment" }, { status: 503 });
  const j = await req.json().catch(() => null) as { subscription?: { endpoint?: string; keys?: { p256dh?: string; auth?: string } }; settings?: Record<string, unknown>; seen?: string[]; test?: boolean } | null;
  const s = j?.subscription;
  if (!s || !validEndpoint(s.endpoint)) return Response.json({ error: "not a web-push subscription" }, { status: 400 });
  try {
    const { sub, isNew } = await subscribe({ endpoint: s.endpoint, keys: s.keys }, j?.settings, Array.isArray(j?.seen) ? j!.seen : []);
    let sent: string | undefined;
    // First subscribe (or an explicit test): prove the channel works, with the app in any state.
    if (isNew || j?.test) {
      sent = await send(sub, {
        title: j?.test && !isNew ? "FINN test alert" : "FINN alerts are on",
        body: `You'll hear about material filings (${sub.settings.cares.length} types tracked) and closes beyond ±${sub.settings.movePct}% or ${sub.settings.volX}× volume across your 18 holdings, even when FINN is closed.`,
        url: "/#brief", tag: "finn-hello",
      });
    }
    return Response.json({ ok: true, isNew, sent, durable: pushDurable() });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  const j = await req.json().catch(() => null) as { endpoint?: string } | null;
  if (!j?.endpoint || !validEndpoint(j.endpoint)) return Response.json({ error: "endpoint required" }, { status: 400 });
  await unsubscribe(j.endpoint);
  return Response.json({ ok: true });
}
