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

    // Regression fixture for the cap/floor adjustment feature: an old asset (acquired
    // 2018-01-01) with a short useful life (3 years — already well expired by this FY)
    // disposed mid-year, with a real partial disposal amount (40000 of 90000 cost).
    // Matches the shape found via the 250k-asset load-test scale test's "Audit
    // Reconciliation ties out at full scale" failure investigation: an old,
    // short-useful-life, disposed-mid-year asset legitimately pushes the naive
    // Opening Acc Dep + Period Dep − Acc Dep Removed figure above the remaining Gross
    // Block, so the locked engine's Closing Acc Dep clamp (see engine.ts) caps it —
    // confirmed via engine.computeComponent directly: naive 56624.048706240486, capped
    // to grossBlock 50000, a 6624.048706240486 adjustment.
    await insertAsset({
      far_id: "RECON-CAP-SCENARIO",
      sub_classification: "Test-Cap-Scenario",
      asset_description: "Old, short-life asset disposed mid-year (hits the cap)",
      serial_no: "S7",
      qty: 1,
      date_acquired: "2018-01-01",
      useful_life_c1_years: 3,
      c1_opening_cost: 90000,
      additions_c1: 0,
      date_of_disposal: "2026-06-01",
      deletions_c1: 40000,
      acc_dep_c1_opening: 70000,
      sale_value: 1000
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
    // Neither fixture in this sub classification ever hits the Closing Acc Dep clamp —
    // no spurious adjustment should be reported for an asset whose figures already tie
    // out on their own.
    expect(clean.cappedSum).toBeCloseTo(0, 6);
    expect(clean.flooredSum).toBeCloseTo(0, 6);
    expect(clean.capAdjustmentMessage).toBeNull();
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

    // RECON-BROKEN-2's Opening Acc Dep (150000) exceeds cost (100000). This used to
    // fail the dep check outright (Closing Acc Dep silently capped at Gross Block, no
    // explanation); the cap/floor adjustment now accounts for it explicitly instead —
    // see "shows the cap adjustment and still ties out" below for the full assertion.
    expect(broken.depCheckPass).toBe(true);
    expect(broken.cappedSum).toBeCloseTo(50000, 6);
    expect(broken.capAdjustmentMessage).toContain("Capped at Gross Block");
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

  it("disposal after useful life had already expired — was an accepted, unexplained dep-check gap; now ties out via the cap adjustment", async () => {
    const res = await authedInject(app, { method: "GET", url: "/api/reports/audit-reconciliation" });
    const body = res.json();
    const postExpiry = body.items.find(
      (i: { subClassification: string; component: string }) =>
        i.subClassification === "Test-Post-Expiry-Disposal" && i.component === "C1"
    );
    expect(postExpiry).toBeDefined();
    // Cost side was never affected by this — still reconciles.
    expect(postExpiry.costCheckPass).toBe(true);
    expect(postExpiry.costCheckDelta).toBeCloseTo(0, 6);
    // Step 8 stays flat-rate independent of step 5's taper (confirmed by finance, see
    // engine.ts), so accDepOpening(10000) + periodDep(40000) - accDepOnDisposed
    // (11698.630137) doesn't match closingAccDep(0) directly — Closing Acc Dep gets
    // capped at Gross Block (0, since this asset's fully disposed). The dep check now
    // accounts for that ₹38,301.37 cap explicitly instead of reporting an unexplained
    // gap, and ties out exactly.
    expect(postExpiry.depCheckPass).toBe(true);
    expect(postExpiry.depCheckDelta).toBeCloseTo(0, 6);
    expect(postExpiry.cappedSum).toBeCloseTo(38301.369863013699, 4);
    expect(postExpiry.flooredSum).toBeCloseTo(0, 6);
    expect(postExpiry.capAdjustmentMessage).toContain("Capped at Gross Block: ₹38301.37");
  });

  it("an old, short-useful-life asset disposed mid-year (the exact scale-test cap scenario) ties out exactly and shows the adjustment line", async () => {
    const res = await authedInject(app, { method: "GET", url: "/api/reports/audit-reconciliation" });
    const body = res.json();
    const capScenario = body.items.find(
      (i: { subClassification: string; component: string }) =>
        i.subClassification === "Test-Cap-Scenario" && i.component === "C1"
    );
    expect(capScenario).toBeDefined();

    // Cost side is unaffected by the cap — still reconciles on its own.
    expect(capScenario.costCheckPass).toBe(true);
    expect(capScenario.costCheckDelta).toBeCloseTo(0, 6);

    // Confirmed directly against engine.computeComponent: naive Opening Acc Dep(70000)
    // + Period Dep(20000) - Acc Dep Removed(33375.951293759514) = 56624.048706240486,
    // capped to Gross Block (50000) — a 6624.048706240486 adjustment.
    expect(capScenario.accDepOpeningSum).toBeCloseTo(70000, 6);
    expect(capScenario.periodDepSum).toBeCloseTo(20000, 6);
    expect(capScenario.accDepRemovedSum).toBeCloseTo(33375.951293759514, 4);
    expect(capScenario.closingAccDepSum).toBeCloseTo(50000, 6);
    expect(capScenario.cappedSum).toBeCloseTo(6624.048706240486, 4);
    expect(capScenario.flooredSum).toBeCloseTo(0, 6);

    // The report ties out exactly once the adjustment is accounted for, and the
    // adjustment itself is shown explicitly rather than left as an unexplained gap.
    expect(capScenario.depCheckPass).toBe(true);
    expect(capScenario.depCheckDelta).toBeCloseTo(0, 6);
    expect(capScenario.capAdjustmentMessage).toBe("Capped at Gross Block: ₹6624.05");
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
    // Dep side used to fail here too (RECON-BROKEN-2's cap); it now ties out via the
    // cap adjustment, same as the C1 row above — cost and dep checks are independent,
    // so the cost check failing doesn't stop the dep check from correctly passing.
    expect(combined.depCheckPass).toBe(true);
    expect(combined.cappedSum).toBeCloseTo(50000, 6);
  });

  it("exports an Excel workbook", async () => {
    const res = await authedInject(app, { method: "GET", url: "/api/reports/audit-reconciliation/export" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(res.headers["content-disposition"]).toContain("audit-reconciliation-");
    expect(res.rawPayload.length).toBeGreaterThan(0);
  });

  it("Excel export includes the Acc Dep Adjustment column and shows the cap value for the cap-scenario fixture's C1 row", async () => {
    const res = await authedInject(app, { method: "GET", url: "/api/reports/audit-reconciliation/export" });
    expect(res.statusCode).toBe(200);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.rawPayload as any);
    const sheet = workbook.worksheets[0]!;

    // Row 1 = title, row 2 = blank, row 3 = C1 block's section title, row 4 = C1
    // block's own header row — same layout every other export test in this file
    // assumes for the sheets it inspects.
    const headerRow = sheet.getRow(4);
    const headers = (headerRow.values as unknown[]).slice(1).map(String);
    expect(headers).toContain("Acc Dep Adjustment (Cap/Floor)");
    const adjustmentCol = headers.indexOf("Acc Dep Adjustment (Cap/Floor)") + 1;
    const accDepCheckCol = headers.indexOf("Dep Check") + 1;
    // Confirms the column-index shift (Dep Check moved from 10 to 11 to make room for
    // the new column) actually landed where the header says it did, not just that a
    // header with the right text exists somewhere in the row.
    expect(accDepCheckCol).toBe(adjustmentCol + 2);

    // Find the cap-scenario fixture's C1 row by scanning column 1 (Sub Classification)
    // for its label, and confirm the adjustment cell holds the same capped amount the
    // JSON API returns for it (6624.048706240486, see the dedicated JSON test above).
    // The fixture appears in all three blocks (C1, C2, Combined) — the sheet writes C1
    // first (see buildReconciliationWorkbook), so the first match is its C1 row.
    let found = false;
    sheet.eachRow((row, rowNumber) => {
      if (found || rowNumber <= 4) return;
      if (row.getCell(1).value === "Test-Cap-Scenario") {
        found = true;
        expect(Number(row.getCell(adjustmentCol).value)).toBeCloseTo(6624.048706240486, 4);
      }
    });
    expect(found).toBe(true);
  });
});

interface AssetWiseRow {
  farId: string;
  currentLocation: string;
  c1TotalDepreciation: number;
  c2TotalDepreciation: number;
  totalDepreciation: number;
}
interface Segment {
  location: string;
  fromDate: string;
  toDate: string;
  daysHeld: number;
  c1Depreciation: number;
  c2Depreciation: number;
  depreciation: number;
}
interface LocationWiseRow {
  location: string;
  assetCount: number;
  c1TotalDepreciation: number;
  c2TotalDepreciation: number;
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
    // Mirrors what the real transfer route (transfers.ts) also does on every transfer —
    // a raw INSERT into `transfers` alone (as above) leaves this denormalized cache
    // stale, which is exactly the gap that broke this fixture's Current Location filter
    // test the first time (revised_location stayed NULL, so effective_location fell
    // back to the original "Center-A").
    await db.query(`UPDATE assets SET revised_location = $1 WHERE far_id = $2`, ["Center-B", "XDEP-MOVED"]);

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
      // A real, distinct C2 component too — different useful life and cost from C1 —
      // so a bug that only reconciles the combined figure (e.g. splitting c1+c2 as one
      // lump sum) can't hide behind a zero C2.
      useful_life_c2_years: 4,
      c2_opening_cost: 214009,
      additions_c2: 0,
      deletions_c2: 0,
      acc_dep_c2_opening: 33250,
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

  async function fetchSegments(farId: string): Promise<Segment[]> {
    const res = await authedInject(app, {
      method: "GET",
      url: `/api/reports/transfer-depreciation/asset/${farId}/segments`
    });
    expect(res.statusCode).toBe(200);
    return res.json().segments;
  }

  it("gives an asset that never transferred a single full-period segment", async () => {
    const listRes = await authedInject(app, { method: "GET", url: "/api/reports/transfer-depreciation/asset-wise" });
    const row = listRes.json().items.find((a: AssetWiseRow) => a.farId === "XDEP-STILL");
    expect(row).toBeDefined();

    const segments = await fetchSegments("XDEP-STILL");
    expect(segments).toHaveLength(1);
    expect(segments[0]!.location).toBe("Center-Still");
    expect(paise(segments[0]!.depreciation)).toBe(paise(row.totalDepreciation));
  });

  it("splits a single mid-period transfer into two segments that reconcile exactly", async () => {
    const listRes = await authedInject(app, { method: "GET", url: "/api/reports/transfer-depreciation/asset-wise" });
    const row: AssetWiseRow = listRes.json().items.find((a: AssetWiseRow) => a.farId === "XDEP-MOVED");
    expect(row).toBeDefined();
    expect(row.currentLocation).toBe("Center-B");

    const segments = await fetchSegments("XDEP-MOVED");
    expect(segments).toHaveLength(2);
    expect(segments[0]!.location).toBe("Center-A");
    expect(segments[1]!.location).toBe("Center-B");
    const segmentSumPaise = segments.reduce((s, seg) => s + paise(seg.depreciation), 0);
    expect(segmentSumPaise).toBe(paise(row.totalDepreciation));
  });

  it("reconciles exactly (to the paisa) for an asset with many transfers, through the real API", async () => {
    const listRes = await authedInject(app, { method: "GET", url: "/api/reports/transfer-depreciation/asset-wise" });
    const row: AssetWiseRow = listRes.json().items.find((a: AssetWiseRow) => a.farId === "XDEP-MANY");
    expect(row).toBeDefined();

    const segments = await fetchSegments("XDEP-MANY");
    // 12 transfer dates all within the period → up to 13 segments (one before the
    // first transfer, one per transfer after).
    expect(segments.length).toBeGreaterThanOrEqual(10);
    const segmentSumPaise = segments.reduce((s, seg) => s + paise(seg.depreciation), 0);
    expect(segmentSumPaise).toBe(paise(row.totalDepreciation));
    // Every segment's days-held is strictly positive — a zero-or-negative segment
    // slipping through would silently break the days-weighted split.
    expect(segments.every((s) => s.daysHeld > 0)).toBe(true);
  });

  // C1 and C2 have genuinely different useful lives and costs for XDEP-MANY (see the
  // fixture above), so this can't pass by C2 happening to be zero — each component's
  // own segments must independently sum to that component's own real total.
  it("reconciles C1 and C2 independently (not just their combined total) for the many-transfer asset", async () => {
    const listRes = await authedInject(app, { method: "GET", url: "/api/reports/transfer-depreciation/asset-wise" });
    const row: AssetWiseRow = listRes.json().items.find((a: AssetWiseRow) => a.farId === "XDEP-MANY");
    expect(row).toBeDefined();
    expect(row.c1TotalDepreciation).toBeGreaterThan(0);
    expect(row.c2TotalDepreciation).toBeGreaterThan(0);
    // The two components must be genuinely different, or this test can't tell a
    // combined-only split from a real per-component one.
    expect(paise(row.c1TotalDepreciation)).not.toBe(paise(row.c2TotalDepreciation));

    const segments = await fetchSegments("XDEP-MANY");
    const c1SumPaise = segments.reduce((s, seg) => s + paise(seg.c1Depreciation), 0);
    const c2SumPaise = segments.reduce((s, seg) => s + paise(seg.c2Depreciation), 0);
    expect(c1SumPaise).toBe(paise(row.c1TotalDepreciation));
    expect(c2SumPaise).toBe(paise(row.c2TotalDepreciation));
    // Every segment's own combined figure is exactly its two component figures added.
    for (const seg of segments) {
      expect(paise(seg.depreciation)).toBe(paise(seg.c1Depreciation) + paise(seg.c2Depreciation));
    }
  });

  it("404s the segment endpoint for a FAR ID that doesn't exist", async () => {
    const res = await authedInject(app, {
      method: "GET",
      url: "/api/reports/transfer-depreciation/asset/NOPE-NOT-REAL/segments"
    });
    expect(res.statusCode).toBe(404);
  });

  it("location-wise totals sum to the same grand total as asset-wise totals, per component and combined", async () => {
    // Restricted to this describe block's own fixtures (Test-XDep) — the assetWise
    // grand total here is only meaningful summed over the SAME asset population the
    // location-wise scan aggregated, and other describe blocks in this file share the
    // same table.
    const conditions = encodeURIComponent(JSON.stringify([{ columnId: "farId", op: "beginsWith", value: "XDEP-" }]));
    const listRes = await authedInject(app, {
      method: "GET",
      url: `/api/reports/transfer-depreciation/asset-wise?limit=500&conditions=${conditions}`
    });
    const items: AssetWiseRow[] = listRes.json().items;
    expect(items.length).toBeGreaterThanOrEqual(3);

    const locRes = await authedInject(app, {
      method: "GET",
      url: `/api/reports/transfer-depreciation/location-wise?conditions=${conditions}`
    });
    const locationWise: LocationWiseRow[] = locRes.json().locationWise;

    const assetC1Paise = items.reduce((s, a) => s + paise(a.c1TotalDepreciation), 0);
    const assetC2Paise = items.reduce((s, a) => s + paise(a.c2TotalDepreciation), 0);
    const assetTotalPaise = items.reduce((s, a) => s + paise(a.totalDepreciation), 0);
    const locC1Paise = locationWise.reduce((s, l) => s + paise(l.c1TotalDepreciation), 0);
    const locC2Paise = locationWise.reduce((s, l) => s + paise(l.c2TotalDepreciation), 0);
    const locTotalPaise = locationWise.reduce((s, l) => s + paise(l.totalDepreciation), 0);
    expect(locC1Paise).toBe(assetC1Paise);
    expect(locC2Paise).toBe(assetC2Paise);
    expect(locTotalPaise).toBe(assetTotalPaise);
  });

  it("paginates the asset-wise list with a keyset cursor — a 1-row page's nextCursor reaches the next asset, and running out returns null", async () => {
    const conditions = encodeURIComponent(JSON.stringify([{ columnId: "farId", op: "beginsWith", value: "XDEP-" }]));
    const page1 = await authedInject(app, {
      method: "GET",
      url: `/api/reports/transfer-depreciation/asset-wise?limit=1&conditions=${conditions}`
    });
    const body1 = page1.json();
    expect(body1.items).toHaveLength(1);
    expect(body1.nextCursor).toBeTruthy();

    const page2 = await authedInject(app, {
      method: "GET",
      url: `/api/reports/transfer-depreciation/asset-wise?limit=1&cursor=${body1.nextCursor}&conditions=${conditions}`
    });
    const body2 = page2.json();
    expect(body2.items).toHaveLength(1);
    // Keyset, not offset: strictly greater than the cursor, never repeats a row.
    expect(body2.items[0].farId > body1.items[0].farId).toBe(true);

    // Page through everything (3 XDEP- fixtures) and confirm the cursor eventually
    // exhausts to null rather than looping or erroring.
    const all = [...body1.items, ...body2.items];
    let cursor: string | null = body2.nextCursor;
    while (cursor) {
      const res = await authedInject(app, {
        method: "GET",
        url: `/api/reports/transfer-depreciation/asset-wise?limit=1&cursor=${cursor}&conditions=${conditions}`
      });
      const body = res.json();
      if (body.items.length === 0) {
        expect(body.nextCursor).toBeNull();
        break;
      }
      all.push(...body.items);
      cursor = body.nextCursor;
    }
    expect(all.map((a: AssetWiseRow) => a.farId).sort()).toEqual(["XDEP-MANY", "XDEP-MOVED", "XDEP-STILL"]);
  });

  it("filters the asset-wise list by a numeric C1 condition, server-side (fewer rows returned, not just fewer shown)", async () => {
    const conditions = encodeURIComponent(
      JSON.stringify([
        { columnId: "farId", op: "beginsWith", value: "XDEP-" },
        { columnId: "c1TotalDepreciation", op: "gt", value: 20000 }
      ])
    );
    const res = await authedInject(app, {
      method: "GET",
      url: `/api/reports/transfer-depreciation/asset-wise?limit=500&conditions=${conditions}`
    });
    const items: AssetWiseRow[] = res.json().items;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((a) => a.c1TotalDepreciation > 20000)).toBe(true);
    // XDEP-STILL's C1 total (~7,500 given its cost/useful-life over the fixture period)
    // must be excluded — proves the filter actually narrowed the query, not just
    // decoration.
    expect(items.some((a) => a.farId === "XDEP-STILL")).toBe(false);
  });

  it("filters the asset-wise list by Current Location, server-side", async () => {
    const conditions = encodeURIComponent(
      JSON.stringify([{ columnId: "currentLocation", op: "equals", value: "Center-B" }])
    );
    const res = await authedInject(app, {
      method: "GET",
      url: `/api/reports/transfer-depreciation/asset-wise?limit=500&conditions=${conditions}`
    });
    const items: AssetWiseRow[] = res.json().items;
    expect(items.some((a) => a.farId === "XDEP-MOVED")).toBe(true);
    expect(items.every((a) => a.currentLocation === "Center-B")).toBe(true);
  });

  it("rejects an unknown filter column with 400, on both the list and the location-wise endpoints", async () => {
    const conditions = encodeURIComponent(JSON.stringify([{ columnId: "notARealColumn", op: "equals", value: "x" }]));
    const listRes = await authedInject(app, {
      method: "GET",
      url: `/api/reports/transfer-depreciation/asset-wise?conditions=${conditions}`
    });
    expect(listRes.statusCode).toBe(400);
    const locRes = await authedInject(app, {
      method: "GET",
      url: `/api/reports/transfer-depreciation/location-wise?conditions=${conditions}`
    });
    expect(locRes.statusCode).toBe(400);
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

    // Every sheet carries the C1/C2 breakdown, not just a combined figure.
    const locationHeaderRow = workbook.getWorksheet("Location-wise Summary")!.getRow(2).values as unknown[];
    expect(locationHeaderRow).toEqual([
      undefined,
      "Location",
      "Asset Count",
      "C1 Depreciation",
      "C2 Depreciation",
      "Total Depreciation"
    ]);
    const assetHeaderRow = workbook.getWorksheet("Asset-wise Summary")!.getRow(2).values as unknown[];
    expect(assetHeaderRow).toEqual([
      undefined,
      "FAR ID",
      "Sub Classification",
      "Current Location",
      "C1 Period Depreciation",
      "C2 Period Depreciation",
      "Total Period Depreciation"
    ]);
    const detailHeaderRow = workbook.getWorksheet("Movement Detail")!.getRow(2).values as unknown[];
    expect(detailHeaderRow).toEqual([
      undefined,
      "FAR ID",
      "Sub Classification",
      "Location",
      "From Date",
      "To Date",
      "Days Held",
      "C1 Depreciation",
      "C2 Depreciation",
      "Depreciation"
    ]);

    const detailSheet = workbook.getWorksheet("Movement Detail")!;
    const manyRows: Array<{ location: string; c1: number; c2: number; total: number }> = [];
    detailSheet.eachRow((row) => {
      if (row.getCell(1).value === "XDEP-MANY") {
        manyRows.push({
          location: String(row.getCell(3).value),
          c1: Number(row.getCell(7).value),
          c2: Number(row.getCell(8).value),
          total: Number(row.getCell(9).value)
        });
      }
    });
    // Every segment for XDEP-MANY made it into the flat detail sheet, not just a sample.
    expect(manyRows.length).toBeGreaterThanOrEqual(10);
    // C2 is genuinely present in the export (not silently dropped/zeroed).
    expect(manyRows.some((r) => r.c2 > 0)).toBe(true);
    for (const r of manyRows) {
      expect(paise(r.total)).toBe(paise(r.c1) + paise(r.c2));
    }

    // XDEP-STILL never transferred (one segment) — it must be excluded from the detail
    // sheet entirely, per spec ("every asset that moved").
    let stillAppears = false;
    detailSheet.eachRow((row) => {
      if (row.getCell(1).value === "XDEP-STILL") stillAppears = true;
    });
    expect(stillAppears).toBe(false);
  });

  it("the export respects the same Excel-style filter conditions as the list endpoints", async () => {
    const conditions = encodeURIComponent(JSON.stringify([{ columnId: "farId", op: "equals", value: "XDEP-STILL" }]));
    const res = await authedInject(app, {
      method: "GET",
      url: `/api/reports/transfer-depreciation/export?conditions=${conditions}`
    });
    expect(res.statusCode).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.rawPayload as any);

    const assetSheet = workbook.getWorksheet("Asset-wise Summary")!;
    const farIds: string[] = [];
    assetSheet.eachRow((row, num) => {
      if (num > 2) farIds.push(String(row.getCell(1).value));
    });
    expect(farIds).toEqual(["XDEP-STILL"]);

    const locationSheet = workbook.getWorksheet("Location-wise Summary")!;
    const locations: string[] = [];
    locationSheet.eachRow((row, num) => {
      if (num > 2) locations.push(String(row.getCell(1).value));
    });
    expect(locations).toEqual(["Center-Still"]);
  });
});
