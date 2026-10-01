import type pg from "pg";
import { kickPrewarmAfterWrite } from "./dashboardPrewarm.js";
import { deferColdReportCompute, dispatchAfterWrite } from "./prewarmRequests.js";

/** Called by invalidateReportTotalsCache after every write that cleared the report cache:
 *  start re-warming so the next viewer finds today warm. Vercel dispatches the GitHub
 *  workflow (awaited, so the frozen-after-response function still sends it); a
 *  long-running process kicks its own guarded pass. Both throttled to once per 10
 *  minutes. Never throws: the write already succeeded. Loaded lazily by
 *  reportTotalsCache.ts to avoid an import cycle (the pre-warm imports that module). */
export async function reWarmAfterWrite(db: pg.Pool): Promise<void> {
  try {
    if (deferColdReportCompute()) await dispatchAfterWrite(db);
    else kickPrewarmAfterWrite(db);
  } catch (err) {
    console.error("[report cache] Re-warm after write failed to start (the schedule will catch up):", err);
  }
}
