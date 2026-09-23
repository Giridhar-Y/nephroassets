import type pg from "pg";

// Persistent (DB-backed, cross-instance) cache, originally built for GET
// /api/reports/dashboard-totals and now shared by every report endpoint that runs a
// full far_calc_component() scan with no other selective filter — dashboard-totals,
// dashboard-trend, and audit-reconciliation as of this writing. See
// report_totals_cache's own comment in schema.sql for why this is a SEPARATE table
// from db/reportCache.ts's in-memory cache rather than an extension of it: an in-memory
// cache only helps repeat requests that happen to land on the same warm Vercel
// serverless instance, which is exactly what was producing the intermittent 504s this
// exists to fix — a cold instance (or one of several running concurrently) had to pay
// the full scan every time regardless of how recently another instance had just
// computed the identical answer. A row in Postgres is visible to every instance
// immediately. One shared table, not one per endpoint: `cache_key` is namespaced per
// caller (see each key-builder below) so they can't collide, and a single blanket
// invalidation (below) correctly covers all of them at once — see that function's own
// comment for why a shared "just clear everything" is the right tradeoff here, not
// per-endpoint invalidation.
//
// TTL-based expiry is checked in SQL (`computed_at > NOW() - INTERVAL '...'`) rather
// than read back and compared in JS, so a stale row never round-trips out of the
// database at all.
//
// Was 15 minutes, matching jobs/dashboardPrewarm.ts's intended 10-minute refresh
// cadence — raised to 6 hours after a real production incident (2026-09-23) exposed a
// gap between that INTENDED cadence and GitHub Actions' ACTUAL one: the scheduled
// trigger backing the pre-warm job (dashboard-prewarm.yml) is real but unreliable at
// short intervals — measured gaps of 2.5-4.5 hours between successive runs on this
// account/plan, not the configured 10 minutes (a documented GitHub Actions platform
// characteristic for `schedule:` on non-Enterprise plans, not a bug in the workflow
// config — see that file's own comment). At 15 minutes, the cache reliably expired
// between real pre-warm runs, so the very next live request for that date paid the
// same 60s+ cold-compute cost the pre-warm job exists to avoid — which then cascades
// into pool.ts's `max: 5` connection limit saturating and degrading EVERY other route,
// not just this one (the exact incident class this file's own header already
// describes). 6 hours gives real margin over the worst gap observed so far while an
// actually-reliable trigger (an external cron service or Supabase's own pg_cron
// calling this repo's GitHub Actions dispatch API, still undecided — see the incident
// writeup) is evaluated; every write-route invalidation (bustReportTotalsCache) still
// fires immediately regardless of this TTL, so a stale read only happens when NOTHING
// has changed AND the pre-warm job also hasn't managed to run — not "up to 6 hours
// behind a real edit."
const TTL_INTERVAL_SQL = "6 hours";

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
  // v2: disposalPL.allTime gained totalDeletions/saleProceeds — the bump keeps an
  // old-shape row from being served to a client that expects the new fields.
  return `dashboard-totals:v2:${JSON.stringify({
    asAt: parts.asAt,
    center: parts.center ?? null,
    subClassification: parts.subClassification ?? null,
    centerScope: scopeKey
  })}`;
}

/** Same shape/reasoning as dashboardTotalsCacheKey above — dashboard-trend takes the
 *  same asAt/center/subClassification/centerScope inputs (fyStart/fyEnd/daysInFy come
 *  from the current Settings row, not a per-request param, same as dashboard-totals, so
 *  they're not part of the key either). Distinct prefix keeps it from colliding with a
 *  dashboard-totals entry for the same parameters in the same shared table. */
export function dashboardTrendCacheKey(parts: {
  asAt: string;
  center?: string;
  subClassification?: string;
  centerScope: Set<string> | null;
}): string {
  const scopeKey = parts.centerScope === null ? null : [...parts.centerScope].sort();
  return `dashboard-trend:${JSON.stringify({
    asAt: parts.asAt,
    center: parts.center ?? null,
    subClassification: parts.subClassification ?? null,
    centerScope: scopeKey
  })}`;
}

