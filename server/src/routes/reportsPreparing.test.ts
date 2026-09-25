import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import reportsRoutes from "./reports.js";
import { getPool } from "../db/pool.js";
import { clearReportTotalsCacheForTests } from "../db/reportTotalsCache.js";
import { authedInject } from "../testHelpers/authTestUtils.js";
import { authGateHook } from "../auth/middleware.js";
import { monthEndDates, prewarmDashboardCaches } from "../jobs/dashboardPrewarm.js";
import {
  claimPrewarmRequest,
  completePrewarmRequest,
  failPrewarmRequest,
  MAX_PREWARM_ATTEMPTS,
  requestPrewarm
} from "../jobs/prewarmRequests.js";
import { requireFySettings } from "./reports.js";

// Option B (2026-09-24): on Vercel a cold heavy report answers 202 "preparing" and
// queues the date for the out-of-Vercel pre-warm job, instead of an inline scan that can
// only 504 there. Everywhere else (Docker/company) it keeps computing inline.
const FY = { fyStart: "2026-04-01", fyEnd: "2027-03-31" };
const HISTORICAL = "2026-04-01";

let app: FastifyInstance;

async function pending() {
  const db = await getPool();
  const { rows } = await db.query(`SELECT as_at, fy_start, fy_end FROM report_prewarm_requests ORDER BY as_at`);
  return rows;
}

