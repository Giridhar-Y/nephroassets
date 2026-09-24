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
  getReportDataRevision,
  setCachedReportTotals
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

/** Warms report_totals_cache for dashboard-totals, dashboard-trend and
 *  audit-reconciliation, for each of prewarmDates() in order — skips anything already
 *  cached and unexpired (the common case once this has run once), so a repeat call is
 *  cheap. No-ops cleanly if Settings hasn't been configured yet (same condition the
 *  routes themselves 409 on). Never throws on an individual date's failure — logs and
 *  moves on to the next, so one bad date can't block the others from warming. */
export async function prewarmDashboardCaches(db: pg.Pool): Promise<void> {
  const fyBase = await requireFySettings(db);
  if (!fyBase) return;

  for (const asAt of prewarmDates(new Date(), fyBase)) {
    try {
      await warmOne(db, asAt);
    } catch (err) {
      console.error(`Dashboard pre-warm failed for asAt=${asAt}:`, err);
    }
  }

  // Then every date a user asked for that wasn't cached (jobs/prewarmRequests.ts),
  // claimed one at a time until nothing is claimable — so a date requested while this
  // run was busy isn't left for the next (possibly hours-away) scheduled run. A success
  // removes the row; a failure keeps it in a 10-minute backoff (so this loop moves on
  // rather than retrying it back-to-back, and polls can't re-dispatch it early).
  for (let req = await claimPrewarmRequest(db); req; req = await claimPrewarmRequest(db)) {
    try {
      const isCurrentFy = req.fyStart === fyBase.fyStart && req.fyEnd === fyBase.fyEnd;
      await warmOne(db, req.asAt, isCurrentFy ? undefined : { fyStart: req.fyStart, fyEnd: req.fyEnd });
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
 *  one — warms only that report, since Dashboard always uses the current FY. */
async function warmOne(db: pg.Pool, asAt: string, reconPeriod?: { fyStart: string; fyEnd: string }): Promise<void> {
  if (reconPeriod) return warmAuditReconciliation(db, asAt, reconPeriod);
  const fy: Fy = (await requireFySettings(db, { asAt }))!;
  const totalsKey = dashboardTotalsCacheKey({ asAt, centerScope: null });
  if (!(await getCachedReportTotals(db, totalsKey))) {
    const revision = await getReportDataRevision(db);
    const totals = await withoutStatementTimeout(db, (c) => computeDashboardTotals(c, fy, UNSCOPED_USER, UNFILTERED));
    await setCachedReportTotals(db, totalsKey, totals, revision);
  }

  const trendKey = dashboardTrendCacheKey({ asAt, centerScope: null });
  if (!(await getCachedReportTotals(db, trendKey))) {
    const revision = await getReportDataRevision(db);
    const trend = await withoutStatementTimeout(db, (c) => computeDashboardTrend(c, fy, UNSCOPED_USER, UNFILTERED));
    await setCachedReportTotals(db, trendKey, trend, revision);
  }

  await warmAuditReconciliation(db, asAt, { fyStart: fy.fyStart, fyEnd: fy.fyEnd });
}

async function warmAuditReconciliation(db: pg.Pool, asAt: string, period: { fyStart: string; fyEnd: string }): Promise<void> {
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
    const revision = await getReportDataRevision(db);
    const recon = await withoutStatementTimeout(db, (c) => computeAuditReconciliation(c, reconFy, UNSCOPED_USER));
    await setCachedReportTotals(db, reconKey, recon, revision);
  }
}
