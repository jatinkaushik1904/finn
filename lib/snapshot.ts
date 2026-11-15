import { promises as fs } from "fs";
import path from "path";

// Committed snapshots of live responses for the demo picks. Served only when the live source
// fails (e.g. screener.in / NSE blocking a cloud IP), and flagged so the UI can say so.
export async function snapshot<T>(kind: "research" | "narrative" | "people", symbol: string): Promise<(T & { snapshot: true }) | null> {
  const sym = symbol.toUpperCase().replace(/[^A-Z0-9&-]/g, "");
  try {
    const raw = await fs.readFile(path.join(process.cwd(), "data/snapshot", `${kind}-${sym}.json`), "utf8");
    return { ...(JSON.parse(raw) as T), snapshot: true };
  } catch {
    return null;
  }
}