beforeAll(async () => {
  const db = await getPool();
  await db.query(
    `INSERT INTO settings (id, as_at, fy_start, fy_end, days_in_fy) VALUES (TRUE, '2026-09-24', $1, $2, 365)
     ON CONFLICT (id) DO UPDATE SET as_at = EXCLUDED.as_at, fy_start = EXCLUDED.fy_start, fy_end = EXCLUDED.fy_end, days_in_fy = 365`,
    [FY.fyStart, FY.fyEnd]
  );
  app = Fastify();
  app.decorateRequest("user", null);
  app.addHook("preHandler", authGateHook);
  await app.register(cookie);
  await app.register(reportsRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  const db = await getPool();
  await clearReportTotalsCacheForTests(db);
  await db.query(`DELETE FROM report_prewarm_requests`);
  vi.stubEnv("GITHUB_DISPATCH_TOKEN", "test-token");
  vi.stubEnv("GITHUB_DISPATCH_REPO", "owner/repo");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("cold heavy reports on Vercel answer 202 preparing", () => {
  beforeEach(() => {
    vi.stubEnv("VERCEL", "1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
  });

  for (const url of [
    `/api/reports/dashboard-totals?asAt=${HISTORICAL}`,
    `/api/reports/dashboard-trend?asAt=${HISTORICAL}`,
    `/api/reports/audit-reconciliation?asAt=${HISTORICAL}&fyStart=${FY.fyStart}&fyEnd=${FY.fyEnd}`
  ]) {
    it(`${url.split("?")[0]}: 202 + the date queued + the workflow dispatched once`, async () => {
      const res = await authedInject(app, { method: "GET", url });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ status: "preparing", asAt: HISTORICAL });
      expect(await pending()).toEqual([{ as_at: HISTORICAL, fy_start: FY.fyStart, fy_end: FY.fyEnd }]);

      // A client poll 15s later: still preparing, but no second GitHub dispatch.
      expect((await authedInject(app, { method: "GET", url })).statusCode).toBe(202);
      const dispatches = vi.mocked(fetch).mock.calls.filter((c) => String(c[0]).includes("/dispatches"));
      expect(dispatches).toHaveLength(1);
      expect(String(dispatches[0]![0])).toBe(
        "https://api.github.com/repos/owner/repo/actions/workflows/dashboard-prewarm.yml/dispatches"
      );
    });
  }

  it("a filtered Dashboard view isn't pre-warmed by the job, so it still computes inline (200)", async () => {
    const res = await authedInject(app, { method: "GET", url: `/api/reports/dashboard-totals?asAt=${HISTORICAL}&center=Nowhere` });
    expect(res.statusCode).toBe(200);
    expect(await pending()).toEqual([]);
  });

  it("once the pre-warm job has run, the same request is served from the cache (200) and the queue is empty", async () => {
    const url = `/api/reports/dashboard-totals?asAt=${HISTORICAL}`;
    expect((await authedInject(app, { method: "GET", url })).statusCode).toBe(202);

    await prewarmDashboardCaches(await getPool());

    const res = await authedInject(app, { method: "GET", url });
    expect(res.statusCode).toBe(200);
    expect(res.json().computedAt).toBeTruthy();
    expect(await pending()).toEqual([]);
    // Trend and audit-reconciliation for that date came along in the same job run.
    expect((await authedInject(app, { method: "GET", url: `/api/reports/dashboard-trend?asAt=${HISTORICAL}` })).statusCode).toBe(200);
  });
});

describe("outside Vercel (Docker/company) nothing changes", () => {
  it("a cold request computes inline and returns 200, queueing nothing", async () => {
    vi.stubEnv("VERCEL", "");
    const res = await authedInject(app, { method: "GET", url: `/api/reports/dashboard-totals?asAt=${HISTORICAL}` });
    expect(res.statusCode).toBe(200);
    expect(await pending()).toEqual([]);
  });
});

describe("requestPrewarm dispatch throttling", () => {
  it("re-dispatches a still-pending date only once it's older than 10 minutes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const db = await getPool();
    const req = { asAt: HISTORICAL, ...FY };

    await requestPrewarm(db, req);
    await requestPrewarm(db, req);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await db.query(`UPDATE report_prewarm_requests SET requested_at = NOW() - INTERVAL '11 minutes'`);
    await requestPrewarm(db, req);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("missing dispatch config or a GitHub error never fails the request — the row is kept for the scheduled run", async () => {
    const db = await getPool();
    vi.stubEnv("GITHUB_DISPATCH_TOKEN", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await requestPrewarm(db, { asAt: "2026-05-01", ...FY });
    expect(fetchMock).not.toHaveBeenCalled();

    vi.stubEnv("GITHUB_DISPATCH_TOKEN", "test-token");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("bad credentials", { status: 401 })));
    await requestPrewarm(db, { asAt: "2026-06-01", ...FY });
    expect((await pending()).map((r) => r.as_at)).toEqual(["2026-05-01", "2026-06-01"]);
  });

  it("an Audit Reconciliation request for another FY warms only that report, then leaves the queue", async () => {
    const db = await getPool();
    const other = { asAt: "2025-09-30", fyStart: "2025-04-01", fyEnd: "2026-03-31" };
    await db.query(`INSERT INTO report_prewarm_requests (as_at, fy_start, fy_end) VALUES ($1, $2, $3)`, [
      other.asAt,
      other.fyStart,
      other.fyEnd
    ]);

    await prewarmDashboardCaches(db);

    expect(await pending()).toEqual([]);
    const { rows } = await db.query<{ cache_key: string }>(`SELECT cache_key FROM report_totals_cache WHERE cache_key LIKE $1`, [
      `%"asAt":"${other.asAt}"%`
    ]);
    expect(rows.map((r) => r.cache_key.split(":")[0])).toEqual(["audit-reconciliation"]);
  });
});

describe("worker lease / retry / backoff (review 2026-09-24)", () => {
  const req = { asAt: HISTORICAL, ...FY };
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  it("concurrent duplicate requests for one date insert one row and dispatch exactly once", async () => {
    const db = await getPool();
    await Promise.all(Array.from({ length: 8 }, () => requestPrewarm(db, req)));
    expect(await pending()).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a claimed row is leased: a second worker can't claim it while the first is working", async () => {
    const db = await getPool();
    await requestPrewarm(db, req);
    expect(await claimPrewarmRequest(db)).toEqual(req);
    expect(await claimPrewarmRequest(db)).toBeNull();
    // A worker that died mid-job: its lease expires after the cooldown and another can take over.
    await db.query(`UPDATE report_prewarm_requests SET last_attempt_at = NOW() - INTERVAL '11 minutes'`);
    expect(await claimPrewarmRequest(db)).toEqual(req);
  });

  it("a failed job keeps its row in backoff — client polls during the backoff do NOT re-dispatch", async () => {
    const db = await getPool();
    await requestPrewarm(db, req);
    const claimed = (await claimPrewarmRequest(db))!;
    await failPrewarmRequest(db, claimed, new Error("statement timeout"));

    const [row] = (await db.query(`SELECT attempts, last_error FROM report_prewarm_requests`)).rows;
    expect(row).toEqual({ attempts: 1, last_error: "statement timeout" });

    // 15s polls for the next few minutes: still pending, no new GitHub dispatch, not claimable.
    for (let i = 0; i < 5; i++) await requestPrewarm(db, req);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await claimPrewarmRequest(db)).toBeNull();

    // Backoff over: the next poll re-dispatches once, and a worker can retry it.
    await db.query(
      `UPDATE report_prewarm_requests SET last_attempt_at = NOW() - INTERVAL '11 minutes', requested_at = NOW() - INTERVAL '12 minutes'`
    );
    await requestPrewarm(db, req);
    await requestPrewarm(db, req); // the very next poll must not dispatch again
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await claimPrewarmRequest(db)).toEqual(req);
  });

  it(`gives up (drops the row) after ${MAX_PREWARM_ATTEMPTS} failed attempts instead of retrying forever`, async () => {
    const db = await getPool();
    await requestPrewarm(db, req);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    for (let i = 1; i <= MAX_PREWARM_ATTEMPTS; i++) {
      await db.query(`UPDATE report_prewarm_requests SET last_attempt_at = NOW() - INTERVAL '11 minutes'`);
      const claimed = (await claimPrewarmRequest(db))!;
      await failPrewarmRequest(db, claimed, new Error(`boom ${i}`));
      expect(await pending()).toHaveLength(i < MAX_PREWARM_ATTEMPTS ? 1 : 0);
    }
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/giving up/));
    err.mockRestore();
  });

  it("a success removes the row", async () => {
    const db = await getPool();
    await requestPrewarm(db, req);
    await completePrewarmRequest(db, (await claimPrewarmRequest(db))!);
    expect(await pending()).toEqual([]);
  });
});

