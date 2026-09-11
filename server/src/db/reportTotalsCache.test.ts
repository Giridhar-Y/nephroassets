import { beforeEach, describe, expect, it } from "vitest";
import { getTestPool } from "./testClient.js";
import {
  clearReportTotalsCacheForTests,
  dashboardTotalsCacheKey,
  getCachedDashboardTotals,
  invalidateDashboardTotalsCache,
  setCachedDashboardTotals
} from "./reportTotalsCache.js";

describe("dashboardTotalsCacheKey", () => {
  it("is stable regardless of centerScope array order", () => {
    const a = dashboardTotalsCacheKey({ asAt: "2026-09-11", centerScope: new Set(["A", "B"]) });
    const b = dashboardTotalsCacheKey({ asAt: "2026-09-11", centerScope: new Set(["B", "A"]) });
    expect(a).toBe(b);
  });

  it("distinguishes null (unscoped) centerScope from an empty scoped set — different real meanings", () => {
    const unscoped = dashboardTotalsCacheKey({ asAt: "2026-09-11", centerScope: null });
    const emptyScope = dashboardTotalsCacheKey({ asAt: "2026-09-11", centerScope: new Set() });
    expect(unscoped).not.toBe(emptyScope);
  });

  it("differs by asAt, center, and subClassification independently", () => {
    const base = dashboardTotalsCacheKey({ asAt: "2026-09-11", centerScope: null });
    expect(dashboardTotalsCacheKey({ asAt: "2026-09-12", centerScope: null })).not.toBe(base);
    expect(dashboardTotalsCacheKey({ asAt: "2026-09-11", center: "Center-A", centerScope: null })).not.toBe(base);
    expect(
      dashboardTotalsCacheKey({ asAt: "2026-09-11", subClassification: "Machines", centerScope: null })
    ).not.toBe(base);
  });

  it("scopes two different users' access separately, so one can never read another's cached scoped total", () => {
    const userA = dashboardTotalsCacheKey({ asAt: "2026-09-11", centerScope: new Set(["Center-A"]) });
    const userB = dashboardTotalsCacheKey({ asAt: "2026-09-11", centerScope: new Set(["Center-B"]) });
    expect(userA).not.toBe(userB);
  });
});

describe("report_totals_cache: get/set/TTL/invalidate", () => {
  const db = getTestPool();

  beforeEach(async () => {
    await clearReportTotalsCacheForTests(db);
  });

  it("returns undefined on a miss, then the stored payload after a set", async () => {
    const key = dashboardTotalsCacheKey({ asAt: "2026-09-11", centerScope: null });
    expect(await getCachedDashboardTotals(db, key)).toBeUndefined();

    await setCachedDashboardTotals(db, key, { totals: { grossBlock: 12345 } });

    const cached = await getCachedDashboardTotals<{ totals: { grossBlock: number } }>(db, key);
    expect(cached?.totals.grossBlock).toBe(12345);
  });

  it("a re-set of the same key overwrites the payload and refreshes computed_at (upsert, not a duplicate row)", async () => {
    const key = dashboardTotalsCacheKey({ asAt: "2026-09-11", centerScope: null });
    await setCachedDashboardTotals(db, key, { v: 1 });
    await setCachedDashboardTotals(db, key, { v: 2 });

    const { rows } = await db.query(`SELECT COUNT(*) AS count FROM report_totals_cache WHERE cache_key = $1`, [key]);
    expect(Number(rows[0].count)).toBe(1);
    expect(await getCachedDashboardTotals<{ v: number }>(db, key)).toEqual({ v: 2 });
  });

  it("a row older than the 15-minute TTL is treated as a miss, not served stale", async () => {
    const key = dashboardTotalsCacheKey({ asAt: "2026-09-11", centerScope: null });
    await db.query(
      `INSERT INTO report_totals_cache (cache_key, payload, computed_at) VALUES ($1, $2, NOW() - INTERVAL '16 minutes')`,
      [key, JSON.stringify({ stale: true })]
    );
    expect(await getCachedDashboardTotals(db, key)).toBeUndefined();
  });

  it("a row just inside the 15-minute TTL is still served", async () => {
    const key = dashboardTotalsCacheKey({ asAt: "2026-09-11", centerScope: null });
    await db.query(
      `INSERT INTO report_totals_cache (cache_key, payload, computed_at) VALUES ($1, $2, NOW() - INTERVAL '14 minutes')`,
      [key, JSON.stringify({ fresh: true })]
    );
    expect(await getCachedDashboardTotals(db, key)).toEqual({ fresh: true });
  });

  it("invalidateDashboardTotalsCache clears every key, not just one", async () => {
    const keyA = dashboardTotalsCacheKey({ asAt: "2026-09-11", center: "Center-A", centerScope: null });
    const keyB = dashboardTotalsCacheKey({ asAt: "2026-09-11", center: "Center-B", centerScope: null });
    await setCachedDashboardTotals(db, keyA, { a: true });
    await setCachedDashboardTotals(db, keyB, { b: true });

    await invalidateDashboardTotalsCache(db);

    expect(await getCachedDashboardTotals(db, keyA)).toBeUndefined();
    expect(await getCachedDashboardTotals(db, keyB)).toBeUndefined();
  });
});
