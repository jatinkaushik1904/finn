import { NextRequest } from "next/server";
import { buildBrief, DEFAULT_SETTINGS } from "@/lib/brief";
import type { Category } from "@/lib/classify";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const s = {
    hours: Number(q.get("hours")) || DEFAULT_SETTINGS.hours,
    volX: Number(q.get("volX")) || DEFAULT_SETTINGS.volX,
    movePct: Number(q.get("movePct")) || DEFAULT_SETTINGS.movePct,
    cares: (q.get("cares")?.split(",").filter(Boolean) as Category[]) ?? DEFAULT_SETTINGS.cares,
  };
  try {
    return Response.json(await buildBrief(s));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
