import { beforeEach, describe, expect, it } from "vitest";
import { getTestPool } from "./testClient.js";
import {
  auditReconciliationCacheKey,
  clearReportTotalsCacheForTests,
  dashboardTotalsCacheKey,
  dashboardTrendCacheKey,
  getCachedReportTotals,
  invalidateReportTotalsCache,
  setCachedReportTotals
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

describe("dashboardTrendCacheKey", () => {
  it("never collides with a dashboardTotalsCacheKey for the same parameters — same shared table", () => {
    const trend = dashboardTrendCacheKey({ asAt: "2026-09-11", centerScope: null });
    const totals = dashboardTotalsCacheKey({ asAt: "2026-09-11", centerScope: null });
    expect(trend).not.toBe(totals);
  });

  it("is stable regardless of centerScope array order, same as dashboardTotalsCacheKey", () => {
    const a = dashboardTrendCacheKey({ asAt: "2026-09-11", centerScope: new Set(["A", "B"]) });
    const b = dashboardTrendCacheKey({ asAt: "2026-09-11", centerScope: new Set(["B", "A"]) });
    expect(a).toBe(b);
  });
});

describe("auditReconciliationCacheKey", () => {
  it("never collides with dashboardTotalsCacheKey/dashboardTrendCacheKey for the same asAt", () => {
    const recon = auditReconciliationCacheKey({ asAt: "2026-09-11", fyStart: "2026-04-01", fyEnd: "2027-03-31", centerScope: null });
    const totals = dashboardTotalsCacheKey({ asAt: "2026-09-11", centerScope: null });
    const trend = dashboardTrendCacheKey({ asAt: "2026-09-11", centerScope: null });
    expect(recon).not.toBe(totals);
    expect(recon).not.toBe(trend);
  });

  it("differs by a fyStart/fyEnd period override, not just asAt", () => {
    const base = auditReconciliationCacheKey({ asAt: "2026-09-11", fyStart: "2026-04-01", fyEnd: "2027-03-31", centerScope: null });
    const otherPeriod = auditReconciliationCacheKey({ asAt: "2026-09-11", fyStart: "2025-04-01", fyEnd: "2026-03-31", centerScope: null });
    expect(base).not.toBe(otherPeriod);
  });

  it("is stable regardless of centerScope array order, same as the other two key builders", () => {
    const a = auditReconciliationCacheKey({ asAt: "2026-09-11", fyStart: "2026-04-01", fyEnd: "2027-03-31", centerScope: new Set(["A", "B"]) });
    const b = auditReconciliationCacheKey({ asAt: "2026-09-11", fyStart: "2026-04-01", fyEnd: "2027-03-31", centerScope: new Set(["B", "A"]) });
    expect(a).toBe(b);
  });
});

describe("report_totals_cache: get/set/TTL/invalidate", () => {
  const db = getTestPool();

  beforeEach(async () => {
    await clearReportTotalsCacheForTests(db);
  });

  it("returns undefined on a miss, then the stored payload after a set", async () => {
    const key = dashboardTotalsCacheKey({ asAt: "2026-09-11", centerScope: null });
    expect(await getCachedReportTotals(db, key)).toBeUndefined();

    const setAt = await setCachedReportTotals(db, key, { totals: { grossBlock: 12345 } });

    const cached = await getCachedReportTotals<{ totals: { grossBlock: number } }>(db, key);
    expect(cached?.totals.grossBlock).toBe(12345);
    // computedAt is the row's own timestamp, identical on the set and every later hit.
    expect(new Date(cached!.computedAt).getTime()).toBe(new Date(setAt).getTime());
    expect(cached!.computedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("a re-set of the same key overwrites the payload and refreshes computed_at (upsert, not a duplicate row)", async () => {
    const key = dashboardTotalsCacheKey({ asAt: "2026-09-11", centerScope: null });
    await setCachedReportTotals(db, key, { v: 1 });
    await setCachedReportTotals(db, key, { v: 2 });

    const { rows } = await db.query(`SELECT COUNT(*) AS count FROM report_totals_cache WHERE cache_key = $1`, [key]);
    expect(Number(rows[0].count)).toBe(1);
    expect(await getCachedReportTotals<{ v: number }>(db, key)).toMatchObject({ v: 2 });
  });

  it("a row older than the 6-hour TTL is treated as a miss, not served stale", async () => {
    const key = dashboardTotalsCacheKey({ asAt: "2026-09-11", centerScope: null });
    await db.query(
      `INSERT INTO report_totals_cache (cache_key, payload, computed_at) VALUES ($1, $2, NOW() - INTERVAL '6 hours 1 minute')`,
      [key, JSON.stringify({ stale: true })]
    );
    expect(await getCachedReportTotals(db, key)).toBeUndefined();
  });

  it("a row just inside the 6-hour TTL is still served", async () => {
    const key = dashboardTotalsCacheKey({ asAt: "2026-09-11", centerScope: null });
    await db.query(
      `INSERT INTO report_totals_cache (cache_key, payload, computed_at) VALUES ($1, $2, NOW() - INTERVAL '5 hours 59 minutes')`,
      [key, JSON.stringify({ fresh: true })]
    );
    expect(await getCachedReportTotals(db, key)).toMatchObject({ fresh: true });
  });

  it("invalidateReportTotalsCache clears every key, not just one", async () => {
    const keyA = dashboardTotalsCacheKey({ asAt: "2026-09-11", center: "Center-A", centerScope: null });
    const keyB = dashboardTotalsCacheKey({ asAt: "2026-09-11", center: "Center-B", centerScope: null });
    await setCachedReportTotals(db, keyA, { a: true });
    await setCachedReportTotals(db, keyB, { b: true });

    await invalidateReportTotalsCache(db);

    expect(await getCachedReportTotals(db, keyA)).toBeUndefined();
    expect(await getCachedReportTotals(db, keyB)).toBeUndefined();
  });

  it("invalidateReportTotalsCache clears dashboard-totals, dashboard-trend, and audit-reconciliation keys alike — one shared table, one blanket clear", async () => {
    const totalsKey = dashboardTotalsCacheKey({ asAt: "2026-09-11", centerScope: null });
    const trendKey = dashboardTrendCacheKey({ asAt: "2026-09-11", centerScope: null });
    const reconKey = auditReconciliationCacheKey({ asAt: "2026-09-11", fyStart: "2026-04-01", fyEnd: "2027-03-31", centerScope: null });
    await setCachedReportTotals(db, totalsKey, { totals: true });
    await setCachedReportTotals(db, trendKey, { trend: true });
    await setCachedReportTotals(db, reconKey, { recon: true });

    await invalidateReportTotalsCache(db);

    expect(await getCachedReportTotals(db, totalsKey)).toBeUndefined();
    expect(await getCachedReportTotals(db, trendKey)).toBeUndefined();
    expect(await getCachedReportTotals(db, reconKey)).toBeUndefined();
  });
});
