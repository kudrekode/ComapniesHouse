import { NextResponse } from "next/server";
import { runPipeline } from "../../../lib/runPipeline";
import type { PipelineResult, PipelineRow } from "../../../lib/runPipeline";

export const dynamic = "force-dynamic";

const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // run pipeline every 5 minutes
const COMPANY_TTL_MS = 30 * 60 * 1000; // remove company from dashboard 30 min after it was added

/** Per-company entry: we only add new companies, and remove after 30 min. */
type StoreEntry = { row: PipelineRow; addedAt: number };

let companyStore = new Map<string, StoreEntry>();
let lastPipelineRunAt: number = 0;
let pipelineInFlight: Promise<PipelineResult> | null = null;

function referenceTimestamp(entry: StoreEntry): number {
  const raw = (entry.row.incorporation_date || "").trim();
  if (raw.length > 10 && raw[10] === "T") {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return entry.addedAt;
}

function pruneExpired(now: number): void {
  const cutoff = now - COMPANY_TTL_MS;
  for (const [companyNumber, entry] of companyStore.entries()) {
    if (referenceTimestamp(entry) < cutoff) companyStore.delete(companyNumber);
  }
}

function storeToResult(updatedAt: string): PipelineResult {
  const rows = Array.from(companyStore.values())
    .map((e) => e.row)
    .sort((a, b) => a.incorporation_date.localeCompare(b.incorporation_date));
  return { updatedAt, rows };
}

export async function GET() {
  const now = Date.now();

  try {
    pruneExpired(now);

    const shouldRunPipeline =
      now - lastPipelineRunAt >= REFRESH_INTERVAL_MS || companyStore.size === 0;

    if (shouldRunPipeline) {
      if (!pipelineInFlight) {
        console.log("[API] Running pipeline (5-min refresh or first run)...");
        pipelineInFlight = runPipeline().finally(() => {
          pipelineInFlight = null;
        });
      } else {
        console.log("[API] Pipeline already running; awaiting current run...");
      }
      const result = await pipelineInFlight;
      const completedAt = Date.now();
      lastPipelineRunAt = completedAt;
      for (const row of result.rows) {
        const existing = companyStore.get(row.company_number);
        if (existing) {
          companyStore.set(row.company_number, { row, addedAt: existing.addedAt });
        } else {
          companyStore.set(row.company_number, { row, addedAt: completedAt });
        }
      }
      pruneExpired(completedAt);
      console.log(`[API] Store now has ${companyStore.size} companies (after merge + 30min prune)`);
    } else {
      console.log(`[API] Returning cached store (${companyStore.size} companies); next pipeline in ${Math.round((REFRESH_INTERVAL_MS - (now - lastPipelineRunAt)) / 1000)}s`);
    }

    const updatedAt = new Date(lastPipelineRunAt).toISOString();
    return NextResponse.json(storeToResult(updatedAt), { status: 200 });
  } catch (error) {
    console.error("Pipeline failed:", error);
    return NextResponse.json(
      { error: "Failed to run pipeline" },
      { status: 500 }
    );
  }
}
