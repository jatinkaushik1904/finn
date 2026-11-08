import { research } from "@/lib/research";
import { snapshot } from "@/lib/snapshot";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(_: Request, { params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  try {
    return Response.json(await research(symbol));
  } catch (e) {
    const snap = await snapshot("research", symbol);
    if (snap) return Response.json(snap);
    return Response.json({ error: `Couldn't load ${symbol.toUpperCase()}: ${(e as Error).message}` }, { status: 404 });
  }
}
