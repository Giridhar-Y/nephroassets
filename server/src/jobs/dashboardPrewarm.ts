import type pg from "pg";
import {
  computeAuditReconciliation,
  computeDashboardTotals,
  computeDashboardTrend,
  requireFySettings,
  type Fy
} from "../routes/reports.js";
import {
  auditReconciliationCacheKey,
  dashboardTotalsCacheKey,
  dashboardTrendCacheKey,
  getCachedReportTotals,
  getReportDataVersion,
  MONTH_END_TTL,
  setCachedReportTotals,
  type ReportCacheTtl
} from "../db/reportTotalsCache.js";
import { claimPrewarmRequest, completePrewarmRequest, failPrewarmRequest } from "./prewarmRequests.js";

// Populates report_totals_cache BEFORE a real user's request needs it — see this
// project's own incident history: dashboard-totals/dashboard-trend's cache (see
// reportTotalsCache.ts) only ever helps the *second* request for a given asAt. The
// *first* request for a never-before-cached asAt still pays the full
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

// The client doesn't request Settings' stored AS_AT — SettingsContext resets it to the
// browser's own "today" on every fresh load, and only THAT write moves the stored value.
// Anchoring on the stored AS_AT (as this used to) meant a run before the day's first
// visit warmed yesterday, and the first real Dashboard load of the day hit a cold cache:
// a live 504 incident on 2026-09-24. So anchor on today as the users' browsers see it.
// ponytail: single fixed timezone (every user is in India); make it configurable if
// users ever span timezones.
const USER_TIMEZONE = "Asia/Kolkata";

function isoDateInTimezone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function shiftIsoDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The dates worth warming, most urgent first: users' today (clamped to the FY, the
 *  same clamp SettingsContext applies), the stored AS_AT if someone picked another date,
 *  and yesterday (date-picker nudges). Deduplicated. Exported for its test. */
export function prewarmDates(now: Date, fy: { asAt: string; fyStart: string; fyEnd: string }): string[] {
  const today = isoDateInTimezone(now, USER_TIMEZONE);
  const clamped = today < fy.fyStart ? fy.fyStart : today > fy.fyEnd ? fy.fyEnd : today;
  const yesterday = shiftIsoDate(clamped, -1);
  const dates = [clamped, fy.asAt, ...(yesterday >= fy.fyStart ? [yesterday] : [])];
  return [...new Set(dates)];
}

/** The current FY's completed month-ends (last day of each month from FY start up to,
 *  not including, the month users are in now), most recent first: the dates finance
 *  checks most after "today". Exported for its test. */
export function monthEndDates(now: Date, fy: { fyStart: string; fyEnd: string }): string[] {
  const today = isoDateInTimezone(now, USER_TIMEZONE);
  const dates: string[] = [];
  for (let d = new Date(`${fy.fyStart.slice(0, 7)}-01T00:00:00Z`); ; d.setUTCMonth(d.getUTCMonth() + 1)) {
    // Day 0 of next month = last day of this one.
    const monthEnd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    if (monthEnd >= today || monthEnd > fy.fyEnd) break;
    if (monthEnd >= fy.fyStart) dates.push(monthEnd);
  }
  return dates.reverse();
}

/** Month-ends are background work nobody is waiting on: stop STARTING new ones once a
 *  run has been going this long, so a run after a cache-wide invalidation (every
 *  month-end stale at once: 3 heavy scans x up to 11 dates) stays inside the workflow's
 *  20-minute timeout and spreads the rest over the next runs instead of one long spike. */
const MONTH_END_BUDGET_MS = 12 * 60_000;

/** Warms report_totals_cache for dashboard-totals, dashboard-trend and
 *  audit-reconciliation, in priority order: prewarmDates() (today, what every load asks
 *  for), then dates users have asked for and are waiting on, then the current FY's
 *  month-ends (within MONTH_END_BUDGET_MS). Skips anything already cached, unexpired and
 *  computed against the current data, so a repeat call is cheap and only stale dates are
 *  recomputed. No-ops cleanly if Settings hasn't been configured yet (same condition the
 *  routes themselves 409 on). Never throws on an individual date's failure: logs and
 *  moves on, so one bad date can't block the others. */
export async function prewarmDashboardCaches(
  db: pg.Pool,
  opts: { now?: Date; monthEndBudgetMs?: number } = {}
): Promise<void> {
  const started = Date.now();
  const now = opts.now ?? new Date();
  const fyBase = await requireFySettings(db);
  if (!fyBase) return;

  for (const asAt of prewarmDates(now, fyBase)) {
    try {
      await warmOne(db, asAt);
    } catch (err) {
      console.error(`Dashboard pre-warm failed for asAt=${asAt}:`, err);
    }
  }

  await drainRequestedDates(db, fyBase);

  // Month-ends: only on this regular pass (never dispatched per edit, so an edit can't
  // trigger a burst of workflow runs), only the stale ones (warmOne's cache check), and
  // cached for 7 days (MONTH_END_TTL) so they aren't recomputed every 6 hours for
  // identical results. Requested dates are re-drained between month-ends, so a user
  // waiting on a spinner never queues behind this background work.
  for (const asAt of monthEndDates(now, fyBase)) {
    if (Date.now() - started >= (opts.monthEndBudgetMs ?? MONTH_END_BUDGET_MS)) {
      console.log("Pre-warm: month-end budget used up; the remaining month-ends catch up on the next run.");
      break;
    }
    try {
      await warmOne(db, asAt, { ttl: MONTH_END_TTL });
    } catch (err) {
      console.error(`Pre-warm failed for month-end asAt=${asAt}:`, err);
    }
    await drainRequestedDates(db, fyBase);
  }
}

