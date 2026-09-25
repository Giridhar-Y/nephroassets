import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTestPool } from "./testClient.js";
import {
  auditReconciliationCacheKey,
  clearReportTotalsCacheForTests,
  dashboardTotalsCacheKey,
  dashboardTrendCacheKey,
  getCachedReportTotals,
  getReportDataVersion,
  invalidateReportTotalsCache,
  MONTH_END_TTL,
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
    const recon = auditReconciliationCacheKey({ asAt: "2026-09-11", fyStart: "2026-04-01", fyEnd: "2027-03-31", daysInFy: 365, centerScope: null });
    const totals = dashboardTotalsCacheKey({ asAt: "2026-09-11", centerScope: null });
    const trend = dashboardTrendCacheKey({ asAt: "2026-09-11", centerScope: null });
    expect(recon).not.toBe(totals);
    expect(recon).not.toBe(trend);
  });

  it("differs by the resolved daysInFy — a configured 360 and a calendar 365 for the same dates never share a row", () => {
    const configured = auditReconciliationCacheKey({ asAt: "2026-09-11", fyStart: "2026-04-01", fyEnd: "2027-03-31", daysInFy: 360, centerScope: null });
    const calendar = auditReconciliationCacheKey({ asAt: "2026-09-11", fyStart: "2026-04-01", fyEnd: "2027-03-31", daysInFy: 365, centerScope: null });
    expect(configured).not.toBe(calendar);
  });

  it("differs by a fyStart/fyEnd period override, not just asAt", () => {
    const base = auditReconciliationCacheKey({ asAt: "2026-09-11", fyStart: "2026-04-01", fyEnd: "2027-03-31", daysInFy: 365, centerScope: null });
    const otherPeriod = auditReconciliationCacheKey({ asAt: "2026-09-11", fyStart: "2025-04-01", fyEnd: "2026-03-31", daysInFy: 365, centerScope: null });
    expect(base).not.toBe(otherPeriod);
  });

  it("is stable regardless of centerScope array order, same as the other two key builders", () => {
    const a = auditReconciliationCacheKey({ asAt: "2026-09-11", fyStart: "2026-04-01", fyEnd: "2027-03-31", daysInFy: 365, centerScope: new Set(["A", "B"]) });
    const b = auditReconciliationCacheKey({ asAt: "2026-09-11", fyStart: "2026-04-01", fyEnd: "2027-03-31", daysInFy: 365, centerScope: new Set(["B", "A"]) });
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

    const setAt = await setCachedReportTotals(db, key, { totals: { grossBlock: 12345 } }, await getReportDataVersion(db));

    const cached = await getCachedReportTotals<{ totals: { grossBlock: number } }>(db, key);
    expect(cached?.totals.grossBlock).toBe(12345);
    // computedAt is the row's own timestamp, identical on the set and every later hit.
    expect(new Date(cached!.computedAt).getTime()).toBe(new Date(setAt!).getTime());
    expect(cached!.computedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("a re-set of the same key overwrites the payload and refreshes computed_at (upsert, not a duplicate row)", async () => {
    const key = dashboardTotalsCacheKey({ asAt: "2026-09-11", centerScope: null });
    await setCachedReportTotals(db, key, { v: 1 }, await getReportDataVersion(db));
    await setCachedReportTotals(db, key, { v: 2 }, await getReportDataVersion(db));

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
    const { signature } = await getReportDataVersion(db);
    await db.query(
      `INSERT INTO report_totals_cache (cache_key, payload, computed_at, data_signature) VALUES ($1, $2, NOW() - INTERVAL '5 hours 59 minutes', $3)`,
      [key, JSON.stringify({ fresh: true }), signature]
    );
    expect(await getCachedReportTotals(db, key)).toMatchObject({ fresh: true });
  });

  it("invalidateReportTotalsCache clears every key, not just one", async () => {
    const keyA = dashboardTotalsCacheKey({ asAt: "2026-09-11", center: "Center-A", centerScope: null });
    const keyB = dashboardTotalsCacheKey({ asAt: "2026-09-11", center: "Center-B", centerScope: null });
    await setCachedReportTotals(db, keyA, { a: true }, await getReportDataVersion(db));
    await setCachedReportTotals(db, keyB, { b: true }, await getReportDataVersion(db));

    await invalidateReportTotalsCache(db);

    expect(await getCachedReportTotals(db, keyA)).toBeUndefined();
    expect(await getCachedReportTotals(db, keyB)).toBeUndefined();
  });

  it("invalidateReportTotalsCache clears dashboard-totals, dashboard-trend, and audit-reconciliation keys alike — one shared table, one blanket clear", async () => {
    const totalsKey = dashboardTotalsCacheKey({ asAt: "2026-09-11", centerScope: null });
    const trendKey = dashboardTrendCacheKey({ asAt: "2026-09-11", centerScope: null });
    const reconKey = auditReconciliationCacheKey({ asAt: "2026-09-11", fyStart: "2026-04-01", fyEnd: "2027-03-31", daysInFy: 365, centerScope: null });
    await setCachedReportTotals(db, totalsKey, { totals: true }, await getReportDataVersion(db));
    await setCachedReportTotals(db, trendKey, { trend: true }, await getReportDataVersion(db));
    await setCachedReportTotals(db, reconKey, { recon: true }, await getReportDataVersion(db));

    await invalidateReportTotalsCache(db);

    expect(await getCachedReportTotals(db, totalsKey)).toBeUndefined();
    expect(await getCachedReportTotals(db, trendKey)).toBeUndefined();
    expect(await getCachedReportTotals(db, reconKey)).toBeUndefined();
  });

  it("a computation that started before an invalidation is NOT published (mutation during calculation)", async () => {
    const key = dashboardTotalsCacheKey({ asAt: "2026-09-11", centerScope: null });
    const revisionAtStart = await getReportDataVersion(db); // worker starts computing…
    await invalidateReportTotalsCache(db); // …a write lands and invalidates meanwhile…

    expect(await setCachedReportTotals(db, key, { stale: true }, revisionAtStart)).toBeNull(); // …its late publish is refused
    expect(await getCachedReportTotals(db, key)).toBeUndefined();

    // A fresh computation against the new revision publishes normally.
    expect(await setCachedReportTotals(db, key, { fresh: true }, await getReportDataVersion(db))).not.toBeNull();
    expect(await getCachedReportTotals(db, key)).toMatchObject({ fresh: true });
  });

  it("an invalidation racing a publish can't leave the stale row behind (FOR SHARE serializes them)", async () => {
    const key = dashboardTotalsCacheKey({ asAt: "2026-09-11", centerScope: null });
    for (let i = 0; i < 20; i++) {
      await clearReportTotalsCacheForTests(db);
      const rev = await getReportDataVersion(db);
      const [published] = await Promise.all([setCachedReportTotals(db, key, { i }, rev), invalidateReportTotalsCache(db)]);
      // Whichever order they ran in, the end state must never be "published AND still
      // cached after the invalidation finished".
      const cached = await getCachedReportTotals(db, key);
      if (cached) expect(published).not.toBeNull();
      expect(cached).toBeUndefined();
    }
  });

  it("invalidation failures are logged loudly and reported, never thrown or silently swallowed", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { connect: async () => { throw new Error("db down"); } } as unknown as typeof db;
    await expect(invalidateReportTotalsCache(broken)).resolves.toBe(false);
    expect(err.mock.calls[0]![0]).toMatch(/INVALIDATION FAILED/);
    err.mockRestore();
  });

  // A write that never goes through the app (Supabase SQL editor, a script) never calls
  // invalidateReportTotalsCache. The data signature must still make the cached row a
  // miss, or Refresh would keep replaying the pre-edit figures until the TTL.
  it("a data change made OUTSIDE the app turns a cached row into a miss; no change keeps it a hit", async () => {
    const key = dashboardTotalsCacheKey({ asAt: "2026-09-11", centerScope: null });
    await setCachedReportTotals(db, key, { before: true }, await getReportDataVersion(db));
    expect(await getCachedReportTotals(db, key)).toMatchObject({ before: true });
    expect(await getCachedReportTotals(db, key)).toMatchObject({ before: true }); // stable while nothing changes

    const client = await db.connect();
    try {
      await client.query(
        `INSERT INTO assets (far_id, sub_classification, asset_description, status, date_acquired, location, useful_life_c1_years, useful_life_c2_years)
         VALUES ('SIG-OUTSIDE-1', 'Sig-Sub', 'written straight to the DB', 'Active', '2020-01-01', 'Sig-Center', 5, 5)`
      );
      // Postgres publishes a session's write counters when it goes idle (at most every
      // ~10s otherwise); force it so the test doesn't depend on that timing.
      await client.query("SELECT pg_stat_force_next_flush()");
    } finally {
      client.release();
    }
    try {
      expect(await getCachedReportTotals(db, key)).toBeUndefined();
    } finally {
      await db.query(`DELETE FROM assets WHERE far_id = 'SIG-OUTSIDE-1'`);
    }
  });

  it("publishes store the per-row lifetime: 6 hours by default, 7 days for month-ends", async () => {
    const version = await getReportDataVersion(db);
    await setCachedReportTotals(db, "ttl:default", {}, version);
    await setCachedReportTotals(db, "ttl:month-end", {}, version, MONTH_END_TTL);
    const { rows } = await db.query<{ cache_key: string; hours: string }>(
      `SELECT cache_key, ROUND(EXTRACT(EPOCH FROM expires_at - computed_at) / 3600) AS hours FROM report_totals_cache ORDER BY cache_key`
    );
    expect(rows.map((r) => [r.cache_key, Number(r.hours)])).toEqual([
      ["ttl:default", 6],
      ["ttl:month-end", 168]
    ]);
  });
});
