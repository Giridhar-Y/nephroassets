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

/** One cooldown for everything: how long a claimed row is leased to its worker, how
 *  long a failed row waits before a retry, and how often a still-pending row may
 *  re-dispatch the workflow — so neither 15s client polls nor a persistently failing
 *  date can hammer GitHub Actions. */
const COOLDOWN = "10 minutes";
/** A date that has failed this many times is dropped (logged); a user asking for it
 *  again later starts over. Stops scheduled runs retrying a broken date forever. */
export const MAX_PREWARM_ATTEMPTS = 3;

/** Records the request and triggers the workflow only when it's actually needed: a new
 *  row, a never-attempted row whose dispatch looks lost (older than COOLDOWN), or a
 *  failed row whose backoff has expired. Concurrent duplicate requests insert once
 *  (primary key), so only one of them dispatches. Never throws on a dispatch failure:
 *  the row stays and the next scheduled pre-warm run still drains it. */
export async function requestPrewarm(db: pg.Pool, req: PrewarmRequest): Promise<void> {
  const { rowCount } = await db.query(
    `INSERT INTO report_prewarm_requests (as_at, fy_start, fy_end) VALUES ($1, $2, $3)
     ON CONFLICT (as_at, fy_start, fy_end) DO UPDATE SET requested_at = NOW()
       -- requested_at moves on every dispatch (the throttle); last_attempt_at is the
       -- lease/backoff. Both must be past the cooldown, or polls after an expired
       -- backoff would each re-dispatch until a worker finally claims the row.
       WHERE report_prewarm_requests.requested_at < NOW() - INTERVAL '${COOLDOWN}'
         AND (report_prewarm_requests.last_attempt_at IS NULL
              OR report_prewarm_requests.last_attempt_at < NOW() - INTERVAL '${COOLDOWN}')`,
    [req.asAt, req.fyStart, req.fyEnd]
  );
  if (rowCount) await dispatchPrewarmWorkflow();
}

/** Atomically claims the oldest claimable row — never attempted, or its lease/backoff
 *  expired — stamping last_attempt_at (the lease) and bumping attempts. SKIP LOCKED
 *  lets two workers run at once without both taking the same date. null when nothing
 *  is claimable right now (failed rows inside their backoff don't count, so a worker's
 *  drain loop ends instead of retrying them back-to-back). */
export async function claimPrewarmRequest(db: pg.Pool): Promise<PrewarmRequest | null> {
  const { rows } = await db.query<{ as_at: string; fy_start: string; fy_end: string }>(
    `UPDATE report_prewarm_requests r SET last_attempt_at = NOW(), attempts = r.attempts + 1
     FROM (
       SELECT as_at, fy_start, fy_end FROM report_prewarm_requests
       WHERE last_attempt_at IS NULL OR last_attempt_at < NOW() - INTERVAL '${COOLDOWN}'
       ORDER BY requested_at
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     ) c
     WHERE r.as_at = c.as_at AND r.fy_start = c.fy_start AND r.fy_end = c.fy_end
     RETURNING r.as_at, r.fy_start, r.fy_end`
  );
  const r = rows[0];
  return r ? { asAt: r.as_at, fyStart: r.fy_start, fyEnd: r.fy_end } : null;
}

export async function completePrewarmRequest(db: pg.Pool, req: PrewarmRequest): Promise<void> {
  await db.query(`DELETE FROM report_prewarm_requests WHERE as_at = $1 AND fy_start = $2 AND fy_end = $3`, [
    req.asAt,
    req.fyStart,
    req.fyEnd
  ]);
}

/** Keeps the row (last_attempt_at, set at claim time, is now its backoff) with the
 *  error — unless it has used up MAX_PREWARM_ATTEMPTS, in which case it's dropped. */
export async function failPrewarmRequest(db: pg.Pool, req: PrewarmRequest, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const { rows } = await db.query<{ attempts: number }>(
    `UPDATE report_prewarm_requests SET last_error = $4
     WHERE as_at = $1 AND fy_start = $2 AND fy_end = $3 RETURNING attempts`,
    [req.asAt, req.fyStart, req.fyEnd, message.slice(0, 2000)]
  );
  if ((rows[0]?.attempts ?? 0) >= MAX_PREWARM_ATTEMPTS) {
    console.error(`Pre-warm giving up on asAt=${req.asAt} (${req.fyStart}..${req.fyEnd}) after ${MAX_PREWARM_ATTEMPTS} attempts: ${message}`);
    await completePrewarmRequest(db, req);
  }
}

/** After a write cleared the report cache (Vercel): start the pre-warm workflow so the
 *  next viewer finds today warm instead of "Preparing". At most one start per COOLDOWN
 *  across every serverless instance (the report_prewarm_dispatch row), so a bulk upload's
 *  many chunk writes start one run, not dozens. The run itself warms today and yesterday
 *  first and month-ends last (dashboardPrewarm.ts). Returns whether GitHub accepted a
 *  dispatch. */
export async function dispatchAfterWrite(db: pg.Pool): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO report_prewarm_dispatch (id, last_dispatch_at) VALUES (TRUE, NOW())
     ON CONFLICT (id) DO UPDATE SET last_dispatch_at = NOW()
       WHERE report_prewarm_dispatch.last_dispatch_at < NOW() - INTERVAL '${COOLDOWN}'`
  );
  if (!rowCount) return false;
  return dispatchPrewarmWorkflow();
}

/** Marks dates as just requested, as a viewer's cold load would (requestPrewarm), but
 *  without dispatching: used once a write's run has been dispatched, for the dates that
 *  run warms first. A viewer who then finds one of them cold hits requestPrewarm's
 *  per-date cooldown instead of starting a second run. A row a worker is holding keeps
 *  its lease (last_attempt_at untouched). */
export async function markPrewarmRequested(db: pg.Pool, reqs: PrewarmRequest[]): Promise<void> {
  for (const r of reqs) {
    await db.query(
      `INSERT INTO report_prewarm_requests (as_at, fy_start, fy_end) VALUES ($1, $2, $3)
       ON CONFLICT (as_at, fy_start, fy_end) DO UPDATE SET requested_at = NOW()`,
      [r.asAt, r.fyStart, r.fyEnd]
    );
  }
}

/** POST .../actions/workflows/dashboard-prewarm.yml/dispatches. Needs
 *  GITHUB_DISPATCH_TOKEN (fine-grained PAT, this repo only, Actions: read & write) and
 *  GITHUB_DISPATCH_REPO ("owner/name"); GITHUB_DISPATCH_REF defaults to master. Missing
 *  config just logs — the request row is still served by the next scheduled run. */
export async function dispatchPrewarmWorkflow(): Promise<boolean> {
  const token = process.env.GITHUB_DISPATCH_TOKEN;
  const repo = process.env.GITHUB_DISPATCH_REPO;
  if (!token || !repo) {
    console.warn("Pre-warm dispatch skipped: GITHUB_DISPATCH_TOKEN / GITHUB_DISPATCH_REPO not set.");
    return false;
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
    return res.ok;
  } catch (err) {
    console.error("Pre-warm dispatch failed:", err);
    return false;
  }
}
