// In-memory cache for the Reports module's expensive whole-register aggregates
// (Register Summary, Location Summary, Depreciation Posting) — each one runs
// far_calc_component() (LOCKED calc engine, see calcFunction.sql's header) over every
// matching asset, which is the genuine, irreducible cost at 220,000+ rows (measured
// ~32s for an unfiltered Register Summary against this repo's own scale-test harness —
// see scale.loadtest.ts). The query shape itself is already minimal (one
// far_calc_component() call per component per row, via a single calc CTE — see
// buildCalcCteExtras) and the calc engine can't be touched without explicit sign-off
// (calcFunction.sql's own header), so caching the RESULT is the only safe lever left:
// most report loads (page revisits, multiple users viewing the same AS_AT, switching
// between report tabs) ask the exact same question again before anything has changed.
//
// Invalidated from ONE place — see pool.ts's installReportCacheInvalidation — rather
// than an explicit call at every asset/transfer/settings-mutating route. This app
// already has real precedent for "forgot to update every duplicate spot" bugs (the
// prior-FY-disposal filter landed in assets.ts/assetsExport.ts but not reports.ts's own
// six independent WHERE-clause copies); scattering ~17 explicit invalidation calls
// across capitalization/additions/disposals/transfers/5 bulk routes/3 settings routes
// would be the same failure shape waiting to happen again, including for any future
// mutation route nobody remembers to wire up. A single regex over every write's own SQL
// text can't be forgotten by a future route.
//
// Not an LRU — a handful of distinct report+filter combinations at most (a few users,
// a few AS_AT values), never large enough to need eviction by size. maxAgeMs is a
// safety net, not the primary invalidation mechanism: bounds how stale a result could
// ever get if some write pattern this module's WRITE_PATTERN somehow doesn't recognize
// slips through, without relying on that bound to do the normal-case work.
const MAX_AGE_MS = 5 * 60 * 1000;

interface CacheEntry {
  value: unknown;
  cachedAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Builds a stable cache key from a report name and its distinguishing inputs (AS_AT,
 *  filters, center scope) — order-independent (sorts its own keys) so callers can pass
 *  an options object without worrying about property order. */
export function reportCacheKey(reportName: string, parts: Record<string, unknown>): string {
  const sortedEntries = Object.entries(parts).sort(([a], [b]) => a.localeCompare(b));
  return `${reportName}:${JSON.stringify(sortedEntries)}`;
}

export function getCachedReport<T>(key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.cachedAt > MAX_AGE_MS) {
    cache.delete(key);
    return undefined;
  }
  return entry.value as T;
}

export function setCachedReport<T>(key: string, value: T): void {
  cache.set(key, { value, cachedAt: Date.now() });
}

/** Clears every cached report — called whenever a write touches assets/transfers/
 *  settings (see pool.ts). Clearing everything rather than a scoped subset: this cache
 *  is small (a handful of entries) and cheap to rebuild, so there's no real cost to
 *  being blunt, and no risk of a scoped-invalidation bug leaving a stale entry behind. */
export function invalidateReportCache(): void {
  cache.clear();
}
