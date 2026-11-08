import { NextRequest } from "next/server";
import { buildBrief, DEFAULT_SETTINGS, snapshotBrief, writeSnapshot } from "@/lib/brief";
import type { Category } from "@/lib/classify";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const cares = q.get("cares");
  const s = {
    hours: Number(q.get("hours")) || DEFAULT_SETTINGS.hours,
    volX: Number(q.get("volX")) || DEFAULT_SETTINGS.volX,
    movePct: Number(q.get("movePct")) || DEFAULT_SETTINGS.movePct,
    cares: cares == null ? DEFAULT_SETTINGS.cares : (cares.split(",").filter(Boolean) as Category[]),
  };
  try {
    // Dev only: `?snapshot=write` refreshes data/snapshot/brief-<hours>.json from a live build.
    if (q.get("snapshot") === "write" && process.env.NODE_ENV === "development") return Response.json(await writeSnapshot(s));
    const b = await buildBrief(s);
    return Response.json(b, { headers: { "Cache-Control": b.source === "live" ? "public, s-maxage=300, stale-while-revalidate=900" : "no-store" } });
  } catch (e) {
    // Last resort: never leave the user with an error page if a snapshot exists.
    try {
      return Response.json(await snapshotBrief(s, (e as Error).message), { headers: { "Cache-Control": "no-store" } });
    } catch {
      return Response.json({ error: (e as Error).message }, { status: 502 });
    }
  }
}
