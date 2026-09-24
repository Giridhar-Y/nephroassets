import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import reportsRoutes from "./reports.js";
import { getPool } from "../db/pool.js";
import { clearReportTotalsCacheForTests } from "../db/reportTotalsCache.js";
import { authedInject } from "../testHelpers/authTestUtils.js";
import { authGateHook } from "../auth/middleware.js";
import { prewarmDashboardCaches } from "../jobs/dashboardPrewarm.js";
import { requestPrewarm } from "../jobs/prewarmRequests.js";

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
