import Fastify, { type FastifyInstance } from "fastify";
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
      useful_life_c1_years: 5,
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

    app = Fastify();
    await app.register(reportsRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
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
