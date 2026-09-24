import type pg from "pg";

// On-demand pre-warm for dates nobody has viewed recently. On Vercel (Hobby: every
// function is killed at 60s, no way to raise it) a cold far_calc_component() scan at real
// scale takes 60-120s, so computing it inline can only ever 504 — and the killed
// function's Postgres query keeps running, piling load onto the database. Instead, a
// cold request records the date here and triggers the pre-warm GitHub Actions workflow
// (no such time limit; see dashboardPrewarm.ts), and the route answers 202 "preparing".
// The client polls until the job has filled report_totals_cache.
//
// Docker/Render/local (a long-running process, no per-request timeout) keep computing
// inline — this only applies where VERCEL=1 (set by Vercel itself on every deployment).
export function deferColdReportCompute(): boolean {
  return process.env.VERCEL === "1";
}

export interface PrewarmRequest {
  asAt: string;
  fyStart: string;
  fyEnd: string;
}

/** A still-pending request is re-dispatched at most this often — covers a dispatch that
 *  failed, or a job run that failed on this date, without firing GitHub on every 15s
 *  client poll. */
const REDISPATCH_AFTER = "10 minutes";

/** Records the request and, if it's new (or stale), triggers the workflow. Never throws
 *  on a dispatch failure: the row stays, and the next scheduled pre-warm run (or a
 *  re-dispatch after REDISPATCH_AFTER) still picks it up. */
export async function requestPrewarm(db: pg.Pool, req: PrewarmRequest): Promise<void> {
  const { rowCount } = await db.query(
    `INSERT INTO report_prewarm_requests (as_at, fy_start, fy_end) VALUES ($1, $2, $3)
     ON CONFLICT (as_at, fy_start, fy_end) DO UPDATE SET requested_at = NOW()
       WHERE report_prewarm_requests.requested_at < NOW() - INTERVAL '${REDISPATCH_AFTER}'`,
    [req.asAt, req.fyStart, req.fyEnd]
  );
  if (rowCount) await dispatchPrewarmWorkflow();
}

export async function pendingPrewarmRequests(db: pg.Pool): Promise<PrewarmRequest[]> {
  const { rows } = await db.query<{ as_at: string; fy_start: string; fy_end: string }>(
    `SELECT as_at, fy_start, fy_end FROM report_prewarm_requests ORDER BY requested_at`
  );
  return rows.map((r) => ({ asAt: r.as_at, fyStart: r.fy_start, fyEnd: r.fy_end }));
}

/** Removed after one attempt, success or not — a date that failed gets re-requested by
 *  the client's next poll instead of being retried forever by every scheduled run. */
export async function clearPrewarmRequest(db: pg.Pool, req: PrewarmRequest): Promise<void> {
  await db.query(`DELETE FROM report_prewarm_requests WHERE as_at = $1 AND fy_start = $2 AND fy_end = $3`, [
    req.asAt,
    req.fyStart,
    req.fyEnd
  ]);
}

/** POST .../actions/workflows/dashboard-prewarm.yml/dispatches. Needs
 *  GITHUB_DISPATCH_TOKEN (fine-grained PAT, this repo only, Actions: read & write) and
 *  GITHUB_DISPATCH_REPO ("owner/name"); GITHUB_DISPATCH_REF defaults to master. Missing
 *  config just logs — the request row is still served by the next scheduled run. */
export async function dispatchPrewarmWorkflow(): Promise<void> {
  const token = process.env.GITHUB_DISPATCH_TOKEN;
  const repo = process.env.GITHUB_DISPATCH_REPO;
  if (!token || !repo) {
    console.warn("Pre-warm dispatch skipped: GITHUB_DISPATCH_TOKEN / GITHUB_DISPATCH_REPO not set.");
    return;
  }
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/dashboard-prewarm.yml/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
      },
      body: JSON.stringify({ ref: process.env.GITHUB_DISPATCH_REF ?? "master" }),
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) console.error(`Pre-warm dispatch failed: ${res.status} ${await res.text().catch(() => "")}`);
  } catch (err) {
    console.error("Pre-warm dispatch failed:", err);
  }
}
