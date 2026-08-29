import Fastify, { type FastifyInstance } from "fastify";
import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import reportsRoutes from "./reports.js";
import { getPool } from "../db/pool.js";
import { authedInject } from "../testHelpers/authTestUtils.js";

const AS_AT = "2026-08-17";
const FY_START = "2026-04-01";
const FY_END = "2027-03-31";
const DAYS_IN_FY = 365;

const BASE_ASSET = {
  status: "Active",
  date_acquired: "2020-01-01",
  location: "Center-Test",
  revised_location: null,
  last_date_of_transaction: null,
  date_of_addition: null,
  sale_value: 0,
  useful_life_c2_years: 5,
  c2_opening_cost: 0,
  additions_c2: 0,
  deletions_c2: 0,
  acc_dep_c2_opening: 0
};

async function insertAsset(overrides: Record<string, unknown>) {
  const db = await getPool();
  const row = { ...BASE_ASSET, ...overrides };
  const columns = Object.keys(row);
  const values = Object.values(row);
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
  await db.query(
    `INSERT INTO assets (${columns.join(", ")}) VALUES (${placeholders})`,
    values
  );
}

// Proves the Audit Reconciliation pass/fail check is real: a deliberately broken
// fixture (a Deletions amount recorded with no Disposal Date; an Opening Acc Dep that
// exceeds cost) must fail, and an equivalent clean fixture must pass. This is the
// specific proof required before Phase 3 can be called done.
describe("Audit Reconciliation report", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const db = await getPool();
    await db.query(
      `INSERT INTO settings (id, as_at, fy_start, fy_end, days_in_fy) VALUES (TRUE, $1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET as_at = $1, fy_start = $2, fy_end = $3, days_in_fy = $4`,
      [AS_AT, FY_START, FY_END, DAYS_IN_FY]
    );

    // Clean: an addition with no disposal, and a full disposal whose Deletions amount
    // is properly matched by a Disposal Date on or before AS_AT.
    await insertAsset({
      far_id: "RECON-CLEAN-1",
      sub_classification: "Test-Clean",
      asset_description: "Clean fixture 1",
      serial_no: "S1",
      qty: 1,
      useful_life_c1_years: 10,
      c1_opening_cost: 100000,
      additions_c1: 20000,
      date_of_addition: "2026-05-01",
      date_of_disposal: null,
      deletions_c1: 0,
      acc_dep_c1_opening: 20000
    });
    await insertAsset({
      far_id: "RECON-CLEAN-2",
      sub_classification: "Test-Clean",
      asset_description: "Clean fixture 2",
      serial_no: "S2",
      qty: 1,
      // useful_life_c1_years chosen so end-of-life (dateAcquired + usefulLife) falls
      // safely after fyEnd — keeps this disposal in the flat-rate branch, not the
      // end-of-life taper, so it's genuinely clean under the 2026-08-27 reversion (see
      // RECON-POST-EXPIRY-DISPOSAL below for the case where it isn't).
      useful_life_c1_years: 10,
      c1_opening_cost: 50000,
      additions_c1: 0,
      date_of_disposal: "2026-06-01",
      deletions_c1: 50000,
      acc_dep_c1_opening: 10000,
      sale_value: 5000
    });

    // Broken: Deletions recorded but no Disposal Date (orphaned — breaks the cost
    // check only), and an Opening Acc Dep that exceeds cost (breaks the Acc Dep check
    // only, via Closing Acc Dep's cap at Gross Block).
    await insertAsset({
      far_id: "RECON-BROKEN-1",
      sub_classification: "Test-Broken",
      asset_description: "Broken fixture 1 (orphaned deletion)",
      serial_no: "S3",
      qty: 1,
      useful_life_c1_years: 10,
      c1_opening_cost: 100000,
      additions_c1: 0,
      date_of_disposal: null,
      deletions_c1: 30000,
      acc_dep_c1_opening: 20000
    });
    await insertAsset({
      far_id: "RECON-BROKEN-2",
      sub_classification: "Test-Broken",
      asset_description: "Broken fixture 2 (over-depreciated opening balance)",
      serial_no: "S4",
      qty: 1,
      useful_life_c1_years: 10,
      c1_opening_cost: 100000,
      additions_c1: 0,
      date_of_disposal: null,
      deletions_c1: 0,
      acc_dep_c1_opening: 150000
    });

    // Regression fixture: a disposal legitimately scheduled *after* AS_AT. Deletions is
    // populated and a valid Disposal Date exists — this must NOT be flagged, since the
    // disposal simply hasn't taken effect for this AS_AT yet. An earlier version of this
    // report summed Deletions unconditionally and incorrectly failed every asset like
    // this one (found by clicking through the real app at an earlier AS_AT).
    await insertAsset({
      far_id: "RECON-FUTURE-DISPOSAL",
      sub_classification: "Test-Future-Disposal",
      asset_description: "Disposal scheduled after AS_AT",
      serial_no: "S5",
      qty: 1,
      useful_life_c1_years: 10,
      c1_opening_cost: 100000,
      additions_c1: 0,
      date_of_disposal: "2027-01-01",
      deletions_c1: 40000,
      acc_dep_c1_opening: 20000
    });

    // Regression fixture: an asset disposed after its useful life had already expired
    // (dateAcquired + usefulLife = 2024-12-30, well before this FY's fyStart). Step 8
    // (accDepOnDisposed) was reverted 2026-08-27 to a flat-rate form fully independent of
    // step 5's end-of-life taper, per the FAR FY 2026-27 Excel workbook's AB/AC formula
    // (confirmed cell-by-cell) — this deliberately reopens the dep-check gap for exactly
    // this combination. Cost side is unaffected and still reconciles. Confirmed explicitly
    // by finance as an accepted consequence, since the Excel file itself has this same
    // gap — see engine.test.ts's "(f) disposed after useful life had already expired" for
    // the underlying component-level numbers this fixture matches.
    await insertAsset({
      far_id: "RECON-POST-EXPIRY-DISPOSAL",
      sub_classification: "Test-Post-Expiry-Disposal",
      asset_description: "Disposed after useful life had already expired",
      serial_no: "S6",
      qty: 1,
      useful_life_c1_years: 5,
      c1_opening_cost: 50000,
      additions_c1: 0,
      date_of_disposal: "2026-06-01",
      deletions_c1: 50000,
      acc_dep_c1_opening: 10000,
      sale_value: 5000
    });

    app = Fastify();
    await app.register(reportsRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("reconciles a different financial year entirely when fyStart/fyEnd are supplied, not just a different date in the current one", async () => {
    // Default (no override): RECON-CLEAN-1's addition (dated 2026-05-01) is inside the
    // current FY (2026-04-01 to 2027-03-31), so it counts as an Addition.
    const current = await authedInject(app, { method: "GET", url: "/api/reports/audit-reconciliation" });
    const currentClean = current.json().items.find(
      (i: { subClassification: string; component: string }) => i.subClassification === "Test-Clean" && i.component === "C1"
    );
    expect(currentClean.additionsSum).toBe(20000);
    // Opening sums RECON-CLEAN-1's 100000 and RECON-CLEAN-2's 50000 — both capitalized
    // 2020-01-01, well before either FY, so both count as Opening regardless of period.
    expect(currentClean.openingSum).toBe(150000);

    // A prior FY (2025-04-01 to 2026-03-31): the same addition hasn't happened yet as of
    // that period's own AS_AT, so it must NOT count — additionsSum drops to 0. Opening
    // is unaffected (capitalized 2020-01-01, well before either FY).
    const prior = await authedInject(app, {
      method: "GET",
      url: "/api/reports/audit-reconciliation?fyStart=2025-04-01&fyEnd=2026-03-31&asAt=2026-03-31"
    });
    expect(prior.statusCode).toBe(200);
    expect(prior.json().fyStart).toBe("2025-04-01");
    const priorClean = prior.json().items.find(
      (i: { subClassification: string; component: string }) => i.subClassification === "Test-Clean" && i.component === "C1"
    );
    expect(priorClean.additionsSum).toBe(0);
    expect(priorClean.openingSum).toBe(150000);
  });

  it("passes both checks for a clean sub classification", async () => {
    const res = await authedInject(app, { method: "GET", url: "/api/reports/audit-reconciliation" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const clean = body.items.find(
      (i: { subClassification: string; component: string }) =>
        i.subClassification === "Test-Clean" && i.component === "C1"
    );
    expect(clean).toBeDefined();
    expect(clean.costCheckPass).toBe(true);
    expect(clean.costCheckDelta).toBeCloseTo(0, 6);
    expect(clean.depCheckPass).toBe(true);
    expect(clean.depCheckDelta).toBeCloseTo(0, 6);
  });

  it("fails both checks for a broken sub classification, with the correct mismatch amount", async () => {
    const res = await authedInject(app, { method: "GET", url: "/api/reports/audit-reconciliation" });
    const body = res.json();
    const broken = body.items.find(
      (i: { subClassification: string; component: string }) =>
        i.subClassification === "Test-Broken" && i.component === "C1"
    );
    expect(broken).toBeDefined();

    // Orphaned deletion of 30000 on RECON-BROKEN-1 makes the cost side disagree.
    expect(broken.costCheckPass).toBe(false);
    expect(Math.abs(broken.costCheckDelta)).toBeCloseTo(30000, 6);
    expect(broken.costCheckMessage).toContain("doesn't match Closing cost");

    // RECON-BROKEN-2's Opening Acc Dep (150000) exceeds cost (100000); Closing Acc Dep
    // gets capped at Gross Block, so the roll-forward is short by exactly 50000.
    expect(broken.depCheckPass).toBe(false);
    expect(Math.abs(broken.depCheckDelta)).toBeCloseTo(50000, 6);
    expect(broken.depCheckMessage).toContain("doesn't match Closing Acc Dep");
  });

  it("keeps C1 and C2 independent: Test-Broken's C2 side is untouched and passes", async () => {
    const res = await authedInject(app, { method: "GET", url: "/api/reports/audit-reconciliation" });
    const body = res.json();
    const brokenC2 = body.items.find(
      (i: { subClassification: string; component: string }) =>
        i.subClassification === "Test-Broken" && i.component === "C2"
    );
    expect(brokenC2).toBeDefined();
    expect(brokenC2.costCheckPass).toBe(true);
    expect(brokenC2.depCheckPass).toBe(true);
  });

  it("flags a disposal after useful life had already expired — accepted, reopened by the 2026-08-27 Excel-alignment revert", async () => {
    const res = await authedInject(app, { method: "GET", url: "/api/reports/audit-reconciliation" });
    const body = res.json();
    const postExpiry = body.items.find(
      (i: { subClassification: string; component: string }) =>
        i.subClassification === "Test-Post-Expiry-Disposal" && i.component === "C1"
    );
    expect(postExpiry).toBeDefined();
    // Cost side is unaffected by the revert — still reconciles.
    expect(postExpiry.costCheckPass).toBe(true);
    expect(postExpiry.costCheckDelta).toBeCloseTo(0, 6);
    // Dep side legitimately fails now: step 8 stays flat-rate independent of step 5's
    // taper, so accDepOpening(10000) + periodDep(40000) - accDepOnDisposed(11698.630137)
    // no longer equals closingAccDep(0).
    expect(postExpiry.depCheckPass).toBe(false);
    expect(postExpiry.depCheckDelta).toBeCloseTo(38301.369863013699, 4);
  });

  it("does not flag a disposal that is legitimately scheduled after AS_AT", async () => {
    const res = await authedInject(app, { method: "GET", url: "/api/reports/audit-reconciliation" });
    const body = res.json();
    const futureDisposal = body.items.find(
      (i: { subClassification: string; component: string }) =>
        i.subClassification === "Test-Future-Disposal" && i.component === "C1"
    );
    expect(futureDisposal).toBeDefined();
    expect(futureDisposal.costCheckPass).toBe(true);
    expect(futureDisposal.costCheckDelta).toBeCloseTo(0, 6);
    expect(futureDisposal.depCheckPass).toBe(true);
  });

  it("passes the NBV check (Gross Block - Acc Dep = NBV) for a clean sub classification", async () => {
    const res = await authedInject(app, { method: "GET", url: "/api/reports/audit-reconciliation" });
    const body = res.json();
    const clean = body.items.find(
      (i: { subClassification: string; component: string }) =>
        i.subClassification === "Test-Clean" && i.component === "C1"
    );
    expect(clean).toBeDefined();
    expect(clean.nbvCheckPass).toBe(true);
    expect(clean.nbvCheckDelta).toBeCloseTo(0, 6);
  });

  it("provides a Combined (C1+C2) row per sub classification, summing both components", async () => {
    const res = await authedInject(app, { method: "GET", url: "/api/reports/audit-reconciliation" });
    const body = res.json();
    const c1 = body.items.find(
      (i: { subClassification: string; component: string }) =>
        i.subClassification === "Test-Clean" && i.component === "C1"
    );
    const c2 = body.items.find(
      (i: { subClassification: string; component: string }) =>
        i.subClassification === "Test-Clean" && i.component === "C2"
    );
    const combined = body.items.find(
      (i: { subClassification: string; component: string }) =>
        i.subClassification === "Test-Clean" && i.component === "Combined"
    );
    expect(combined).toBeDefined();
    expect(combined.openingSum).toBeCloseTo(c1.openingSum + c2.openingSum, 6);
    expect(combined.closingGrossBlockSum).toBeCloseTo(c1.closingGrossBlockSum + c2.closingGrossBlockSum, 6);
    expect(combined.costCheckPass).toBe(true);
    expect(combined.depCheckPass).toBe(true);
    expect(combined.nbvCheckPass).toBe(true);
  });

  it("Combined row still fails when the underlying C1 side is broken", async () => {
    const res = await authedInject(app, { method: "GET", url: "/api/reports/audit-reconciliation" });
    const body = res.json();
    const combined = body.items.find(
      (i: { subClassification: string; component: string }) =>
        i.subClassification === "Test-Broken" && i.component === "Combined"
    );
    expect(combined).toBeDefined();
    expect(combined.costCheckPass).toBe(false);
    expect(Math.abs(combined.costCheckDelta)).toBeCloseTo(30000, 6);
    expect(combined.depCheckPass).toBe(false);
    expect(Math.abs(combined.depCheckDelta)).toBeCloseTo(50000, 6);
  });

  it("exports an Excel workbook", async () => {
    const res = await authedInject(app, { method: "GET", url: "/api/reports/audit-reconciliation/export" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(res.headers["content-disposition"]).toContain("audit-reconciliation-");
    expect(res.rawPayload.length).toBeGreaterThan(0);
  });
});

interface AssetWiseRow {
  farId: string;
  currentLocation: string;
  totalDepreciation: number;
  segments: Array<{ location: string; fromDate: string; toDate: string; daysHeld: number; depreciation: number }>;
}
interface LocationWiseRow {
  location: string;
  assetCount: number;
  totalDepreciation: number;
}

function paise(amount: number): number {
  return Math.round(amount * 100);
}

// New reporting-layer work (this report never touches engine.ts/calcFunction.sql) —
// exercised through the real API, not just the pure splitDepreciationByLocation unit
// tests, so a mistake in *wiring* the split into computeAsset's trusted total (wrong
// period bounds, wrong transfer set) would show up here even if the split function
// itself were correct in isolation.
describe("Transfer & Depreciation Report", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const db = await getPool();
    await db.query(
      `INSERT INTO settings (id, as_at, fy_start, fy_end, days_in_fy) VALUES (TRUE, $1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET as_at = $1, fy_start = $2, fy_end = $3, days_in_fy = $4`,
      [AS_AT, FY_START, FY_END, DAYS_IN_FY]
    );

    await insertAsset({
      far_id: "XDEP-STILL",
      sub_classification: "Test-XDep",
      asset_description: "Never transferred",
      serial_no: "XD1",
      qty: 1,
      useful_life_c1_years: 10,
      c1_opening_cost: 200000,
      additions_c1: 0,
      date_of_disposal: null,
      deletions_c1: 0,
      acc_dep_c1_opening: 40000,
      location: "Center-Still"
    });

    await insertAsset({
      far_id: "XDEP-MOVED",
      sub_classification: "Test-XDep",
      asset_description: "One mid-period transfer",
      serial_no: "XD2",
      qty: 1,
      useful_life_c1_years: 10,
      c1_opening_cost: 300000,
      additions_c1: 0,
      date_of_disposal: null,
      deletions_c1: 0,
      acc_dep_c1_opening: 50000,
      location: "Center-A"
    });
    await db.query(
      `INSERT INTO transfers (far_id, transaction_date, location) VALUES ($1, $2, $3)`,
      ["XDEP-MOVED", "2026-06-15", "Center-B"]
    );

    // The scenario the report's spec calls out by name: an asset with many location
    // changes (10+) within one period.
    await insertAsset({
      far_id: "XDEP-MANY",
      sub_classification: "Test-XDep",
      asset_description: "Many transfers within the period",
      serial_no: "XD3",
      qty: 1,
      useful_life_c1_years: 8,
      c1_opening_cost: 913457,
      additions_c1: 0,
      date_of_disposal: null,
      deletions_c1: 0,
      acc_dep_c1_opening: 61111,
      location: "Center-0"
    });
    const manyTransferDates = [
      "2026-04-05", "2026-04-12", "2026-04-19", "2026-04-28",
      "2026-05-06", "2026-05-15", "2026-05-27",
      "2026-06-09", "2026-06-21",
      "2026-07-03", "2026-07-18",
      "2026-08-02"
    ];
    for (let i = 0; i < manyTransferDates.length; i++) {
      await db.query(`INSERT INTO transfers (far_id, transaction_date, location) VALUES ($1, $2, $3)`, [
        "XDEP-MANY",
        manyTransferDates[i],
        `Center-${(i % 5) + 1}`
      ]);
    }

    app = Fastify();
    await app.register(reportsRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("gives an asset that never transferred a single full-period segment", async () => {
    const res = await authedInject(app, { method: "GET", url: "/api/reports/transfer-depreciation" });
    const body = res.json();
    const row = body.assetWise.find((a: AssetWiseRow) => a.farId === "XDEP-STILL");
    expect(row).toBeDefined();
    expect(row.segments).toHaveLength(1);
    expect(row.segments[0].location).toBe("Center-Still");
    expect(paise(row.segments[0].depreciation)).toBe(paise(row.totalDepreciation));
  });

  it("splits a single mid-period transfer into two segments that reconcile exactly", async () => {
    const res = await authedInject(app, { method: "GET", url: "/api/reports/transfer-depreciation" });
    const body = res.json();
    const row: AssetWiseRow = body.assetWise.find((a: AssetWiseRow) => a.farId === "XDEP-MOVED");
    expect(row).toBeDefined();
    expect(row.segments).toHaveLength(2);
    expect(row.segments[0]!.location).toBe("Center-A");
    expect(row.segments[1]!.location).toBe("Center-B");
    expect(row.currentLocation).toBe("Center-B");
    const segmentSumPaise = row.segments.reduce((s, seg) => s + paise(seg.depreciation), 0);
    expect(segmentSumPaise).toBe(paise(row.totalDepreciation));
  });

  it("reconciles exactly (to the paisa) for an asset with many transfers, through the real API", async () => {
    const res = await authedInject(app, { method: "GET", url: "/api/reports/transfer-depreciation" });
    const body = res.json();
    const row: AssetWiseRow = body.assetWise.find((a: AssetWiseRow) => a.farId === "XDEP-MANY");
    expect(row).toBeDefined();
    // 12 transfer dates all within the period → up to 13 segments (one before the
    // first transfer, one per transfer after).
    expect(row.segments.length).toBeGreaterThanOrEqual(10);
    const segmentSumPaise = row.segments.reduce((s, seg) => s + paise(seg.depreciation), 0);
    expect(segmentSumPaise).toBe(paise(row.totalDepreciation));
    // Every segment's days-held is strictly positive — a zero-or-negative segment
    // slipping through would silently break the days-weighted split.
    expect(row.segments.every((s) => s.daysHeld > 0)).toBe(true);
  });

  it("location-wise totals sum to the same grand total as asset-wise totals (nothing gained or lost in aggregation)", async () => {
    const res = await authedInject(app, { method: "GET", url: "/api/reports/transfer-depreciation" });
    const body = res.json();
    const assetGrandTotalPaise = body.assetWise.reduce((s: number, a: AssetWiseRow) => s + paise(a.totalDepreciation), 0);
    const locationGrandTotalPaise = body.locationWise.reduce((s: number, l: LocationWiseRow) => s + paise(l.totalDepreciation), 0);
    expect(locationGrandTotalPaise).toBe(assetGrandTotalPaise);
  });

  it("exports an Excel workbook with the three documented sheets, including full Movement Detail for the many-transfer asset", async () => {
    const res = await authedInject(app, { method: "GET", url: "/api/reports/transfer-depreciation/export" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(res.headers["content-disposition"]).toContain("transfer-depreciation-");

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.rawPayload as any);
    const sheetNames = workbook.worksheets.map((s) => s.name);
    expect(sheetNames).toEqual(["Location-wise Summary", "Asset-wise Summary", "Movement Detail"]);

    const detailSheet = workbook.getWorksheet("Movement Detail")!;
    const manyRows: string[] = [];
    detailSheet.eachRow((row) => {
      if (row.getCell(1).value === "XDEP-MANY") manyRows.push(String(row.getCell(3).value));
    });
    // Every segment for XDEP-MANY made it into the flat detail sheet, not just a sample.
    expect(manyRows.length).toBeGreaterThanOrEqual(10);

    // XDEP-STILL never transferred (one segment) — it must be excluded from the detail
    // sheet entirely, per spec ("every asset that moved").
    let stillAppears = false;
    detailSheet.eachRow((row) => {
      if (row.getCell(1).value === "XDEP-STILL") stillAppears = true;
    });
    expect(stillAppears).toBe(false);
  });
});
