import type pg from "pg";

// Concurrent exports each run a real, CPU-heavy far_calc_component() pass over the WHOLE
// filtered register (the totals query — see assetsExport.ts's own comment on it) — a
// single unfiltered export already takes ~18s end-to-end on real hardware (see
// EXPORT_ROW_LIMIT's own comment in assetsExport.ts). Several running at once (e.g.
// multiple finance users during month-end close) can genuinely saturate Postgres CPU,
// starving ordinary clinic API calls that share the same database.
//
// A plain in-memory counter would NOT work as a guard here: this app's production
// deployment is Vercel serverless, which can (and does, under concurrent load) spin up
// several separate instances of this function to handle simultaneous requests, each with
// its own isolated process memory — an in-memory counter only sees requests handled by
// the SAME warm instance, never ones routed to a different one, so it would silently fail
// to limit anything in exactly the burst-load scenario it exists to protect against.
// Postgres itself is the one thing every instance actually shares, so the guard lives
// there instead — same reasoning pool.ts's applySchema() advisory lock already follows
// for the identical "multiple serverless instances need to coordinate" problem shape.
//
// A plain counter row, not a transaction-scoped advisory lock (applySchema()'s own
// approach): an export spans many separate queries over 15-20+ seconds of streaming, not
// one transaction, so nothing could hold a single advisory lock for its whole duration
// without pinning one pooled connection busy the entire time — the exact kind of
// connection-pool pressure this guard exists to reduce, not add. The atomic UPDATE below
// (only increments if under the limit) is the same conditional-UPDATE "compare and swap"
// pattern disposalWriteOff.ts's applyFullDisposal already uses for its own concurrent-
// write race, just guarding a count instead of a boolean state transition.
const MAX_CONCURRENT_EXPORTS = 2;
// Self-heals a slot leaked by an abnormal exit (a Vercel function killed at its
// maxDuration, an unhandled process crash) that never reached releaseExportSlot's
// `finally` — a slot older than this is treated as stale and reclaimed, rather than
// requiring a manual DB fix. Comfortably above the real, benchmarked ~18s for a full
// 220k-row export.
const STALE_SLOT_SECONDS = 120;

/** Returns true if a slot was acquired (the caller may proceed) or false if
 *  MAX_CONCURRENT_EXPORTS are already running (the caller should 429). Always pair with
 *  releaseExportSlot in a `finally`, however the request ends (success, a thrown error,
 *  or the client disconnecting mid-stream). */
export async function acquireExportSlot(db: pg.Pool): Promise<boolean> {
  await db.query(
    `UPDATE export_concurrency SET active_count = 0, updated_at = now()
     WHERE updated_at < now() - ($1 || ' seconds')::interval AND active_count > 0`,
    [STALE_SLOT_SECONDS]
  );
  const { rows } = await db.query<{ active_count: number }>(
    `UPDATE export_concurrency SET active_count = active_count + 1, updated_at = now()
     WHERE active_count < $1
     RETURNING active_count`,
    [MAX_CONCURRENT_EXPORTS]
  );
  return rows.length > 0;
}

export async function releaseExportSlot(db: pg.Pool): Promise<void> {
  await db.query(`UPDATE export_concurrency SET active_count = GREATEST(active_count - 1, 0), updated_at = now()`);
}
