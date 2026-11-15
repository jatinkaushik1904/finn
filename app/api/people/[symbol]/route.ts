import { people } from "@/lib/people";
import { NotFound } from "@/lib/research";
import { snapshot } from "@/lib/snapshot";

export const runtime = "nodejs";
export const maxDuration = 60;

// "Before you meet management": profiles from the company's own filings and call transcripts.
// Public data only; overlaps with the investor's network are matched in the browser.
export async function GET(_: Request, { params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  try {
    return Response.json(await people(symbol));
  } catch (e) {
    const snap = await snapshot("people", symbol);
    if (snap) return Response.json(snap);
    const notFound = e instanceof NotFound || /\b404\b|not an NSE symbol/i.test((e as Error).message);
    return Response.json({ error: (e as Error).message }, { status: notFound ? 404 : 502 });
  }
}