/** Audit Reconciliation takes a period override (fyStart/fyEnd), not
 *  center/subClassification filters (it returns every Sub Classification's figures at
 *  once) — so its key shape is asAt + fyStart + fyEnd + centerScope instead. Same
 *  centerScope-leak reasoning as the two key builders above. */
export function auditReconciliationCacheKey(parts: {
  asAt: string;
  fyStart: string;
  fyEnd: string;
  centerScope: Set<string> | null;
}): string {
  const scopeKey = parts.centerScope === null ? null : [...parts.centerScope].sort();
  return `audit-reconciliation:${JSON.stringify({
    asAt: parts.asAt,
    fyStart: parts.fyStart,
    fyEnd: parts.fyEnd,
    centerScope: scopeKey
  })}`;
}

/** The payload comes back with the row's own `computedAt` merged in — what the
 *  Dashboard/Audit Reconciliation "Last updated" label shows. */
export async function getCachedReportTotals<T>(db: pg.Pool, cacheKey: string): Promise<(T & { computedAt: string }) | undefined> {
  const { rows } = await db.query<{ payload: T & { computedAt: string } }>(
    // Same "…T…Z" ISO shape setCachedReportTotals returns (toISOString), not the
    // session-timezone offset form jsonb would give a raw timestamptz.
    `SELECT payload || jsonb_build_object('computedAt', to_char(computed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS payload FROM report_totals_cache WHERE cache_key = $1 AND computed_at > NOW() - INTERVAL '${TTL_INTERVAL_SQL}'`,
    [cacheKey]
  );
  return rows[0]?.payload;
}

/** Returns the stored `computed_at` (ISO string), same value a later cache hit reports. */
export async function setCachedReportTotals(db: pg.Pool, cacheKey: string, payload: unknown): Promise<string> {
  const { rows } = await db.query<{ computed_at: Date }>(
    `INSERT INTO report_totals_cache (cache_key, payload, computed_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (cache_key) DO UPDATE SET payload = $2, computed_at = NOW()
     RETURNING computed_at`,
    [cacheKey, JSON.stringify(payload)]
  );
  return rows[0]!.computed_at.toISOString();
}

/** Full clear, not a per-key bust — called from every write route that can change what
 *  Dashboard Totals/Trend or Audit Reconciliation report (asset create/edit/disposal/
 *  addition/delete, bulk asset upload/disposal commits). A blanket DELETE is the
 *  deliberately simple choice here: the alternative (computing exactly which
 *  asAt/center/subClassification/fyStart/fyEnd/centerScope keys, across three different
 *  key shapes, a given write could affect) is real, ongoing complexity for a table this
 *  small and cheap to fully repopulate — the 15-minute TTL above already bounds how
 *  stale an uninvalidated key can get, so a missed CALL SITE (a route that should call
 *  this but doesn't) degrades to "stale for up to 15 minutes," never silently wrong
 *  forever. Every asset-mutating call site DOES await this one, though (see assets.ts's
 *  bustReportTotalsCache) — it's one cheap query against the same pool the request
 *  already holds, and not awaiting it would race the very next dashboard/report load
 *  against a DELETE that may not have committed yet. Note: a Settings change
 *  (FY Start/End, Days in FY) does NOT call this — same pre-existing gap
 *  dashboard-totals already had, bounded by the same 15-minute TTL, not something this
 *  change introduces. */
export async function invalidateReportTotalsCache(db: pg.Pool): Promise<void> {
  await db.query(`DELETE FROM report_totals_cache`);
}

/** Test-only reset — same purpose as db/reportCache.ts's clearReportCacheForTests, just
 *  for this table instead of that module's in-memory Map: without it, a row this cache
 *  writes during one test could serve a stale result to a LATER test that reuses the
 *  same cache key but expects different underlying data, since tests usually mutate the
 *  database directly via SQL rather than through the app's own write routes (the only
 *  place this cache is actually invalidated in real traffic). Not exposed outside
 *  tests. */
export async function clearReportTotalsCacheForTests(db: pg.Pool): Promise<void> {
  await db.query(`DELETE FROM report_totals_cache`);
}
