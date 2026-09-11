import type pg from "pg";

// Persistent (DB-backed, cross-instance) cache for GET /api/reports/dashboard-totals —
// see report_totals_cache's own comment in schema.sql for why this is a SEPARATE table
// from db/reportCache.ts's in-memory cache rather than an extension of it: an in-memory
// cache only helps repeat requests that happen to land on the same warm Vercel
// serverless instance, which is exactly what was producing the intermittent 504s this
// exists to fix — a cold instance (or one of several running concurrently) had to pay
// the full far_calc_component() scan every time regardless of how recently another
// instance had just computed the identical answer. A row in Postgres is visible to every
// instance immediately.
//
// TTL-based expiry, same 15-minute window this was requested with, is checked in SQL
// (`computed_at > NOW() - INTERVAL '15 minutes'`) rather than read back and compared in
// JS, so a stale row never round-trips out of the database at all.
const TTL_INTERVAL_SQL = "15 minutes";

/** Stable, order-independent key for one (asAt, center, subClassification, centerScope)
 *  combination — centerScope is part of the key (not just the named filters) because two
 *  users with different center-scoped access asking for "the same" asAt/center/
 *  subClassification can legitimately get different correct totals; caching by the named
 *  filters alone would leak one user's scoped total to another. `null` centerScope
 *  (unscoped — sees every center) is a distinct, stable value from any real scope set. */
export function dashboardTotalsCacheKey(parts: {
  asAt: string;
  center?: string;
  subClassification?: string;
  centerScope: Set<string> | null;
}): string {
  const scopeKey = parts.centerScope === null ? null : [...parts.centerScope].sort();
  return `dashboard-totals:${JSON.stringify({
    asAt: parts.asAt,
    center: parts.center ?? null,
    subClassification: parts.subClassification ?? null,
    centerScope: scopeKey
  })}`;
}

export async function getCachedDashboardTotals<T>(db: pg.Pool, cacheKey: string): Promise<T | undefined> {
  const { rows } = await db.query<{ payload: T }>(
    `SELECT payload FROM report_totals_cache WHERE cache_key = $1 AND computed_at > NOW() - INTERVAL '${TTL_INTERVAL_SQL}'`,
    [cacheKey]
  );
  return rows[0]?.payload;
}

export async function setCachedDashboardTotals(db: pg.Pool, cacheKey: string, payload: unknown): Promise<void> {
  await db.query(
    `INSERT INTO report_totals_cache (cache_key, payload, computed_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (cache_key) DO UPDATE SET payload = $2, computed_at = NOW()`,
    [cacheKey, JSON.stringify(payload)]
  );
}

/** Full clear, not a per-key bust — called from the write routes that can change what
 *  Dashboard Totals reports (asset create/edit/disposal/addition/delete, bulk asset
 *  upload/disposal commits). A blanket DELETE is the deliberately simple choice here: the
 *  alternative (computing exactly which asAt/center/subClassification/centerScope keys a
 *  given write could affect) is real, ongoing complexity for a table this small and
 *  cheap to fully repopulate — the 15-minute TTL above already bounds how stale an
 *  uninvalidated key can get, so a missed CALL SITE (a route that should call this but
 *  doesn't) degrades to "stale for up to 15 minutes," never silently wrong forever. Every
 *  call site DOES await this one, though (see assets.ts's bustDashboardTotalsCache) —
 *  it's one cheap query against the same pool the request already holds, and not
 *  awaiting it would race the very next dashboard load against a DELETE that may not
 *  have committed yet. */
export async function invalidateDashboardTotalsCache(db: pg.Pool): Promise<void> {
  await db.query(`DELETE FROM report_totals_cache`);
}

/** Test-only reset — same purpose as db/reportCache.ts's clearReportCacheForTests, just
 *  for this table instead of that module's in-memory Map: without it, a row this cache
 *  writes during one test could serve a stale result to a LATER test that reuses the
 *  same asAt/center/subClassification/centerScope combination but expects different
 *  underlying data, since tests usually mutate the database directly via SQL rather than
 *  through the app's own write routes (the only place this cache is actually
 *  invalidated in real traffic). Not exposed outside tests. */
export async function clearReportTotalsCacheForTests(db: pg.Pool): Promise<void> {
  await db.query(`DELETE FROM report_totals_cache`);
}
