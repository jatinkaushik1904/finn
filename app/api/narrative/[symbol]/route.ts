import { narrative } from "@/lib/research";
import { snapshot } from "@/lib/snapshot";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(_: Request, { params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  try {
    return Response.json(await narrative(symbol));
  } catch (e) {
    const snap = await snapshot("narrative", symbol);
    if (snap) return Response.json(snap);
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