/** Every date a user asked for that wasn't cached (jobs/prewarmRequests.ts), claimed
 *  one at a time until nothing is claimable, so a date requested while this run was busy
 *  isn't left for the next (possibly hours-away) scheduled run. A success removes the
 *  row; a failure keeps it in a 10-minute backoff (so this loop moves on rather than
 *  retrying it back-to-back, and polls can't re-dispatch it early). */
async function drainRequestedDates(db: pg.Pool, fyBase: { fyStart: string; fyEnd: string }): Promise<void> {
  for (let req = await claimPrewarmRequest(db); req; req = await claimPrewarmRequest(db)) {
    try {
      const isCurrentFy = req.fyStart === fyBase.fyStart && req.fyEnd === fyBase.fyEnd;
      await warmOne(db, req.asAt, isCurrentFy ? {} : { reconPeriod: { fyStart: req.fyStart, fyEnd: req.fyEnd } });
      await completePrewarmRequest(db, req);
    } catch (err) {
      console.error(`Pre-warm failed for requested asAt=${req.asAt} (${req.fyStart}..${req.fyEnd}):`, err);
      await failPrewarmRequest(db, req, err);
    }
  }
}

// This is a background job, not an interactive request: the database role's own
// statement_timeout (Supabase's default, ~2 min) is right for a user-facing query but
// killed a cold totals scan here under load (2026-09-24 manual run: "canceling statement
// due to statement timeout"). SET LOCAL inside a transaction lifts it for this job's
// queries only, and — unlike a session-level SET or a startup `options` param — works
// through Supabase's transaction-mode pooler too.
async function withoutStatementTimeout<T>(db: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = 0");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** `reconPeriod`: an Audit Reconciliation request for an FY other than Settings' current
 *  one — warms only that report, since Dashboard always uses the current FY. `ttl`: the
 *  published rows' lifetime (month-ends use MONTH_END_TTL). */
async function warmOne(
  db: pg.Pool,
  asAt: string,
  { reconPeriod, ttl }: { reconPeriod?: { fyStart: string; fyEnd: string }; ttl?: ReportCacheTtl } = {}
): Promise<void> {
  if (reconPeriod) return warmAuditReconciliation(db, asAt, reconPeriod, ttl);
  const fy: Fy = (await requireFySettings(db, { asAt }))!;
  const totalsKey = dashboardTotalsCacheKey({ asAt, centerScope: null });
  if (!(await getCachedReportTotals(db, totalsKey))) {
    const version = await getReportDataVersion(db);
    const totals = await withoutStatementTimeout(db, (c) => computeDashboardTotals(c, fy, UNSCOPED_USER, UNFILTERED));
    await setCachedReportTotals(db, totalsKey, totals, version, ttl);
  }

  const trendKey = dashboardTrendCacheKey({ asAt, centerScope: null });
  if (!(await getCachedReportTotals(db, trendKey))) {
    const version = await getReportDataVersion(db);
    const trend = await withoutStatementTimeout(db, (c) => computeDashboardTrend(c, fy, UNSCOPED_USER, UNFILTERED));
    await setCachedReportTotals(db, trendKey, trend, version, ttl);
  }

  await warmAuditReconciliation(db, asAt, { fyStart: fy.fyStart, fyEnd: fy.fyEnd }, ttl);
}

async function warmAuditReconciliation(
  db: pg.Pool,
  asAt: string,
  period: { fyStart: string; fyEnd: string },
  ttl?: ReportCacheTtl
): Promise<void> {
  // Resolved exactly like the route does for the client's request (it always sends
  // fyStart/fyEnd alongside asAt), so the key and payload match.
  const reconFy = (await requireFySettings(db, { asAt, ...period }))!;
  const reconKey = auditReconciliationCacheKey({
    asAt,
    fyStart: reconFy.fyStart,
    fyEnd: reconFy.fyEnd,
    daysInFy: reconFy.daysInFy,
    centerScope: null
  });
  if (!(await getCachedReportTotals(db, reconKey))) {
    const version = await getReportDataVersion(db);
    const recon = await withoutStatementTimeout(db, (c) => computeAuditReconciliation(c, reconFy, UNSCOPED_USER));
    await setCachedReportTotals(db, reconKey, recon, version, ttl);
  }
}