describe("custom Days-in-FY: one canonical resolution (review 2026-09-24)", () => {
  beforeAll(async () => {
    const db = await getPool();
    await db.query(`UPDATE settings SET days_in_fy = 360`);
  });
  afterAll(async () => {
    const db = await getPool();
    await db.query(`UPDATE settings SET days_in_fy = 365`);
  });

  it("the current FY resolves to the configured 360 whether or not fyStart/fyEnd are passed explicitly; another FY uses its calendar count", async () => {
    const db = await getPool();
    expect((await requireFySettings(db))!.daysInFy).toBe(360);
    expect((await requireFySettings(db, { asAt: HISTORICAL, ...FY }))!.daysInFy).toBe(360);
    expect((await requireFySettings(db, { asAt: "2025-09-30", fyStart: "2025-04-01", fyEnd: "2026-03-31" }))!.daysInFy).toBe(365);
  });

  it("Audit Reconciliation with explicit vs. implicit current-FY dates computes with the same inputs and shares one cache row", async () => {
    vi.stubEnv("VERCEL", "");
    const db = await getPool();
    const explicit = await authedInject(app, {
      method: "GET",
      url: `/api/reports/audit-reconciliation?asAt=${HISTORICAL}&fyStart=${FY.fyStart}&fyEnd=${FY.fyEnd}`
    });
    const implicit = await authedInject(app, { method: "GET", url: `/api/reports/audit-reconciliation?asAt=${HISTORICAL}` });
    expect(explicit.statusCode).toBe(200);
    expect(implicit.json()).toEqual(explicit.json()); // the second was a cache hit on the first's row
    const { rows } = await db.query<{ cache_key: string }>(`SELECT cache_key FROM report_totals_cache WHERE cache_key LIKE 'audit-reconciliation:%'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cache_key).toContain('"daysInFy":360');
  });
});

// Asked 2026-09-25: "Refresh doesn't actually refresh". It re-served the cached row;
// nothing tied that row to the data it was computed from, so an edit that bypassed the
// app's invalidation (SQL editor, scripts) was never picked up until the TTL expired.
describe("Refresh after a data change reflects it (data signature)", () => {
  const FAR = "REFRESH-SIG-1";
  async function writeOutsideApp(sql: string, params: unknown[] = []) {
    const client = await (await getPool()).connect();
    try {
      await client.query(sql, params);
      await client.query("SELECT pg_stat_force_next_flush()"); // publish the write counters now
    } finally {
      client.release();
    }
  }
  beforeEach(async () => {
    await writeOutsideApp(`DELETE FROM assets WHERE far_id = $1`, [FAR]);
  });
  afterAll(async () => {
    await writeOutsideApp(`DELETE FROM assets WHERE far_id = $1`, [FAR]);
  });

  it("Docker/company: a Refresh after an out-of-app edit recomputes and shows the new figures", async () => {
    vi.stubEnv("VERCEL", "");
    const url = `/api/reports/dashboard-totals?asAt=2026-09-24`;
    const first = (await authedInject(app, { method: "GET", url })).json();
    const again = (await authedInject(app, { method: "GET", url })).json();
    expect(again.computedAt).toBe(first.computedAt); // nothing changed: a genuine cache hit

    await writeOutsideApp(
      `INSERT INTO assets (far_id, sub_classification, asset_description, status, date_acquired, location,
         useful_life_c1_years, useful_life_c2_years, c1_opening_cost)
       VALUES ($1, 'Refresh-Sub', 'added via SQL, no app invalidation', 'Active', '2020-01-01', 'Refresh-Center', 30, 5, 1000000)`,
      [FAR]
    );

    const refreshed = (await authedInject(app, { method: "GET", url })).json();
    expect(refreshed.computedAt).not.toBe(first.computedAt);
    expect(refreshed.totals.grossBlock).toBeCloseTo(first.totals.grossBlock + 1000000, 2);
  });

  it("Vercel: the same stale row is not replayed; the request goes to the preparing flow", async () => {
    vi.stubEnv("VERCEL", "");
    const url = `/api/reports/dashboard-totals?asAt=2026-09-24`;
    await authedInject(app, { method: "GET", url }); // cached
    await writeOutsideApp(
      `INSERT INTO assets (far_id, sub_classification, asset_description, status, date_acquired, location, useful_life_c1_years, useful_life_c2_years)
       VALUES ($1, 'Refresh-Sub', 'x', 'Active', '2020-01-01', 'Refresh-Center', 5, 5)`,
      [FAR]
    );
    vi.stubEnv("VERCEL", "1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    const res = await authedInject(app, { method: "GET", url });
    expect(res.statusCode).toBe(202);
  });
});

describe("month-end pre-warming", () => {
  const FY_ = { fyStart: "2026-04-01", fyEnd: "2027-03-31" };

  it("monthEndDates: the current FY's completed month-ends, most recent first", () => {
    expect(monthEndDates(new Date("2026-09-25T06:00:00Z"), FY_)).toEqual([
      "2026-08-31",
      "2026-07-31",
      "2026-06-30",
      "2026-05-31",
      "2026-04-30"
    ]);
    // 30 Sept itself isn't "completed" until 1 Oct (IST), and nothing before FY start.
    expect(monthEndDates(new Date("2026-09-30T06:00:00Z"), FY_)[0]).toBe("2026-08-31");
    expect(monthEndDates(new Date("2026-09-30T19:00:00Z"), FY_)[0]).toBe("2026-09-30"); // already 1 Oct in IST
    expect(monthEndDates(new Date("2026-04-15T06:00:00Z"), FY_)).toEqual([]);
    expect(monthEndDates(new Date("2027-06-01T06:00:00Z"), FY_)).toHaveLength(12); // FY over: all 12, capped at FY end
  });

  async function rowsFor(asAt: string) {
    const { rows } = await (await getPool()).query<{ cache_key: string; hours: string; computed_at: Date }>(
      `SELECT cache_key, ROUND(EXTRACT(EPOCH FROM expires_at - computed_at) / 3600) AS hours, computed_at
       FROM report_totals_cache WHERE cache_key LIKE $1 ORDER BY cache_key`,
      [`%"asAt":"${asAt}"%`]
    );
    return rows;
  }

  it("warms all three reports for a month-end with the 7-day lifetime, and a second run recomputes nothing (only stale dates)", async () => {
    const db = await getPool();
    const now = new Date("2026-06-10T06:00:00Z"); // month-ends: 2026-05-31, 2026-04-30
    await prewarmDashboardCaches(db, { now });

    const may = await rowsFor("2026-05-31");
    expect(may.map((r) => r.cache_key.split(":")[0]).sort()).toEqual(["audit-reconciliation", "dashboard-totals", "dashboard-trend"]);
    expect(may.every((r) => Number(r.hours) === 168)).toBe(true);

    await prewarmDashboardCaches(db, { now });
    const mayAgain = await rowsFor("2026-05-31");
    expect(mayAgain.map((r) => r.computed_at.getTime())).toEqual(may.map((r) => r.computed_at.getTime()));
  });

  it("respects the time budget: with none left, no month-end is started (today's dates still are)", async () => {
    const db = await getPool();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await prewarmDashboardCaches(db, { now: new Date("2026-06-10T06:00:00Z"), monthEndBudgetMs: 0 });
    expect(await rowsFor("2026-05-31")).toEqual([]);
    expect((await rowsFor("2026-06-10")).length).toBe(3);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/month-end budget used up/));
    log.mockRestore();
  });

  it("a date a user is waiting on is warmed before any month-end", async () => {
    const db = await getPool();
    await db.query(`INSERT INTO report_prewarm_requests (as_at, fy_start, fy_end) VALUES ('2026-05-15', $1, $2)`, [FY_.fyStart, FY_.fyEnd]);
    await prewarmDashboardCaches(db, { now: new Date("2026-06-10T06:00:00Z") });
    const requested = Math.max(...(await rowsFor("2026-05-15")).map((r) => r.computed_at.getTime()));
    const firstMonthEnd = Math.min(...(await rowsFor("2026-05-31")).map((r) => r.computed_at.getTime()));
    expect(requested).toBeLessThanOrEqual(firstMonthEnd);
    expect(await pending()).toEqual([]);
  });
});
