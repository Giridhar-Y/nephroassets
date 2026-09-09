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
// Plain time-based expiry — NOT invalidated on write. A prior version wrapped
// pool.query/pool.connect (db/pool.ts) to clear this cache the instant any write touched
// assets/transfers/settings, specifically to avoid scattering ~17 explicit invalidation
// calls across every mutating route. That wrapping caused a real production incident:
// pg-pool hands the SAME underlying client object back out on every checkout (confirmed
// in its own source — client.release is reassigned per checkout, client.query is not),
// so re-wrapping client.query on every db.connect() call nested a new layer around the
// previous one on every reuse of that same pooled client, without limit, over the life
// of a long-running process — Register/Reports eventually hung under real traffic. Fixed
// by removing the wrapper entirely rather than making it idempotent: touching pg.Pool's
// own internals for this is more risk than a report being briefly stale is worth.
// MAX_AGE_MS is short enough that "stale after a mutation" is barely noticeable (a
// revisit or a page reload always gets fresh figures once it expires) while still
// collapsing the common case this exists for — several requests for the same report
// within a few seconds of each other.
export const REPORT_CACHE_TTL_MS = 20 * 1000;

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
  if (Date.now() - entry.cachedAt > REPORT_CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return entry.value as T;
}

export function setCachedReport<T>(key: string, value: T): void {
  cache.set(key, { value, cachedAt: Date.now() });
}

/** Test-only reset — without this, this module-level cache persists across every test
 *  in a file (same process, same Map), so a `DELETE FROM assets` in one test's own
 *  beforeEach wouldn't stop a later test with the same cache key (e.g. the same
 *  unfiltered register-summary request) from seeing an earlier test's stale cached
 *  result within the TTL window. Not exposed outside tests — same convention as
 *  assetsExportJobs.ts's setObjectStorageForTests. */
export function clearReportCacheForTests(): void {
  cache.clear();
}
