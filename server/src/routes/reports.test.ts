import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import reportsRoutes from "./reports.js";
import assetsRoutes from "./assets.js";
import { getPool } from "../db/pool.js";
import { authedInject, authHeaderFor, createTestUser } from "../testHelpers/authTestUtils.js";
import { authGateHook } from "../auth/middleware.js";
import { generateAssets, generateTransfers } from "../loadtest/generateAssets.js";
import { bulkInsertAssets, bulkInsertTransfers } from "../loadtest/bulkInsert.js";
import { computeAsset } from "../calc/engine.js";
import { mapAssetRow, mapTransferRow } from "../db/mappers.js";
import type { AssetRow, TransferRow } from "../db/mappers.js";

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
    // (dateAcquired + usefulLife = 2024-12-30, well before this FY's fyStart). Originally
    // built (2026-08-27) to prove accDepOnDisposed's then-flat-rate form deliberately
    // reopened the dep-check gap for this shape. Since 2026-09-01 (second round),
    // accDepOnDisposed uses the same taper-aware periodDepreciation as step 5 (matching
    // Excel's AB/AC literally), which closes that gap back up — this fixture now proves
    // the report ties out with NO cap/floor adjustment needed, the opposite of its
    // original purpose. Cost side was never affected either way. See engine.test.ts's
    // "(f) disposed after useful life had already expired" for the underlying
    // component-level numbers this fixture matches.
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

    // Regression fixture, originally for the cap/floor adjustment feature: an old asset
    // (acquired 2018-01-01) with a short useful life (3 years — already well expired by
    // this FY) disposed mid-year, with a real partial disposal amount (40000 of 90000
    // cost). Originally (pre-2026-09-01) this legitimately pushed the flat-rate-based
    // naive Opening Acc Dep + Period Dep − Acc Dep Removed figure above the remaining
    // Gross Block, needing the Closing Acc Dep clamp (see engine.ts) to cap it — a
    // 6624.048706240486 adjustment. Since 2026-09-01 (second round), accDepOnDisposed's
    // taper-aware, ratio-based formula produces a naive figure that already lands exactly
    // on Gross Block for this fixture too (confirmed via engine.computeComponent
    // directly) — no cap needed. Kept as a regression fixture proving the report still
    // ties out cleanly for this shape, now via reconciliation rather than a cap.
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

    // Regression fixture, new 2026-09-01 (second round): the accDepOnDisposed fix above
    // closed off the only case (well-formed disposals) that previously exercised the
    // cap/floor adjustment mechanism's non-zero path — Test-Post-Expiry-Disposal and
    // Test-Cap-Scenario now both reconcile with no adjustment needed at all. This leaves
    // the mechanism with zero test coverage of the malformed-data scenario it still
    // exists to catch: accDepOpening exceeding the component's own cost basis (same shape
    // as the "over-depreciated bad data" fixture used elsewhere, but with a disposal).
    // Confirmed directly against engine.computeComponent: naive Opening Acc Dep(60000) +
    // Period Dep(0) - Acc Dep Removed(50000, itself already capped down from a raw 60000
    // by step 8's own Math.min) = 10000, above the remaining Gross Block (0 for a full
    // disposal) — a 10000 adjustment, this time exercising step 9's clamp on top of step
    // 8's. Kept distinct from Test-Cap-Scenario (which now represents the well-formed,
    // no-adjustment case) rather than modifying it.
    await insertAsset({
      far_id: "RECON-CAP-SCENARIO-MALFORMED",
      sub_classification: "Test-Cap-Scenario-Malformed",
      asset_description: "Malformed data: Opening Acc Dep exceeds cost, disposed (safety-net cap)",
      serial_no: "S7B",
      qty: 1,
      date_acquired: "2010-01-01",
      useful_life_c1_years: 5,
      c1_opening_cost: 50000,
      additions_c1: 0,
      date_of_disposal: "2026-06-01",
      deletions_c1: 50000,
      acc_dep_c1_opening: 60000,
      sale_value: 5000
    });

    // Has Component 2, decision 3: a C1-only Sub Classification shows a single row, not
    // separate C2/Combined rows. A real sub_classifications row (not just a free-text
    // match) is required — most other fixtures in this file never insert one, relying
    // on the "unrecognized name defaults to showing all 3 rows" fallback instead.
    await db.query(`DELETE FROM sub_classifications WHERE name = 'Test-C1-Only'`);
    await db.query(`INSERT INTO sub_classifications (name, has_component2) VALUES ('Test-C1-Only', FALSE)`);
    await insertAsset({
      far_id: "RECON-C1-ONLY",
      sub_classification: "Test-C1-Only",
      asset_description: "C1-only classification fixture",
      serial_no: "S8",
      qty: 1,
      useful_life_c1_years: 10,
      c1_opening_cost: 100000,
      additions_c1: 0,
      date_of_disposal: null,
      deletions_c1: 0,
      acc_dep_c1_opening: 20000
    });

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

  it("disposal after useful life had already expired — reconciles exactly on its own now, no cap adjustment needed (2026-09-01, second round)", async () => {
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
    // 2026-09-01 (second round): accDepOnDisposed now uses disposedRatio * (accDepOpening
    // + periodDepreciation) — the same taper-aware periodDepreciation as step 5, matching
    // Excel's AB/AC formula literally (see engine.ts's step 8 comment). accDepOpening
    // (10000) + periodDep(40000) - accDepOnDisposed(50000) = 0 = closingAccDep exactly,
    // with disposedRatio=1 (full disposal). No cap or floor engages — the gap this
    // fixture was built to explain no longer exists for this shape.
    expect(postExpiry.depCheckPass).toBe(true);
    expect(postExpiry.depCheckDelta).toBeCloseTo(0, 6);
    expect(postExpiry.cappedSum).toBeCloseTo(0, 6);
    expect(postExpiry.flooredSum).toBeCloseTo(0, 6);
    expect(postExpiry.capAdjustmentMessage).toBeNull();
  });

  it("an old, short-useful-life asset disposed mid-year (previously the cap-scenario fixture) now reconciles exactly on its own, no adjustment needed (2026-09-01, second round)", async () => {
    const res = await authedInject(app, { method: "GET", url: "/api/reports/audit-reconciliation" });
    const body = res.json();
    const capScenario = body.items.find(
      (i: { subClassification: string; component: string }) =>
        i.subClassification === "Test-Cap-Scenario" && i.component === "C1"
    );
    expect(capScenario).toBeDefined();

    // Cost side is unaffected — still reconciles on its own.
    expect(capScenario.costCheckPass).toBe(true);
    expect(capScenario.costCheckDelta).toBeCloseTo(0, 6);

    // Confirmed directly against engine.computeComponent: disposedRatio = 40000/90000 =
    // 0.4444..., accDepOnDisposed = 0.4444... * (70000 + 20000) = 40000 exactly —
    // Opening Acc Dep(70000) + Period Dep(20000) - Acc Dep Removed(40000) = 50000 =
    // Closing Acc Dep(50000) = Gross Block(50000), with no cap needed to get there
    // (unlike the pre-2026-09-01 flat-rate figure of 33375.95, which needed a
    // 6624.05 cap adjustment to reach the same 50000).
    expect(capScenario.accDepOpeningSum).toBeCloseTo(70000, 6);
    expect(capScenario.periodDepSum).toBeCloseTo(20000, 6);
    expect(capScenario.accDepRemovedSum).toBeCloseTo(40000, 6);
    expect(capScenario.closingAccDepSum).toBeCloseTo(50000, 6);
    expect(capScenario.cappedSum).toBeCloseTo(0, 6);
    expect(capScenario.flooredSum).toBeCloseTo(0, 6);

    expect(capScenario.depCheckPass).toBe(true);
    expect(capScenario.depCheckDelta).toBeCloseTo(0, 6);
    expect(capScenario.capAdjustmentMessage).toBeNull();
  });

  it("malformed data (Opening Acc Dep exceeds cost) still ties out via the cap adjustment — the safety net the mechanism now exists for (2026-09-01, second round)", async () => {
    const res = await authedInject(app, { method: "GET", url: "/api/reports/audit-reconciliation" });
    const body = res.json();
    const malformed = body.items.find(
      (i: { subClassification: string; component: string }) =>
        i.subClassification === "Test-Cap-Scenario-Malformed" && i.component === "C1"
    );
    expect(malformed).toBeDefined();

    // Cost side is unaffected by the cap — still reconciles on its own.
    expect(malformed.costCheckPass).toBe(true);
    expect(malformed.costCheckDelta).toBeCloseTo(0, 6);

    // step 8's own Math.min(..., effectiveDisposedCost) already capped accDepOnDisposed
    // down from a raw 60000 to 50000 (see engine.test.ts's "malformed-data safety net"
    // for that layer's own direct verification) — acc_dep_removed_sum below reflects the
    // POST-cap value. On top of that, step 9's clamp is what this report's cappedSum
    // metric measures: Opening Acc Dep(60000) + Period Dep(0) - Acc Dep Removed(50000) =
    // 10000, above the remaining Gross Block (0, full disposal) — a 10000 adjustment.
    expect(malformed.accDepOpeningSum).toBeCloseTo(60000, 6);
    expect(malformed.periodDepSum).toBeCloseTo(0, 6);
    expect(malformed.accDepRemovedSum).toBeCloseTo(50000, 6);
    expect(malformed.closingAccDepSum).toBeCloseTo(0, 6);
    expect(malformed.cappedSum).toBeCloseTo(10000, 6);
    expect(malformed.flooredSum).toBeCloseTo(0, 6);

    // The report ties out exactly once the adjustment is accounted for, and shows it
    // explicitly rather than leaving an unexplained gap — the mechanism doing its job.
    expect(malformed.depCheckPass).toBe(true);
    expect(malformed.depCheckDelta).toBeCloseTo(0, 6);
    expect(malformed.capAdjustmentMessage).toBe("Capped at Gross Block: ₹10000.00");
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

  it("Has Component 2, decision 3: a C1-only Sub Classification shows a single row — no separate C2 or Combined row", async () => {
    const res = await authedInject(app, { method: "GET", url: "/api/reports/audit-reconciliation" });
    const body = res.json();
    const rowsForClass = body.items.filter(
      (i: { subClassification: string }) => i.subClassification === "Test-C1-Only"
    );
    expect(rowsForClass).toHaveLength(1);
    expect(rowsForClass[0].component).toBe("C1");
    expect(rowsForClass[0].openingSum).toBeCloseTo(100000, 6);
    expect(rowsForClass[0].costCheckPass).toBe(true);
    expect(rowsForClass[0].depCheckPass).toBe(true);
  });

  it("exports an Excel workbook", async () => {
    const res = await authedInject(app, { method: "GET", url: "/api/reports/audit-reconciliation/export" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(res.headers["content-disposition"]).toContain("audit-reconciliation-");
    expect(res.rawPayload.length).toBeGreaterThan(0);
  });

  it("Excel export includes the Acc Dep Adjustment column, correctly positioned, matching the JSON API's value for the cap-scenario fixture's C1 row", async () => {
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
    // for its label, and confirm the adjustment cell holds the same amount the JSON API
    // returns for it. Since 2026-09-01 (second round) this fixture no longer needs any
    // cap adjustment (see the dedicated JSON test above) — the value is 0, not the
    // pre-2026-09-01 6624.048706240486 — but the column's existence, position, and
    // JSON-parity are still worth proving regardless of what the current fixtures' values
    // happen to be. The fixture appears in all three blocks (C1, C2, Combined) — the
    // sheet writes C1 first (see buildReconciliationWorkbook), so the first match is its
    // C1 row.
    let found = false;
    sheet.eachRow((row, rowNumber) => {
      if (found || rowNumber <= 4) return;
      if (row.getCell(1).value === "Test-Cap-Scenario") {
        found = true;
        expect(Number(row.getCell(adjustmentCol).value)).toBeCloseTo(0, 6);
      }
    });
    expect(found).toBe(true);
  });
});

interface MovementRow {
  farId: string;
  subClassification: string;
  assetDescription: string;
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

const FY = { asAt: AS_AT, fyStart: FY_START, fyEnd: FY_END, daysInFy: DAYS_IN_FY };

// New reporting-layer work (this report never touches engine.ts/calcFunction.sql) —
// exercised through the real API, not just the pure splitDepreciationByLocation unit
// tests, so a mistake in *wiring* the split into computeAsset's trusted total (wrong
// period bounds, wrong transfer set) would show up here even if the split function
// itself were correct in isolation.
describe("Asset Movement & Depreciation Schedule", () => {
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
    app.decorateRequest("user", null);
    app.addHook("preHandler", authGateHook);
    await app.register(cookie);
    await app.register(reportsRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const xdepCondition = encodeURIComponent(JSON.stringify([{ columnId: "farId", op: "beginsWith", value: "XDEP-" }]));

  async function fetchMovementRows(conditions: string = xdepCondition): Promise<MovementRow[]> {
    const res = await authedInject(app, {
      method: "GET",
      url: `/api/reports/transfer-depreciation/movement?limit=500&conditions=${conditions}`
    });
    expect(res.statusCode).toBe(200);
    return res.json().items;
  }

  // Independent ground truth: re-invokes the real calc engine directly (not via the
  // report's own endpoint), same way scale.loadtest.ts cross-checks the location-wise
  // scan — confirms the movement schedule's row totals actually reconcile to what the
  // locked engine says this asset owes, not just to themselves.
  async function computeExpectedTotalPaise(farId: string): Promise<number> {
    const db = await getPool();
    const { rows } = await db.query<AssetRow>(`SELECT * FROM assets WHERE far_id = $1`, [farId]);
    const asset = mapAssetRow(rows[0]!);
    const { rows: transferRows } = await db.query<TransferRow>(
      `SELECT far_id, transaction_date, location FROM transfers WHERE far_id = $1 ORDER BY transaction_date, id`,
      [farId]
    );
    const transfers = transferRows.map(mapTransferRow);
    const result = computeAsset(asset, FY, transfers);
    return paise(result.c1.periodDepreciation) + paise(result.c2.periodDepreciation);
  }

  it("gives an asset that never moved during the period exactly one row, covering the whole period", async () => {
    const rows = (await fetchMovementRows()).filter((r) => r.farId === "XDEP-STILL");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.location).toBe("Center-Still");
    expect(paise(rows[0]!.depreciation)).toBe(await computeExpectedTotalPaise("XDEP-STILL"));
  });

  it("splits a single mid-period transfer into two rows that reconcile exactly", async () => {
    const rows = (await fetchMovementRows()).filter((r) => r.farId === "XDEP-MOVED");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.location).toBe("Center-A");
    expect(rows[1]!.location).toBe("Center-B");
    const summedPaise = rows.reduce((s, r) => s + paise(r.depreciation), 0);
    expect(summedPaise).toBe(await computeExpectedTotalPaise("XDEP-MOVED"));
  });

  it("reconciles exactly (to the paisa) for an asset with many transfers, through the real API", async () => {
    const rows = (await fetchMovementRows()).filter((r) => r.farId === "XDEP-MANY");
    // 12 transfer dates all within the period → up to 13 rows (one before the first
    // transfer, one per transfer after).
    expect(rows.length).toBeGreaterThanOrEqual(10);
    const summedPaise = rows.reduce((s, r) => s + paise(r.depreciation), 0);
    expect(summedPaise).toBe(await computeExpectedTotalPaise("XDEP-MANY"));
    // Every row's days-held is strictly positive — a zero-or-negative segment slipping
    // through would silently break the days-weighted split.
    expect(rows.every((r) => r.daysHeld > 0)).toBe(true);
  });

  // C1 and C2 have genuinely different useful lives and costs for XDEP-MANY (see the
  // fixture above), so this can't pass by C2 happening to be zero — each component's
  // own rows must independently sum to that component's own real total.
  it("reconciles C1 and C2 independently (not just their combined total) for the many-transfer asset", async () => {
    const rows = (await fetchMovementRows()).filter((r) => r.farId === "XDEP-MANY");
    const c1SumPaise = rows.reduce((s, r) => s + paise(r.c1Depreciation), 0);
    const c2SumPaise = rows.reduce((s, r) => s + paise(r.c2Depreciation), 0);
    expect(c1SumPaise).toBeGreaterThan(0);
    expect(c2SumPaise).toBeGreaterThan(0);
    // The two components must be genuinely different, or this test can't tell a
    // combined-only split from a real per-component one.
    expect(c1SumPaise).not.toBe(c2SumPaise);
    // Every row's own combined figure is exactly its two component figures added.
    for (const r of rows) {
      expect(paise(r.depreciation)).toBe(paise(r.c1Depreciation) + paise(r.c2Depreciation));
    }
  });

  it("location totals sum to the same grand total as the movement schedule's own rows, per component and combined", async () => {
    // Restricted to this describe block's own fixtures (Test-XDep) — the grand total
    // here is only meaningful summed over the SAME asset population the location-wise
    // scan aggregated, and other describe blocks in this file share the same table.
    const rows = await fetchMovementRows();
    expect(rows.length).toBeGreaterThanOrEqual(3);

    const locRes = await authedInject(app, {
      method: "GET",
      url: `/api/reports/transfer-depreciation/location-wise?conditions=${xdepCondition}`
    });
    const locationWise: LocationWiseRow[] = locRes.json().locationWise;

    const rowC1Paise = rows.reduce((s, r) => s + paise(r.c1Depreciation), 0);
    const rowC2Paise = rows.reduce((s, r) => s + paise(r.c2Depreciation), 0);
    const rowTotalPaise = rows.reduce((s, r) => s + paise(r.depreciation), 0);
    const locC1Paise = locationWise.reduce((s, l) => s + paise(l.c1TotalDepreciation), 0);
    const locC2Paise = locationWise.reduce((s, l) => s + paise(l.c2TotalDepreciation), 0);
    const locTotalPaise = locationWise.reduce((s, l) => s + paise(l.totalDepreciation), 0);
    expect(locC1Paise).toBe(rowC1Paise);
    expect(locC2Paise).toBe(rowC2Paise);
    expect(locTotalPaise).toBe(rowTotalPaise);
  });

  it("paginates the movement schedule with a keyset cursor over assets — a 1-asset page returns ALL of that asset's rows, and running out returns null", async () => {
    const page1 = await authedInject(app, {
      method: "GET",
      url: `/api/reports/transfer-depreciation/movement?limit=1&conditions=${xdepCondition}`
    });
    const body1 = page1.json();
    // limit=1 bounds ASSETS scanned, not rows returned — the first asset alphabetically
    // (XDEP-MANY) has 10+ segments, all of which come back in this one page.
    expect(new Set(body1.items.map((r: MovementRow) => r.farId)).size).toBe(1);
    expect(body1.items.length).toBeGreaterThanOrEqual(1);
    expect(body1.nextCursor).toBeTruthy();

    const farIdsSeen = new Set<string>(body1.items.map((r: MovementRow) => r.farId));
    let cursor: string | null = body1.nextCursor;
    while (cursor) {
      const res = await authedInject(app, {
        method: "GET",
        url: `/api/reports/transfer-depreciation/movement?limit=1&cursor=${cursor}&conditions=${xdepCondition}`
      });
      const body = res.json();
      if (body.items.length === 0) {
        expect(body.nextCursor).toBeNull();
        break;
      }
      for (const r of body.items as MovementRow[]) farIdsSeen.add(r.farId);
      cursor = body.nextCursor;
    }
    // Page through everything (3 XDEP- fixtures) and confirm the cursor eventually
    // exhausts to null rather than looping or erroring — every asset seen exactly once.
    expect([...farIdsSeen].sort()).toEqual(["XDEP-MANY", "XDEP-MOVED", "XDEP-STILL"]);
  });

  it("filters the movement schedule by a numeric C1 condition, server-side — a whole asset is excluded, not just some of its rows", async () => {
    const conditions = encodeURIComponent(
      JSON.stringify([
        { columnId: "farId", op: "beginsWith", value: "XDEP-" },
        { columnId: "c1TotalDepreciation", op: "gt", value: 20000 }
      ])
    );
    const rows = await fetchMovementRows(conditions);
    expect(rows.length).toBeGreaterThan(0);
    // XDEP-STILL's C1 total (~7,500 given its cost/useful-life over the fixture period)
    // is below the threshold — its asset must be excluded entirely, proving the filter
    // narrowed the underlying asset query rather than just hiding some of its rows.
    expect(rows.some((r) => r.farId === "XDEP-STILL")).toBe(false);
    // XDEP-MANY's much larger cost (913,457 over 8 years) comfortably clears the
    // threshold — confirms the filter still lets a genuinely qualifying asset through.
    expect(rows.some((r) => r.farId === "XDEP-MANY")).toBe(true);
  });

  it("filters the movement schedule by Current Location, server-side — keeps ALL of a matching asset's rows, not just the one at that location", async () => {
    const conditions = encodeURIComponent(JSON.stringify([{ columnId: "currentLocation", op: "equals", value: "Center-B" }]));
    const rows = await fetchMovementRows(conditions);
    const movedRows = rows.filter((r) => r.farId === "XDEP-MOVED");
    // XDEP-MOVED's CURRENT location is Center-B, but it also has an earlier Center-A
    // stay in this period — filtering by current location includes the whole asset
    // (every location it occupied), not just the one row whose own Location column
    // happens to equal the filter value.
    expect(movedRows.map((r) => r.location).sort()).toEqual(["Center-A", "Center-B"]);
  });

  it("rejects an unknown filter column with 400, on both the movement and location-wise endpoints", async () => {
    const conditions = encodeURIComponent(JSON.stringify([{ columnId: "notARealColumn", op: "equals", value: "x" }]));
    const listRes = await authedInject(app, {
      method: "GET",
      url: `/api/reports/transfer-depreciation/movement?conditions=${conditions}`
    });
    expect(listRes.statusCode).toBe(400);
    const locRes = await authedInject(app, {
      method: "GET",
      url: `/api/reports/transfer-depreciation/location-wise?conditions=${conditions}`
    });
    expect(locRes.statusCode).toBe(400);
  });

  it("exports a single Excel sheet — every asset appears, one row per location-stay, including a never-moved asset", async () => {
    const res = await authedInject(app, { method: "GET", url: "/api/reports/transfer-depreciation/export" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(res.headers["content-disposition"]).toContain("asset-movement-depreciation-schedule-");

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.rawPayload as any);
    const sheetNames = workbook.worksheets.map((s) => s.name);
    expect(sheetNames).toEqual(["Asset Movement & Depreciation"]);

    const sheet = workbook.worksheets[0]!;
    // Row 1 = period note, row 2 = schedule note, row 3 = header.
    const headerRow = sheet.getRow(3).values as unknown[];
    expect(headerRow).toEqual([
      undefined,
      "FAR ID",
      "Sub Classification",
      "Description",
      "Location",
      "From Date",
      "To Date",
      "Days Held",
      "C1 Depreciation",
      "C2 Depreciation",
      "Total Depreciation"
    ]);

    const stillRows: ExcelJS.Row[] = [];
    const manyRows: Array<{ c1: number; c2: number; total: number }> = [];
    let inTotalsBlock = false;
    sheet.eachRow((row, num) => {
      if (num <= 3) return;
      const first = row.getCell(1).value;
      if (first === "LOCATION TOTALS") inTotalsBlock = true;
      if (inTotalsBlock) return;
      if (first === "XDEP-STILL") stillRows.push(row);
      if (first === "XDEP-MANY") {
        manyRows.push({
          c1: Number(row.getCell(8).value),
          c2: Number(row.getCell(9).value),
          total: Number(row.getCell(10).value)
        });
      }
    });
    // XDEP-STILL never moved — it must appear exactly once (not zero, unlike the old
    // Movement Detail sheet which excluded never-moved assets entirely).
    expect(stillRows).toHaveLength(1);
    // Every row for XDEP-MANY made it into the sheet, not just a sample.
    expect(manyRows.length).toBeGreaterThanOrEqual(10);
    // C2 is genuinely present in the export (not silently dropped/zeroed).
    expect(manyRows.some((r) => r.c2 > 0)).toBe(true);
    for (const r of manyRows) {
      expect(paise(r.total)).toBe(paise(r.c1) + paise(r.c2));
    }
  });

  it("the export's trailing Location Totals block reconciles exactly against its own detail rows — no silent truncation", async () => {
    const res = await authedInject(app, { method: "GET", url: "/api/reports/transfer-depreciation/export" });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.rawPayload as any);
    const sheet = workbook.worksheets[0]!;

    const reconstructed = new Map<string, number>();
    const locationsByFarId = new Map<string, Set<string>>();
    let detailRowCount = 0;
    let inTotalsBlock = false;
    const totalsRows: Array<{ location: string; count: number; totalPaise: number }> = [];
    sheet.eachRow((row, num) => {
      if (num <= 3) return;
      const first = row.getCell(1).value;
      if (first === null || first === undefined || first === "") return; // blank separator row
      if (first === "LOCATION TOTALS") {
        inTotalsBlock = true;
        return;
      }
      if (inTotalsBlock) {
        if (first === "Location" && row.getCell(2).value === "Asset Count") return; // totals header
        if (first === "Grand Total") return;
        totalsRows.push({
          location: String(first),
          count: Number(row.getCell(2).value),
          totalPaise: Math.round(Number(row.getCell(5).value) * 100)
        });
        return;
      }
      detailRowCount++;
      const farId = String(row.getCell(1).value);
      const location = String(row.getCell(4).value);
      const rowPaise = Math.round(Number(row.getCell(10).value) * 100);
      reconstructed.set(location, (reconstructed.get(location) ?? 0) + rowPaise);
      const set = locationsByFarId.get(farId) ?? new Set<string>();
      set.add(location);
      locationsByFarId.set(farId, set);
    });

    const reconstructedCounts = new Map<string, number>();
    for (const [, locations] of locationsByFarId) {
      for (const loc of locations) reconstructedCounts.set(loc, (reconstructedCounts.get(loc) ?? 0) + 1);
    }

    expect(detailRowCount).toBeGreaterThan(0);
    expect(totalsRows.length).toBeGreaterThan(0);
    for (const row of totalsRows) {
      expect(row.totalPaise).toBe(reconstructed.get(row.location) ?? -1);
      expect(row.count).toBe(reconstructedCounts.get(row.location) ?? -1);
    }
    // Nothing reconstructed from the detail rows is missing FROM the totals block either
    // (present in the reconstruction but absent from the actual block would be exactly
    // the kind of silent truncation this test exists to catch).
    expect([...reconstructed.keys()].sort()).toEqual(totalsRows.map((r) => r.location).sort());
  });

  it("the export respects the same Excel-style filter conditions as the movement endpoint", async () => {
    const conditions = encodeURIComponent(JSON.stringify([{ columnId: "farId", op: "equals", value: "XDEP-STILL" }]));
    const res = await authedInject(app, {
      method: "GET",
      url: `/api/reports/transfer-depreciation/export?conditions=${conditions}`
    });
    expect(res.statusCode).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.rawPayload as any);
    const sheet = workbook.worksheets[0]!;

    const farIds: string[] = [];
    let inTotalsBlock = false;
    sheet.eachRow((row, num) => {
      if (num <= 3) return;
      const first = row.getCell(1).value;
      if (first === "LOCATION TOTALS") inTotalsBlock = true;
      if (inTotalsBlock) return;
      if (first === null || first === undefined || first === "") return;
      farIds.push(String(first));
    });
    expect(farIds).toEqual(["XDEP-STILL"]);
  });
});

// Regression coverage for a real production incident (2026-08-29) that led to this
// restructure: the old three-sheet export's Location-wise Summary and Asset-wise
// Summary looked mismatched (16 assets/₹1.36L reading as "missing") purely because
// Asset-wise Summary showed one row per asset under its CURRENT location, while
// Location-wise Summary spread a mover's depreciation across every location it occupied
// — nothing was actually lost, but the two sheets' counts didn't line up at a glance.
// This single-sheet schedule has no second view to disagree with: every asset's own
// rows already sum to its full total, and the trailing Location Totals block is built
// from those same rows. This test proves that invariant holds at real scale (200+
// assets, not just the handful of XDEP- fixtures above).
describe("Asset Movement & Depreciation Schedule export — reconciliation at scale (200+ assets)", () => {
  let app: FastifyInstance;
  const ASSET_COUNT = 260;
  const assets = generateAssets(ASSET_COUNT, 55511);
  const transfers = generateTransfers(assets, 66622);

  beforeAll(async () => {
    const db = await getPool();
    await db.query(`DELETE FROM transfers`);
    await db.query(`DELETE FROM assets`);
    await db.query(
      `INSERT INTO settings (id, as_at, fy_start, fy_end, days_in_fy) VALUES (TRUE, $1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET as_at = $1, fy_start = $2, fy_end = $3, days_in_fy = $4`,
      [AS_AT, FY_START, FY_END, DAYS_IN_FY]
    );
    await bulkInsertAssets(db, assets, 1000);
    await bulkInsertTransfers(db, transfers, 1000);

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

  it("every asset appears (one row each, movers more), and the Location Totals block reconciles exactly — no asset silently missing", async () => {
    const res = await authedInject(app, { method: "GET", url: "/api/reports/transfer-depreciation/export" });
    expect(res.statusCode).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.rawPayload as any);
    const sheet = workbook.worksheets[0]!;

    const farIds = new Set<string>();
    const reconstructed = new Map<string, number>();
    const locationsByFarId = new Map<string, Set<string>>();
    let detailGrandTotalPaise = 0;
    let inTotalsBlock = false;
    const totalsRows: Array<{ location: string; count: number; totalPaise: number }> = [];
    sheet.eachRow((row, num) => {
      if (num <= 3) return;
      const first = row.getCell(1).value;
      if (first === null || first === undefined || first === "") return;
      if (first === "LOCATION TOTALS") {
        inTotalsBlock = true;
        return;
      }
      if (inTotalsBlock) {
        if (first === "Location" && row.getCell(2).value === "Asset Count") return;
        if (first === "Grand Total") return;
        totalsRows.push({
          location: String(first),
          count: Number(row.getCell(2).value),
          totalPaise: Math.round(Number(row.getCell(5).value) * 100)
        });
        return;
      }
      const farId = String(first);
      const location = String(row.getCell(4).value);
      const rowPaise = Math.round(Number(row.getCell(10).value) * 100);
      farIds.add(farId);
      detailGrandTotalPaise += rowPaise;
      reconstructed.set(location, (reconstructed.get(location) ?? 0) + rowPaise);
      const set = locationsByFarId.get(farId) ?? new Set<string>();
      set.add(location);
      locationsByFarId.set(farId, set);
    });
    // Confirms the export actually reached the scale this test is meant to exercise —
    // a regression that silently capped the batch loop, or that dropped never-moved
    // assets, would show up here directly as a farId count short of ASSET_COUNT.
    expect(farIds.size).toBe(ASSET_COUNT);

    const reconstructedCounts = new Map<string, number>();
    for (const [, locations] of locationsByFarId) {
      for (const loc of locations) reconstructedCounts.set(loc, (reconstructedCounts.get(loc) ?? 0) + 1);
    }

    expect(totalsRows.length).toBeGreaterThan(0);
    let totalsGrandTotalPaise = 0;
    for (const row of totalsRows) {
      expect(row.totalPaise).toBe(reconstructed.get(row.location) ?? -1);
      expect(row.count).toBe(reconstructedCounts.get(row.location) ?? -1);
      totalsGrandTotalPaise += row.totalPaise;
    }
    expect([...reconstructed.keys()].sort()).toEqual(totalsRows.map((r) => r.location).sort());
    expect(totalsGrandTotalPaise).toBe(detailGrandTotalPaise);
  });
});

// Finance FAR Dashboard — reuses far_calc_component/buildCalcCteExtras exactly like every
// report above; these tests cover the aggregation/exception SQL this route adds on top,
// not the calc math itself (already covered by sqlParity.test.ts and friends).
describe("Finance FAR Dashboard summary (GET /api/reports/dashboard-summary)", () => {
  let app: FastifyInstance;
  const fy = { asAt: AS_AT, fyStart: FY_START, fyEnd: FY_END, daysInFy: DAYS_IN_FY };

  // Ground truth for the totals test comes from computeAsset (engine.ts) — the same
  // independent JS implementation sqlParity.test.ts keeps in lock-step with the SQL
  // far_calc_component this route calls — rather than hand-deriving SLM math again here.
  const TOTALS_FIXTURES = [
    {
      far_id: "DASH-TOTALS-1",
      sub_classification: "Dashboard-Test-Totals",
      asset_description: "Totals fixture 1",
      serial_no: "DT1",
      qty: 1,
      useful_life_c1_years: 10,
      c1_opening_cost: 120000,
      additions_c1: 0,
      deletions_c1: 0,
      acc_dep_c1_opening: 24000,
      date_of_disposal: null,
      location: "Dash-Center-A"
    },
    {
      far_id: "DASH-TOTALS-2",
      sub_classification: "Dashboard-Test-Totals",
      asset_description: "Totals fixture 2",
      serial_no: "DT2",
      qty: 1,
      useful_life_c1_years: 8,
      c1_opening_cost: 64000,
      additions_c1: 0,
      deletions_c1: 0,
      acc_dep_c1_opening: 8000,
      date_of_disposal: null,
      location: "Dash-Center-A"
    },
    // qty: 2 (not 1, like the other two) so assetCount (3 rows) and qtyTotal (SUM(qty) =
    // 4) are provably different metrics, not coincidentally equal — see the dashboard's
    // own Asset Count tile, which shows both. A mid-year addition (after FY Start, before
    // AS_AT) gives openingGrossBlock/additionsFytd a real, non-zero split to assert
    // against too, rather than every fixture having zero additions.
    {
      far_id: "DASH-TOTALS-3",
      sub_classification: "Dashboard-Test-Totals",
      asset_description: "Totals fixture 3 (mid-year addition)",
      serial_no: "DT3",
      qty: 2,
      useful_life_c1_years: 10,
      c1_opening_cost: 50000,
      additions_c1: 30000,
      date_of_addition: "2026-06-01",
      deletions_c1: 0,
      acc_dep_c1_opening: 5000,
      date_of_disposal: null,
      location: "Dash-Center-A"
    }
  ];

  // FYTD vs since-inception disposal P&L reconciliation: one disposal inside this FY
  // (FY_START..AS_AT), one disposed in a PRIOR FY — both still "disposal-effective" as of
  // AS_AT (computeAsset/far_calc_component gate on date_of_disposal <= AS_AT, not FY
  // Start), so the FYTD figures must exclude the prior-FY one while the all-time figures
  // include both. This is exactly the export-reconciliation gap flagged against a real
  // Register export: the export's own Disposal P&L columns are all-time, not FYTD.
  const DISPOSAL_SCOPE_FIXTURES = [
    {
      far_id: "DASH-DISP-INFY",
      sub_classification: "Dashboard-Test-DisposalScope",
      asset_description: "In-FY disposal fixture",
      serial_no: "DDI",
      qty: 1,
      useful_life_c1_years: 10,
      c1_opening_cost: 100000,
      deletions_c1: 100000,
      acc_dep_c1_opening: 0,
      date_of_disposal: "2026-06-01", // within FY_START..AS_AT
      sale_value: 120000,
      location: "Dash-Center-A"
    },
    {
      far_id: "DASH-DISP-PRIORFY",
      sub_classification: "Dashboard-Test-DisposalScope",
      asset_description: "Prior-FY disposal fixture",
      serial_no: "DDP",
      qty: 1,
      useful_life_c1_years: 10,
      c1_opening_cost: 50000,
      deletions_c1: 50000,
      acc_dep_c1_opening: 0,
      date_of_disposal: "2025-01-01", // before FY_START — a prior financial year
      sale_value: 40000,
      location: "Dash-Center-A"
    }
  ];

  beforeAll(async () => {
    const db = await getPool();
    await db.query(
      `INSERT INTO settings (id, as_at, fy_start, fy_end, days_in_fy) VALUES (TRUE, $1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET as_at = $1, fy_start = $2, fy_end = $3, days_in_fy = $4`,
      [AS_AT, FY_START, FY_END, DAYS_IN_FY]
    );
    await db.query(`INSERT INTO centers (code) VALUES ('Dash-Center-A'), ('Dash-Center-B') ON CONFLICT (LOWER(code)) DO NOTHING`);

    for (const row of TOTALS_FIXTURES) await insertAsset(row);
    for (const row of DISPOSAL_SCOPE_FIXTURES) await insertAsset(row);

    // Center scoping: one asset at each of two centers, its own sub-classification so it
    // doesn't bleed into the totals test above.
    await insertAsset({
      far_id: "DASH-SCOPE-A",
      sub_classification: "Dashboard-Test-Scope",
      asset_description: "Scope fixture A",
      serial_no: "DSA",
      qty: 1,
      useful_life_c1_years: 5,
      c1_opening_cost: 10000,
      location: "Dash-Center-A"
    });
    await insertAsset({
      far_id: "DASH-SCOPE-B",
      sub_classification: "Dashboard-Test-Scope",
      asset_description: "Scope fixture B",
      serial_no: "DSB",
      qty: 1,
      useful_life_c1_years: 5,
      c1_opening_cost: 10000,
      location: "Dash-Center-B"
    });

    // Exceptions — a healthy control that must trip nothing, plus one fixture engineered
    // per category. All Active-status ones share useful_life_c2_years: 5 / c2_opening_cost:
    // 0 from BASE_ASSET, whose own expiry (date_acquired + 5y) is irrelevant here since a
    // zero-cost C2 never affects gross_block/nbv, only (harmlessly) the expiry GREATEST.
    await insertAsset({
      far_id: "DASH-HEALTHY",
      sub_classification: "Dashboard-Test-Exceptions",
      asset_description: "Healthy control",
      serial_no: "SN-HEALTHY",
      qty: 1,
      useful_life_c1_years: 10,
      c1_opening_cost: 50000,
      acc_dep_c1_opening: 5000,
      location: "Dash-Center-A"
    });
    // Negative NBV: Deletions recorded against a real (on/before AS_AT) disposal date,
    // exceeding the asset's own cost base — an over-stated Deletions/Sale entry. Status is
    // deliberately left "Active" (BASE_ASSET's default) — a genuine data inconsistency
    // this exception exists to surface, not something the app's own disposal flow would
    // produce on its own.
    await insertAsset({
      far_id: "DASH-NEGNBV",
      sub_classification: "Dashboard-Test-Exceptions",
      asset_description: "Negative NBV fixture",
      serial_no: "SN-NEG",
      qty: 1,
      useful_life_c1_years: 10,
      c1_opening_cost: 10000,
      date_of_disposal: "2026-05-01",
      deletions_c1: 50000,
      sale_value: 0,
      location: "Dash-Center-A"
    });
    // Fully depreciated but still Active: opening Acc Dep already equals opening cost, and
    // useful life has NOT yet expired (so this trips fullyDepreciatedActive only, not
    // pastUsefulLifeActive).
    await insertAsset({
      far_id: "DASH-FULLDEP",
      sub_classification: "Dashboard-Test-Exceptions",
      asset_description: "Fully depreciated fixture",
      serial_no: "SN-FULLDEP",
      qty: 1,
      useful_life_c1_years: 10,
      c1_opening_cost: 20000,
      acc_dep_c1_opening: 20000,
      location: "Dash-Center-A"
    });
    // Past useful life, still Active: acquired 2010, 5-year life on both components —
    // expired 2015, long before AS_AT. The engine's end-of-life taper sweeps any
    // remaining NBV to depreciation once useful life has fully elapsed, so this ALSO
    // trips fullyDepreciatedActive — a real, expected overlap (a past-life asset that's
    // still Active is, definitionally, also fully written down), not a fixture bug.
    await insertAsset({
      far_id: "DASH-PASTLIFE",
      sub_classification: "Dashboard-Test-Exceptions",
      asset_description: "Past useful life fixture",
      serial_no: "SN-PASTLIFE",
      qty: 1,
      date_acquired: "2010-01-01",
      useful_life_c1_years: 5,
      useful_life_c2_years: 5,
      c1_opening_cost: 5000,
      acc_dep_c1_opening: 2000,
      location: "Dash-Center-A"
    });
    // Big disposal swing: sale value far exceeds WDV at disposal (a large gain), within
    // this FY, well past the ₹1L threshold.
    await insertAsset({
      far_id: "DASH-BIGSWING",
      sub_classification: "Dashboard-Test-Exceptions",
      asset_description: "Big disposal swing fixture",
      serial_no: "SN-BIGSWING",
      status: "Disposed",
      qty: 1,
      useful_life_c1_years: 10,
      c1_opening_cost: 200000,
      date_of_disposal: "2026-05-01",
      deletions_c1: 200000,
      sale_value: 350000,
      location: "Dash-Center-A"
    });
    // Small disposal swing: same shape, well under the ₹1L threshold — must NOT appear.
    await insertAsset({
      far_id: "DASH-SMALLSWING",
      sub_classification: "Dashboard-Test-Exceptions",
      asset_description: "Small disposal swing fixture",
      serial_no: "SN-SMALLSWING",
      status: "Disposed",
      qty: 1,
      useful_life_c1_years: 10,
      c1_opening_cost: 20000,
      date_of_disposal: "2026-05-01",
      deletions_c1: 20000,
      sale_value: 21000,
      location: "Dash-Center-A"
    });
    // Missing data: no serial number.
    await insertAsset({
      far_id: "DASH-MISSING",
      sub_classification: "Dashboard-Test-Exceptions",
      asset_description: "Missing data fixture",
      serial_no: null,
      qty: 1,
      useful_life_c1_years: 10,
      c1_opening_cost: 15000,
      location: "Dash-Center-A"
    });

    app = Fastify();
    app.decorateRequest("user", null);
    app.addHook("preHandler", authGateHook);
    await app.register(cookie);
    await app.register(reportsRoutes);
    // Also registered here (not just reportsRoutes) so the exceptions test below can
    // prove dashboard-summary's count and GET /api/assets?exception=<key>'s row set are
    // the exact same answer — the property that actually matters, not two independently
    // "look right" assertions against two separately-maintained queries.
    await app.register(assetsRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("totals match a hand-computed sum from the independent engine.ts implementation", async () => {
    let expectedGrossBlock = 0;
    let expectedClosingAccDep = 0;
    let expectedNbv = 0;
    let expectedOpeningGrossBlock = 0;
    let expectedAdditionsFytd = 0;
    let expectedQtyTotal = 0;
    for (const row of TOTALS_FIXTURES) {
      const result = computeAsset(mapAssetRow({ ...BASE_ASSET, ...row } as AssetRow), fy, []);
      expectedGrossBlock += result.c1.grossBlock + result.c2.grossBlock;
      expectedClosingAccDep += result.c1.closingAccDep + result.c2.closingAccDep;
      expectedNbv += result.c1.nbv + result.c2.nbv;
      expectedOpeningGrossBlock += result.c1.openingGrossBlock + result.c2.openingGrossBlock;
      expectedAdditionsFytd += result.c1.additionsGrossBlock + result.c2.additionsGrossBlock;
      expectedQtyTotal += row.qty;
    }

    const res = await authedInject(app, {
      method: "GET",
      url: `/api/reports/dashboard-summary?${new URLSearchParams({ asAt: AS_AT, subClassification: "Dashboard-Test-Totals" })}`
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totals.assetCount).toBe(3);
    expect(body.totals.grossBlock).toBeCloseTo(expectedGrossBlock, 2);
    expect(body.totals.closingAccDep).toBeCloseTo(expectedClosingAccDep, 2);
    expect(body.totals.nbv).toBeCloseTo(expectedNbv, 2);
    // qtyTotal (4: 1+1+2) provably differs from assetCount (3 rows) — the two metrics
    // the dashboard's Asset Count tile shows side by side, per its own comment.
    expect(body.totals.qtyTotal).toBe(4);
    expect(expectedQtyTotal).toBe(4);
    expect(body.totals.openingGrossBlock).toBeCloseTo(expectedOpeningGrossBlock, 2);
    expect(body.totals.additionsFytd).toBeCloseTo(expectedAdditionsFytd, 2);
    expect(expectedAdditionsFytd).toBeGreaterThan(0); // proves the mid-year-addition fixture actually exercised this path
  });

  it("disposal P&L: FYTD excludes a prior-FY disposal that since-inception (allTime) still includes", async () => {
    const inFyFixture = DISPOSAL_SCOPE_FIXTURES[0]!;
    const priorFyFixture = DISPOSAL_SCOPE_FIXTURES[1]!;
    const inFy = computeAsset(mapAssetRow({ ...BASE_ASSET, ...inFyFixture } as AssetRow), fy, []);
    const priorFy = computeAsset(mapAssetRow({ ...BASE_ASSET, ...priorFyFixture } as AssetRow), fy, []);
    // Ground truth mirrors assetColumnFilters.ts's TOTAL_WDV_AND_PROFIT_LOSS_SQL: one
    // combined profit_loss per asset (sale_value minus the SUM of both components' WDV),
    // not each component's own profitLossOnDisposal summed — that per-component field
    // independently subtracts the asset's full sale_value from each side, which would
    // double-count it here. This is exactly what disposalPL.gains/losses filter on.
    const inFyPL = inFyFixture.sale_value - (inFy.c1.wdvAtDisposal! + inFy.c2.wdvAtDisposal!);
    const priorFyPL = priorFyFixture.sale_value - (priorFy.c1.wdvAtDisposal! + priorFy.c2.wdvAtDisposal!);

    const res = await authedInject(app, {
      method: "GET",
      url: `/api/reports/dashboard-summary?${new URLSearchParams({ asAt: AS_AT, subClassification: "Dashboard-Test-DisposalScope" })}`
    });
    expect(res.statusCode).toBe(200);
    const { disposalPL } = res.json();

    // FYTD: only the in-FY disposal.
    expect(disposalPL.disposalCount).toBe(1);
    expect(disposalPL.totalDeletions).toBeCloseTo(100000, 2);
    expect(disposalPL.saleProceeds).toBeCloseTo(120000, 2);
    if (inFyPL >= 0) {
      expect(disposalPL.gains).toBeCloseTo(inFyPL, 2);
      expect(disposalPL.losses).toBe(0);
    } else {
      expect(disposalPL.losses).toBeCloseTo(inFyPL, 2);
      expect(disposalPL.gains).toBe(0);
    }

    // Since inception (allTime): both disposals, including the prior-FY one.
    expect(disposalPL.allTime.disposalCount).toBe(2);
    const expectedAllTimeGains = (inFyPL > 0 ? inFyPL : 0) + (priorFyPL > 0 ? priorFyPL : 0);
    const expectedAllTimeLosses = (inFyPL < 0 ? inFyPL : 0) + (priorFyPL < 0 ? priorFyPL : 0);
    expect(disposalPL.allTime.gains).toBeCloseTo(expectedAllTimeGains, 2);
    expect(disposalPL.allTime.losses).toBeCloseTo(expectedAllTimeLosses, 2);
    // The prior-FY disposal is the entire reason allTime and FYTD diverge here — assert
    // that split is real, not a fixture that happened to net to the same number.
    expect(disposalPL.allTime.disposalCount).not.toBe(disposalPL.disposalCount);
  });

  it("center scoping narrows totals to the user's own centers", async () => {
    const scopedUser = await createTestUser({ username: "dash-scope-user", role: "editor", centerAccess: ["Dash-Center-A"] });
    const scopedRes = await app.inject({
      method: "GET",
      url: `/api/reports/dashboard-summary?${new URLSearchParams({ asAt: AS_AT, subClassification: "Dashboard-Test-Scope" })}`,
      headers: { cookie: authHeaderFor(scopedUser.id, scopedUser.username) }
    });
    expect(scopedRes.statusCode).toBe(200);
    const scopedBody = scopedRes.json();
    expect(scopedBody.totals.assetCount).toBe(1);

    const unscopedRes = await authedInject(app, {
      method: "GET",
      url: `/api/reports/dashboard-summary?${new URLSearchParams({ asAt: AS_AT, subClassification: "Dashboard-Test-Scope" })}`
    });
    expect(unscopedRes.json().totals.assetCount).toBe(2);
  });

  it("each exception category's dashboard-summary count matches exactly the fixture rows engineered to trip it, and none of the ones that shouldn't", async () => {
    const res = await authedInject(app, {
      method: "GET",
      url: `/api/reports/dashboard-summary?${new URLSearchParams({ asAt: AS_AT, subClassification: "Dashboard-Test-Exceptions" })}`
    });
    expect(res.statusCode).toBe(200);
    const { exceptions } = res.json();

    expect(exceptions.negativeNbv.count).toBe(1);
    // See the DASH-PASTLIFE fixture comment above: past-useful-life-but-Active assets are
    // expected to also show up here, ordered by Gross Block descending.
    expect(exceptions.fullyDepreciatedActive.count).toBe(2);
    expect(exceptions.pastUsefulLifeActive.count).toBe(1);
    expect(exceptions.bigDisposalSwings.count).toBe(1);
    expect(exceptions.missingData.count).toBe(1);
  });

  // The property that actually matters (Part A of the drill-through rework): a
  // dashboard tile's count and Register's own row count/FAR-ID set for the same
  // `exception` key must be the exact same answer, because both are now computed by the
  // one shared predicate in exceptionPredicates.ts — not two independently-maintained
  // queries that could silently drift apart.
  it("GET /api/assets?exception=<key> returns exactly the rows dashboard-summary counted, for every category", async () => {
    const EXPECTED: Record<string, string[]> = {
      negativeNbv: ["DASH-NEGNBV"],
      fullyDepreciatedActive: ["DASH-FULLDEP", "DASH-PASTLIFE"],
      pastUsefulLifeActive: ["DASH-PASTLIFE"],
      bigDisposalSwings: ["DASH-BIGSWING"],
      missingData: ["DASH-MISSING"]
    };

    const summaryRes = await authedInject(app, {
      method: "GET",
      url: `/api/reports/dashboard-summary?${new URLSearchParams({ asAt: AS_AT, subClassification: "Dashboard-Test-Exceptions" })}`
    });
    const { exceptions } = summaryRes.json();

    for (const [key, expectedFarIds] of Object.entries(EXPECTED)) {
      const registerRes = await authedInject(app, {
        method: "GET",
        url: `/api/assets?${new URLSearchParams({ asAt: AS_AT, subClassification: "Dashboard-Test-Exceptions", exception: key, includeTotal: "true" })}`
      });
      expect(registerRes.statusCode).toBe(200);
      const body = registerRes.json();
      const farIds = body.items.map((i: { asset: { farId: string } }) => i.asset.farId).sort();

      // Same count dashboard-summary reported for this key...
      expect(exceptions[key].count).toBe(expectedFarIds.length);
      // ...and Register's own total/row set agrees exactly — not just "looks similar".
      expect(body.total).toBe(expectedFarIds.length);
      expect(farIds).toEqual([...expectedFarIds].sort());
    }
  });
});
