import type pg from "pg";
import {
  computeDashboardTotals,
  computeDashboardTrend,
  requireFySettings,
  type Fy
} from "../routes/reports.js";
import {
  dashboardTotalsCacheKey,
  dashboardTrendCacheKey,
  getCachedReportTotals,
  setCachedReportTotals
} from "../db/reportTotalsCache.js";

// Populates report_totals_cache BEFORE a real user's request needs it — see this
// project's own incident history: dashboard-totals/dashboard-trend's cache (15-minute
// TTL, see reportTotalsCache.ts) only ever helps the *second* request for a given
// asAt. The *first* request for a never-before-cached asAt still pays the full
// far_calc_component() scan inline, and at real production scale (219,329+ assets)
// that scan measured 60s+ against real Supabase Pro — past Vercel's function timeout.
// A cache that's never actually warm before a real user hits it doesn't help at all.
//
// This function has NO timeout of its own — it's plain Node/TypeScript, not an HTTP
// handler. Whoever calls it determines the real constraint:
//   - server/src/index.ts (Docker/Render/local — a long-running process) calls this
//     directly on a setInterval — no timeout risk at all.
//   - Vercel CANNOT call this from inside any Vercel Function (Cron included — a Cron
//     trigger still runs as an ordinary serverless invocation, same maxDuration).
//     Verified directly, not assumed: an ISOLATED (no concurrent request) call to
//     dashboard-totals against the real 219,329-asset production database still hit
//     Vercel's own FUNCTION_INVOCATION_TIMEOUT at ~60s, even after the Supabase compute
//     tier was upgraded. See server/src/scripts/prewarmDashboard.ts — a plain script,
//     run from OUTSIDE Vercel's function runtime entirely (a GitHub Actions schedule,
//     or any machine with DATABASE_URL), calls this same function with no such limit.
//
// Only warms the UNFILTERED (no center/subClassification), unscoped (centerScope:
// null) view — the one every real Dashboard load actually requests by default
// (DashboardPage.tsx never sends a filter unless the user picks one). A filtered/
// scoped view narrows the row count it has to scan, so it's inherently cheaper and
// far less likely to time out on its own even without pre-warming.
const UNSCOPED_USER = { centerScope: null };
const UNFILTERED = {};

/** How many trailing days (inclusive of the anchor date) to keep warm — "today" (in
 *  the sense every real request actually means: whatever Settings' AS_AT currently
 *  is) plus a couple of days back, in case someone navigates the header's date picker
 *  a little into the recent past. Small on purpose: each date costs two real
 *  far_calc_component() scans (totals + trend) to warm, so this isn't "warm every
 *  possible date," just the handful someone is actually likely to load soon. */
const TRAILING_DAYS = 3;

function trailingDates(anchor: string, count: number): string[] {
  const dates: string[] = [];
  const d = new Date(`${anchor}T00:00:00Z`);
  for (let i = 0; i < count; i++) {
    dates.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return dates;
}

/** Warms report_totals_cache for dashboard-totals and dashboard-trend, for AS_AT and
 *  the TRAILING_DAYS-1 days before it — skips anything already cached and unexpired
 *  (the common case once this has run once), so a repeat call is cheap. No-ops
 *  cleanly if Settings hasn't been configured yet (same condition the routes
 *  themselves 409 on). Never throws on an individual date's failure — logs and moves
 *  on to the next, so one bad date can't block the others from warming. */
export async function prewarmDashboardCaches(db: pg.Pool): Promise<void> {
  const fyBase = await requireFySettings(db);
  if (!fyBase) return;

  for (const asAt of trailingDates(fyBase.asAt, TRAILING_DAYS)) {
    const fy: Fy = { ...fyBase, asAt };
    try {
      await warmOne(db, fy);
    } catch (err) {
      console.error(`Dashboard pre-warm failed for asAt=${asAt}:`, err);
    }
  }
}

async function warmOne(db: pg.Pool, fy: Fy): Promise<void> {
  const totalsKey = dashboardTotalsCacheKey({ asAt: fy.asAt, centerScope: null });
  if (!(await getCachedReportTotals(db, totalsKey))) {
    const totals = await computeDashboardTotals(db, fy, UNSCOPED_USER, UNFILTERED);
    await setCachedReportTotals(db, totalsKey, totals);
  }

  const trendKey = dashboardTrendCacheKey({ asAt: fy.asAt, centerScope: null });
  if (!(await getCachedReportTotals(db, trendKey))) {
    const trend = await computeDashboardTrend(db, fy, UNSCOPED_USER, UNFILTERED);
    await setCachedReportTotals(db, trendKey, trend);
  }
}
