import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import assetsRoutes from "./assets.js";
import { getPool } from "../db/pool.js";
import { authedInject } from "../testHelpers/authTestUtils.js";
import { authGateHook } from "../auth/middleware.js";

const NEW_ASSET = {
  farId: "CAP-TEST-1",
  subClassification: "Test-Sub",
  assetDescription: "Capitalization Test Asset",
  status: "Active",
  dateAcquired: "2026-01-01",
  location: "Center-Test",
  usefulLifeC1Years: 5,
  usefulLifeC2Years: 5,
  c1OpeningCost: 10000,
  c2OpeningCost: 10000
};

// POST /api/assets now validates status/subClassification/location against the active
// Masters lists (routes/masters.ts) — seed the ones these fixtures use.
async function seedMasters() {
  const db = await getPool();
  await db.query(`DELETE FROM centers`);
  await db.query(`DELETE FROM sub_classifications`);
  await db.query(`DELETE FROM statuses`);
  await db.query(`INSERT INTO centers (code) VALUES ('Center-Test')`);
  await db.query(`INSERT INTO sub_classifications (name) VALUES ('Test-Sub')`);
  await db.query(`INSERT INTO statuses (name, system_managed) VALUES ('Active', FALSE), ('Disposed', TRUE)`);
}

describe("Capitalization: POST /api/assets", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    app.decorateRequest("user", null);
    app.addHook("preHandler", authGateHook);
    await app.register(cookie);
    await app.register(assetsRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const db = await getPool();
    await db.query(`DELETE FROM transfers`);
    await db.query(`DELETE FROM assets`);
    await seedMasters();
    await db.query(
      `INSERT INTO settings (id, as_at, fy_start, fy_end, days_in_fy) VALUES (TRUE, '2026-08-17', '2026-04-01', '2027-03-31', 365)
       ON CONFLICT (id) DO UPDATE SET as_at = '2026-08-17', fy_start = '2026-04-01', fy_end = '2027-03-31', days_in_fy = 365`
    );
  });

  it("creates a new asset and it appears in the register", async () => {
    const create = await authedInject(app, { method: "POST", url: "/api/assets", payload: NEW_ASSET });
    expect(create.statusCode).toBe(200);
    expect(create.json()).toEqual({ farId: "CAP-TEST-1", created: true });

    const list = await authedInject(app, { method: "GET", url: "/api/assets?asAt=2026-08-17" });
    const items = list.json().items;
    expect(items.some((i: { asset: { farId: string } }) => i.asset.farId === "CAP-TEST-1")).toBe(true);
  });

  it("rejects a duplicate FAR ID", async () => {
    await authedInject(app, { method: "POST", url: "/api/assets", payload: NEW_ASSET });
    const dup = await authedInject(app, { method: "POST", url: "/api/assets", payload: NEW_ASSET });
    expect(dup.statusCode).toBe(409);
  });

  it("rejects a FAR ID containing lowercase letters", async () => {
    const res = await authedInject(app, {
      method: "POST",
      url: "/api/assets",
      payload: { ...NEW_ASSET, farId: "Temp1234" }
    });
    expect(res.statusCode).toBe(400);
  });

  it("accepts a real-world FAR ID mixing letters, digits, and hyphens", async () => {
    const res = await authedInject(app, {
      method: "POST",
      url: "/api/assets",
      payload: { ...NEW_ASSET, farId: "616-PB-BTI-GNR-C" }
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects a payload missing required fields", async () => {
    const res = await authedInject(app, {
      method: "POST",
      url: "/api/assets",
      payload: { farId: "CAP-BAD-1" }
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a status/subClassification/location that isn't in the active Masters lists", async () => {
    const res = await authedInject(app, {
      method: "POST",
      url: "/api/assets",
      payload: { ...NEW_ASSET, farId: "CAP-UNKNOWN", subClassification: "Not A Real Sub" }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Sub Classification "Not A Real Sub" not recognized/);
  });

  it("rejects capitalizing a brand-new asset directly as a system-managed status (Disposed)", async () => {
    const res = await authedInject(app, {
      method: "POST",
      url: "/api/assets",
      payload: { ...NEW_ASSET, farId: "CAP-DISPOSED", status: "Disposed" }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/can only be set through the Disposal flow/);
  });

  it("matches a master value case-insensitively but stores the canonical casing", async () => {
    const res = await authedInject(app, {
      method: "POST",
      url: "/api/assets",
      payload: { ...NEW_ASSET, farId: "CAP-CASING", subClassification: "test-sub", status: "active", location: "center-test" }
    });
    expect(res.statusCode).toBe(200);

    const db = await getPool();
    const { rows } = await db.query(`SELECT sub_classification, status, location FROM assets WHERE far_id = 'CAP-CASING'`);
    expect(rows[0]).toEqual({ sub_classification: "Test-Sub", status: "Active", location: "Center-Test" });
  });

  it("rejects additions with no dateOfAddition (would silently never depreciate)", async () => {
    const res = await authedInject(app, {
      method: "POST",
      url: "/api/assets",
      payload: { ...NEW_ASSET, farId: "CAP-BAD-2", additionsC1: 5000 }
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a dateOfAddition with zero additions", async () => {
    const res = await authedInject(app, {
      method: "POST",
      url: "/api/assets",
      payload: { ...NEW_ASSET, farId: "CAP-BAD-3", dateOfAddition: "2026-05-01" }
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("Edit: PATCH /api/assets/:farId", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    app.decorateRequest("user", null);
    app.addHook("preHandler", authGateHook);
    await app.register(cookie);
    await app.register(assetsRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const db = await getPool();
    await db.query(`DELETE FROM transfers`);
    await db.query(`DELETE FROM assets`);
    await seedMasters();
    await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, farId: "EDIT-TEST-1" } });
  });

  it("updates Serial No, Useful Life, and Opening Acc Dep", async () => {
    const res = await authedInject(app, {
      method: "PATCH",
      url: "/api/assets/EDIT-TEST-1",
      payload: { serialNo: "SN-NEW-1", usefulLifeC1Years: 8, usefulLifeC2Years: 6, accDepC1Opening: 1500, accDepC2Opening: 500 }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ farId: "EDIT-TEST-1", updated: true });

    const db = await getPool();
    const { rows } = await db.query(
      `SELECT serial_no, useful_life_c1_years, useful_life_c2_years, acc_dep_c1_opening, acc_dep_c2_opening FROM assets WHERE far_id = 'EDIT-TEST-1'`
    );
    expect(rows[0].serial_no).toBe("SN-NEW-1");
    expect(Number(rows[0].useful_life_c1_years)).toBe(8);
    expect(Number(rows[0].useful_life_c2_years)).toBe(6);
    expect(Number(rows[0].acc_dep_c1_opening)).toBe(1500);
    expect(Number(rows[0].acc_dep_c2_opening)).toBe(500);
  });

  it("does not touch FAR ID, Date Acquired, Location, Status, cost, or additions fields", async () => {
    await authedInject(app, {
      method: "PATCH",
      url: "/api/assets/EDIT-TEST-1",
      payload: { serialNo: "SN-2", usefulLifeC1Years: 9, usefulLifeC2Years: 9, accDepC1Opening: 0, accDepC2Opening: 0 }
    });

    const db = await getPool();
    const { rows } = await db.query(
      `SELECT far_id, date_acquired, location, status, sub_classification, c1_opening_cost, c2_opening_cost, additions_c1, additions_c2
       FROM assets WHERE far_id = 'EDIT-TEST-1'`
    );
    expect(rows[0].far_id).toBe("EDIT-TEST-1");
    expect(String(rows[0].date_acquired)).toMatch(/^2026-01-01/);
    expect(rows[0].location).toBe("Center-Test");
    expect(rows[0].status).toBe("Active");
    expect(rows[0].sub_classification).toBe("Test-Sub");
    expect(Number(rows[0].c1_opening_cost)).toBe(10000);
    expect(Number(rows[0].c2_opening_cost)).toBe(10000);
    expect(Number(rows[0].additions_c1)).toBe(0);
    expect(Number(rows[0].additions_c2)).toBe(0);
  });

  it("rejects negative Useful Life or Opening Acc Dep", async () => {
    const res = await authedInject(app, {
      method: "PATCH",
      url: "/api/assets/EDIT-TEST-1",
      payload: { serialNo: "", usefulLifeC1Years: -1, usefulLifeC2Years: 5, accDepC1Opening: 0, accDepC2Opening: 0 }
    });
    expect(res.statusCode).toBe(400);
  });

  it("404s for an unknown FAR ID", async () => {
    const res = await authedInject(app, {
      method: "PATCH",
      url: "/api/assets/NOT-REAL",
      payload: { serialNo: "", usefulLifeC1Years: 5, usefulLifeC2Years: 5, accDepC1Opening: 0, accDepC2Opening: 0 }
    });
    expect(res.statusCode).toBe(404);
  });

  it("409s for an already-disposed asset — historical figures stay locked", async () => {
    await authedInject(app, {
      method: "PATCH",
      url: "/api/assets/EDIT-TEST-1/disposal",
      payload: { dateOfDisposal: "2026-06-01", saleValue: 100 }
    });
    const res = await authedInject(app, {
      method: "PATCH",
      url: "/api/assets/EDIT-TEST-1",
      payload: { serialNo: "SN-3", usefulLifeC1Years: 5, usefulLifeC2Years: 5, accDepC1Opening: 0, accDepC2Opening: 0 }
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/disposed/);
  });
});

describe("Addition: PATCH /api/assets/:farId/addition", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    app.decorateRequest("user", null);
    app.addHook("preHandler", authGateHook);
    await app.register(cookie);
    await app.register(assetsRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const db = await getPool();
    await db.query(`DELETE FROM transfers`);
    await db.query(`DELETE FROM assets`);
    await seedMasters();
    await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, farId: "ADD-TEST-1" } });
  });

  it("records an addition, matching the same columns Capitalization's own Mid-Year Additions section writes", async () => {
    const res = await authedInject(app, {
      method: "PATCH",
      url: "/api/assets/ADD-TEST-1/addition",
      payload: { additionsC1: 400000, additionsC2: 100000, dateOfAddition: "2026-05-01" }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ farId: "ADD-TEST-1", added: true });

    const db = await getPool();
    const { rows } = await db.query(
      `SELECT additions_c1, additions_c2, date_of_addition FROM assets WHERE far_id = 'ADD-TEST-1'`
    );
    expect(Number(rows[0].additions_c1)).toBe(400000);
    expect(Number(rows[0].additions_c2)).toBe(100000);
    expect(String(rows[0].date_of_addition)).toMatch(/^2026-05-01/);
  });

  it("rejects a second addition on the same asset (one-addition-per-asset limit)", async () => {
    await authedInject(app, {
      method: "PATCH",
      url: "/api/assets/ADD-TEST-1/addition",
      payload: { additionsC1: 400000, additionsC2: 0, dateOfAddition: "2026-05-01" }
    });
    const res = await authedInject(app, {
      method: "PATCH",
      url: "/api/assets/ADD-TEST-1/addition",
      payload: { additionsC1: 50000, additionsC2: 0, dateOfAddition: "2026-07-01" }
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/already has an addition recorded/);

    // The first addition's values are unchanged — the second request never wrote anything.
    const db = await getPool();
    const { rows } = await db.query(`SELECT additions_c1 FROM assets WHERE far_id = 'ADD-TEST-1'`);
    expect(Number(rows[0].additions_c1)).toBe(400000);
  });

  it("rejects both additionsC1 and additionsC2 being zero", async () => {
    const res = await authedInject(app, {
      method: "PATCH",
      url: "/api/assets/ADD-TEST-1/addition",
      payload: { additionsC1: 0, additionsC2: 0, dateOfAddition: "2026-05-01" }
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an addition dated before the asset's capitalization date", async () => {
    const res = await authedInject(app, {
      method: "PATCH",
      url: "/api/assets/ADD-TEST-1/addition",
      payload: { additionsC1: 1000, additionsC2: 0, dateOfAddition: "2025-06-01" }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/cannot be before the asset's capitalization date/);
  });

  it("rejects an addition on an already-disposed asset", async () => {
    await authedInject(app, {
      method: "PATCH",
      url: "/api/assets/ADD-TEST-1/disposal",
      payload: { dateOfDisposal: "2026-06-01", saleValue: 100 }
    });
    const res = await authedInject(app, {
      method: "PATCH",
      url: "/api/assets/ADD-TEST-1/addition",
      payload: { additionsC1: 1000, additionsC2: 0, dateOfAddition: "2026-07-01" }
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/disposed/);
  });

  it("404s for an unknown FAR ID", async () => {
    const res = await authedInject(app, {
      method: "PATCH",
      url: "/api/assets/NOT-REAL/addition",
      payload: { additionsC1: 1000, additionsC2: 0, dateOfAddition: "2026-05-01" }
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("Disposal: PATCH /api/assets/:farId/disposal", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    app.decorateRequest("user", null);
    app.addHook("preHandler", authGateHook);
    await app.register(cookie);
    await app.register(assetsRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const db = await getPool();
    await db.query(`DELETE FROM transfers`);
    await db.query(`DELETE FROM assets`);
    await seedMasters();
    await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, farId: "DISP-TEST-1" } });
  });

  it("fully disposes an asset: deletions become the full capitalized cost", async () => {
    const res = await authedInject(app, {
      method: "PATCH",
      url: "/api/assets/DISP-TEST-1/disposal",
      payload: { dateOfDisposal: "2026-08-01", saleValue: 500 }
    });
    expect(res.statusCode).toBe(200);

    const db = await getPool();
    const { rows } = await db.query(
      `SELECT date_of_disposal, deletions_c1, deletions_c2, sale_value, status FROM assets WHERE far_id = 'DISP-TEST-1'`
    );
    expect(rows[0].deletions_c1).toBe("10000");
    expect(rows[0].deletions_c2).toBe("10000");
    expect(Number(rows[0].sale_value)).toBe(500);
    expect(rows[0].status).toBe("Disposed");
  });

  it("does not alter the permanent capitalization record: opening cost, additions, and opening acc dep are untouched by disposal", async () => {
    // Deliberately non-zero/non-default values on every field a disposal must never
    // write, so this test would actually fail if disposal started zeroing them —
    // asserting "still 0" wouldn't prove anything.
    await authedInject(app, {
      method: "POST",
      url: "/api/assets",
      payload: {
        ...NEW_ASSET,
        farId: "DISP-HISTORY-1",
        c1OpeningCost: 75000,
        c2OpeningCost: 45000,
        additionsC1: 8000,
        additionsC2: 3000,
        dateOfAddition: "2026-05-01",
        accDepC1Opening: 12000,
        accDepC2Opening: 6000
      }
    });

    const res = await authedInject(app, {
      method: "PATCH",
      url: "/api/assets/DISP-HISTORY-1/disposal",
      payload: { dateOfDisposal: "2026-08-01", saleValue: 20000 }
    });
    expect(res.statusCode).toBe(200);

    const db = await getPool();
    const { rows } = await db.query(
      `SELECT c1_opening_cost, c2_opening_cost, additions_c1, additions_c2, date_of_addition,
              acc_dep_c1_opening, acc_dep_c2_opening, useful_life_c1_years, useful_life_c2_years,
              date_acquired
       FROM assets WHERE far_id = 'DISP-HISTORY-1'`
    );
    const row = rows[0];
    expect(Number(row.c1_opening_cost)).toBe(75000);
    expect(Number(row.c2_opening_cost)).toBe(45000);
    expect(Number(row.additions_c1)).toBe(8000);
    expect(Number(row.additions_c2)).toBe(3000);
    expect(String(row.date_of_addition)).toMatch(/^2026-05-01/);
    expect(Number(row.acc_dep_c1_opening)).toBe(12000);
    expect(Number(row.acc_dep_c2_opening)).toBe(6000);
    expect(Number(row.useful_life_c1_years)).toBe(NEW_ASSET.usefulLifeC1Years);
    expect(Number(row.useful_life_c2_years)).toBe(NEW_ASSET.usefulLifeC2Years);
    expect(String(row.date_acquired)).toMatch(new RegExp(`^${NEW_ASSET.dateAcquired}`));
  });

  it("rejects a disposal dated before the asset's capitalization date", async () => {
    const res = await authedInject(app, {
      method: "PATCH",
      url: "/api/assets/DISP-TEST-1/disposal",
      payload: { dateOfDisposal: "2025-12-31", saleValue: 0 }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Disposal date cannot be before the asset's capitalization date \(01-01-2026\)/);

    const db = await getPool();
    const { rows } = await db.query(`SELECT date_of_disposal, status FROM assets WHERE far_id = 'DISP-TEST-1'`);
    expect(rows[0].date_of_disposal).toBeNull();
    expect(rows[0].status).toBe("Active");
  });

  it("allows a disposal dated exactly on the asset's capitalization date (boundary is >=, not >)", async () => {
    const res = await authedInject(app, {
      method: "PATCH",
      url: "/api/assets/DISP-TEST-1/disposal",
      payload: { dateOfDisposal: "2026-01-01", saleValue: 0 }
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects disposing the same asset twice", async () => {
    await authedInject(app, {
      method: "PATCH",
      url: "/api/assets/DISP-TEST-1/disposal",
      payload: { dateOfDisposal: "2026-08-01", saleValue: 500 }
    });
    const second = await authedInject(app, {
      method: "PATCH",
      url: "/api/assets/DISP-TEST-1/disposal",
      payload: { dateOfDisposal: "2026-08-05", saleValue: 100 }
    });
    expect(second.statusCode).toBe(409);
  });

  it("404s for an unknown FAR ID", async () => {
    const res = await authedInject(app, {
      method: "PATCH",
      url: "/api/assets/DOES-NOT-EXIST/disposal",
      payload: { dateOfDisposal: "2026-08-01", saleValue: 0 }
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("Disposal preview: POST /api/assets/:farId/disposal/preview", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    app.decorateRequest("user", null);
    app.addHook("preHandler", authGateHook);
    await app.register(cookie);
    await app.register(assetsRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const db = await getPool();
    await db.query(`DELETE FROM transfers`);
    await db.query(`DELETE FROM assets`);
    await seedMasters();
    await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, farId: "PREV-TEST-1" } });
  });

  it("computes real WDV/Profit-Loss for the chosen Disposal Date without writing anything", async () => {
    const preview = await authedInject(app, {
      method: "POST",
      url: "/api/assets/PREV-TEST-1/disposal/preview",
      payload: { dateOfDisposal: "2026-08-01", saleValue: 9000 }
    });
    expect(preview.statusCode).toBe(200);
    const body = preview.json();
    // Full write-off: deletions = 10000 (C1) + 10000 (C2) opening cost, both components.
    // Depreciation accrues from FY Start (2026-04-01) to the disposal date (2026-08-01)
    // — the preview isn't a rough "today's NBV" estimate, it's the actual formula.
    expect(body.c1Wdv).toBeGreaterThan(0);
    expect(body.c1Wdv).toBeLessThan(10000);
    expect(body.totalWdv).toBeCloseTo(body.c1Wdv + body.c2Wdv, 6);
    // saleValue counted once against the combined WDV, not once per component (that
    // would double-count saleValue) — see assetProfitLossOnDisposal's doc comment.
    expect(body.profitLoss).toBeCloseTo(9000 - (body.c1Wdv + body.c2Wdv), 6);

    const db = await getPool();
    const { rows } = await db.query(
      `SELECT date_of_disposal, deletions_c1, status FROM assets WHERE far_id = 'PREV-TEST-1'`
    );
    expect(rows[0].date_of_disposal).toBeNull();
    expect(Number(rows[0].deletions_c1)).toBe(0);
    expect(rows[0].status).toBe("Active");
  });

  it("rejects a preview dated before the asset's capitalization date", async () => {
    const res = await authedInject(app, {
      method: "POST",
      url: "/api/assets/PREV-TEST-1/disposal/preview",
      payload: { dateOfDisposal: "2025-12-31", saleValue: 0 }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Disposal date cannot be before the asset's capitalization date \(01-01-2026\)/);
  });

  it("allows a preview dated exactly on the asset's capitalization date (boundary is >=, not >)", async () => {
    const res = await authedInject(app, {
      method: "POST",
      url: "/api/assets/PREV-TEST-1/disposal/preview",
      payload: { dateOfDisposal: "2026-01-01", saleValue: 0 }
    });
    expect(res.statusCode).toBe(200);
  });

  it("matches what actually confirming the disposal on that same date produces", async () => {
    const preview = await authedInject(app, {
      method: "POST",
      url: "/api/assets/PREV-TEST-1/disposal/preview",
      payload: { dateOfDisposal: "2026-08-01", saleValue: 9000 }
    });
    const previewBody = preview.json();

    await authedInject(app, {
      method: "PATCH",
      url: "/api/assets/PREV-TEST-1/disposal",
      payload: { dateOfDisposal: "2026-08-01", saleValue: 9000 }
    });
    const detail = await authedInject(app, { method: "GET", url: "/api/assets/PREV-TEST-1?asAt=2026-08-01" });
    const result = detail.json().result;

    expect(previewBody.c1Wdv).toBeCloseTo(result.c1.wdvAtDisposal, 6);
    expect(previewBody.c2Wdv).toBeCloseTo(result.c2.wdvAtDisposal, 6);
    expect(previewBody.profitLoss).toBeCloseTo(result.assetProfitLossOnDisposal, 6);
  });

  it("404s for an unknown FAR ID", async () => {
    const res = await authedInject(app, {
      method: "POST",
      url: "/api/assets/DOES-NOT-EXIST/disposal/preview",
      payload: { dateOfDisposal: "2026-08-01", saleValue: 0 }
    });
    expect(res.statusCode).toBe(404);
  });

  it("409s for an asset that's already disposed", async () => {
    await authedInject(app, {
      method: "PATCH",
      url: "/api/assets/PREV-TEST-1/disposal",
      payload: { dateOfDisposal: "2026-08-01", saleValue: 500 }
    });
    const res = await authedInject(app, {
      method: "POST",
      url: "/api/assets/PREV-TEST-1/disposal/preview",
      payload: { dateOfDisposal: "2026-08-05", saleValue: 0 }
    });
    expect(res.statusCode).toBe(409);
  });
});
