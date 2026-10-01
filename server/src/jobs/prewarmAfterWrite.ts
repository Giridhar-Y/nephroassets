import type pg from "pg";
import { requireFySettings } from "../routes/reports.js";
import { kickPrewarmAfterWrite, prewarmDates } from "./dashboardPrewarm.js";
import { deferColdReportCompute, dispatchAfterWrite, markPrewarmRequested, type PrewarmRequest } from "./prewarmRequests.js";

/** Called by invalidateReportTotalsCache after every write that cleared the report cache:
 *  start re-warming so the next viewer finds today warm. Vercel dispatches the GitHub
 *  workflow (awaited, so the frozen-after-response function still sends it) and marks
 *  the dates that run warms first as requested, so a viewer arriving meanwhile doesn't
 *  dispatch a second run; a
 *  long-running process kicks its own guarded pass. Both throttled to once per 10
 *  minutes. Never throws: the write already succeeded. Loaded lazily by
 *  reportTotalsCache.ts to avoid an import cycle (the pre-warm imports that module). */
export async function reWarmAfterWrite(db: pg.Pool): Promise<void> {
  try {
    if (deferColdReportCompute()) {
      if (await dispatchAfterWrite(db)) await markPrewarmRequested(db, await firstWarmedDates(db));
    } else kickPrewarmAfterWrite(db);
  } catch (err) {
    console.error("[report cache] Re-warm after write failed to start (the schedule will catch up):", err);
  }
}

/** The dates a dispatched run warms first (prewarmDates: today, the stored AS_AT,
 *  yesterday), keyed exactly as the routes key a cold request (requireFySettings for that
 *  date), so a viewer's cold load of one of them finds the run already on its way. */
async function firstWarmedDates(db: pg.Pool): Promise<PrewarmRequest[]> {
  const base = await requireFySettings(db);
  if (!base) return [];
  const reqs: PrewarmRequest[] = [];
  for (const asAt of prewarmDates(new Date(), base)) {
    const fy = await requireFySettings(db, { asAt });
    if (fy) reqs.push({ asAt: fy.asAt, fyStart: fy.fyStart, fyEnd: fy.fyEnd });
  }
  return reqs;
}
