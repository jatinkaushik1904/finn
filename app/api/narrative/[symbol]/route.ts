import { narrative } from "@/lib/research";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(_: Request, { params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  try {
    return Response.json(await narrative(symbol));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
