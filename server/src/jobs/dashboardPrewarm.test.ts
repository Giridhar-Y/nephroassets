import { describe, expect, it } from "vitest";
import { prewarmDates } from "./dashboardPrewarm.js";

const FY = { fyStart: "2026-04-01", fyEnd: "2027-03-31" };

describe("prewarmDates", () => {
  it("warms users' IST today first even when the stored AS_AT is still yesterday (2026-09-24 incident)", () => {
    // 04:01Z on the 24th = 09:31 IST, before anyone had opened the app that day.
    expect(prewarmDates(new Date("2026-09-24T04:01:00Z"), { ...FY, asAt: "2026-09-23" })).toEqual(["2026-09-24", "2026-09-23"]);
  });

  it("rolls over at IST midnight, not UTC midnight", () => {
    // 18:36Z on the 23rd is already 00:06 IST on the 24th.
    expect(prewarmDates(new Date("2026-09-23T18:36:00Z"), { ...FY, asAt: "2026-09-23" })[0]).toBe("2026-09-24");
  });

  it("also keeps a user-picked AS_AT warm, and clamps today into the FY", () => {
    expect(prewarmDates(new Date("2026-09-24T06:00:00Z"), { ...FY, asAt: "2026-06-30" })).toEqual([
      "2026-09-24",
      "2026-06-30",
      "2026-09-23"
    ]);
    expect(prewarmDates(new Date("2027-05-01T06:00:00Z"), { ...FY, asAt: "2027-03-31" })).toEqual(["2027-03-31", "2027-03-30"]);
    expect(prewarmDates(new Date("2026-04-01T06:00:00Z"), { ...FY, asAt: "2026-04-01" })).toEqual(["2026-04-01"]);
  });
});

describe("prewarmDashboardCaches (against the test database)", () => {
  it("warms totals, trend AND audit-reconciliation for users' today, inside the no-statement-timeout transaction", async () => {
    const { getTestPool } = await import("../db/testClient.js");
    const { prewarmDashboardCaches } = await import("./dashboardPrewarm.js");
    const cache = await import("../db/reportTotalsCache.js");
    const db = await getTestPool();
    // Stored AS_AT deliberately left on an old date — the job must not anchor on it.
    await db.query(
      `INSERT INTO settings (id, as_at, fy_start, fy_end, days_in_fy) VALUES (TRUE, '2026-08-17', '2026-04-01', '2027-03-31', 365)
       ON CONFLICT (id) DO UPDATE SET as_at = EXCLUDED.as_at, fy_start = EXCLUDED.fy_start, fy_end = EXCLUDED.fy_end, days_in_fy = EXCLUDED.days_in_fy`
    );
    await cache.clearReportTotalsCacheForTests(db);

    await prewarmDashboardCaches(db);

    const fy = { asAt: "2026-08-17", fyStart: "2026-04-01", fyEnd: "2027-03-31" };
    const today = prewarmDates(new Date(), fy)[0]!;
    for (const key of [
      cache.dashboardTotalsCacheKey({ asAt: today, centerScope: null }),
      cache.dashboardTrendCacheKey({ asAt: today, centerScope: null }),
      cache.auditReconciliationCacheKey({ asAt: today, fyStart: fy.fyStart, fyEnd: fy.fyEnd, daysInFy: 365, centerScope: null }),
      cache.dashboardTotalsCacheKey({ asAt: "2026-08-17", centerScope: null })
    ]) {
      expect(await cache.getCachedReportTotals(db, key), key).toBeDefined();
    }
  });
});
