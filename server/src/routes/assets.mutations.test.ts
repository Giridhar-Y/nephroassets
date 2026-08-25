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

  describe("Parent linking at creation", () => {
    beforeEach(async () => {
      await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, farId: "CAP-PARENT-1" } });
    });

    it("creates a new asset already linked to an existing parent", async () => {
      const res = await authedInject(app, {
        method: "POST",
        url: "/api/assets",
        payload: { ...NEW_ASSET, farId: "CAP-CHILD-1", parentFarId: "CAP-PARENT-1" }
      });
      expect(res.statusCode).toBe(200);

      const db = await getPool();
      const { rows } = await db.query(`SELECT parent_far_id FROM assets WHERE far_id = 'CAP-CHILD-1'`);
      expect(rows[0].parent_far_id).toBe("CAP-PARENT-1");
    });

    it("does not create the asset at all when the chosen parent is invalid (disposed)", async () => {
      await authedInject(app, {
        method: "PATCH",
        url: "/api/assets/CAP-PARENT-1/disposal",
        payload: { dateOfDisposal: "2026-06-01", saleValue: 0 }
      });
      const res = await authedInject(app, {
        method: "POST",
        url: "/api/assets",
        payload: { ...NEW_ASSET, farId: "CAP-CHILD-2", parentFarId: "CAP-PARENT-1" }
      });
      expect(res.statusCode).toBe(409);

      const db = await getPool();
      const { rows } = await db.query(`SELECT 1 FROM assets WHERE far_id = 'CAP-CHILD-2'`);
      expect(rows).toHaveLength(0);
    });

    it("rejects a brand-new asset naming itself as its own parent", async () => {
      const res = await authedInject(app, {
        method: "POST",
        url: "/api/assets",
        payload: { ...NEW_ASSET, farId: "CAP-SELF-PARENT", parentFarId: "CAP-SELF-PARENT" }
      });
      expect(res.statusCode).toBe(400);
    });
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

  const baseEdit = {
    farId: "EDIT-TEST-1",
    subClassification: "Test-Sub",
    assetDescription: "Capitalization Test Asset",
    serialNo: "",
    usefulLifeC1Years: 5,
    usefulLifeC2Years: 5,
    accDepC1Opening: 0,
    accDepC2Opening: 0,
    parentFarId: null as string | null
  };

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
      payload: { ...baseEdit, serialNo: "SN-NEW-1", usefulLifeC1Years: 8, usefulLifeC2Years: 6, accDepC1Opening: 1500, accDepC2Opening: 500 }
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

  it("updates FAR ID, Sub Classification, and Asset Description", async () => {
    const db0 = await getPool();
    await db0.query(`INSERT INTO sub_classifications (name) VALUES ('Second-Sub')`);
    const res = await authedInject(app, {
      method: "PATCH",
      url: "/api/assets/EDIT-TEST-1",
      payload: { ...baseEdit, farId: "EDIT-RENAMED-1", subClassification: "Second-Sub", assetDescription: "Renamed Description" }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ farId: "EDIT-RENAMED-1", updated: true });

    const db = await getPool();
    const { rows } = await db.query(
      `SELECT far_id, sub_classification, asset_description FROM assets WHERE far_id = 'EDIT-RENAMED-1'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].sub_classification).toBe("Second-Sub");
    expect(rows[0].asset_description).toBe("Renamed Description");

    const old = await db.query(`SELECT 1 FROM assets WHERE far_id = 'EDIT-TEST-1'`);
    expect(old.rows).toHaveLength(0);
  });

  it("renaming FAR ID carries the asset's transfer history to the new FAR ID", async () => {
    const db = await getPool();
    await db.query(
      `INSERT INTO transfers (far_id, transaction_date, location) VALUES ('EDIT-TEST-1', '2026-06-01', 'Center-Moved')`
    );

    const res = await authedInject(app, {
      method: "PATCH",
      url: "/api/assets/EDIT-TEST-1",
      payload: { ...baseEdit, farId: "EDIT-RENAMED-2" }
    });
    expect(res.statusCode).toBe(200);

    const { rows } = await db.query(`SELECT far_id, location FROM transfers WHERE far_id = 'EDIT-RENAMED-2'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].location).toBe("Center-Moved");
    const orphaned = await db.query(`SELECT 1 FROM transfers WHERE far_id = 'EDIT-TEST-1'`);
    expect(orphaned.rows).toHaveLength(0);
  });

  it("rejects renaming FAR ID to one already in use by another asset", async () => {
    await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, farId: "EDIT-OTHER-1" } });
    const res = await authedInject(app, {
      method: "PATCH",
      url: "/api/assets/EDIT-TEST-1",
      payload: { ...baseEdit, farId: "EDIT-OTHER-1" }
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/already in use/);
  });

  it("rejects an invalid FAR ID format on edit", async () => {
    const res = await authedInject(app, {
      method: "PATCH",
      url: "/api/assets/EDIT-TEST-1",
      payload: { ...baseEdit, farId: "lowercase-id" }
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a Sub Classification not in the active Masters list", async () => {
    const res = await authedInject(app, {
      method: "PATCH",
      url: "/api/assets/EDIT-TEST-1",
      payload: { ...baseEdit, subClassification: "Not A Real Sub" }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Sub Classification "Not A Real Sub" not recognized/);
  });

  it("does not touch Date Acquired, Location, Status, cost, or additions fields", async () => {
    await authedInject(app, {
      method: "PATCH",
      url: "/api/assets/EDIT-TEST-1",
      payload: { ...baseEdit, serialNo: "SN-2", usefulLifeC1Years: 9, usefulLifeC2Years: 9 }
    });

    const db = await getPool();
    const { rows } = await db.query(
      `SELECT date_acquired, location, status, c1_opening_cost, c2_opening_cost, additions_c1, additions_c2
       FROM assets WHERE far_id = 'EDIT-TEST-1'`
    );
    expect(String(rows[0].date_acquired)).toMatch(/^2026-01-01/);
    expect(rows[0].location).toBe("Center-Test");
    expect(rows[0].status).toBe("Active");
    expect(Number(rows[0].c1_opening_cost)).toBe(10000);
    expect(Number(rows[0].c2_opening_cost)).toBe(10000);
    expect(Number(rows[0].additions_c1)).toBe(0);
    expect(Number(rows[0].additions_c2)).toBe(0);
  });

  it("rejects negative Useful Life or Opening Acc Dep", async () => {
    const res = await authedInject(app, {
      method: "PATCH",
      url: "/api/assets/EDIT-TEST-1",
      payload: { ...baseEdit, usefulLifeC1Years: -1 }
    });
    expect(res.statusCode).toBe(400);
  });

  it("404s for an unknown FAR ID", async () => {
    const res = await authedInject(app, {
      method: "PATCH",
      url: "/api/assets/NOT-REAL",
      payload: { ...baseEdit, farId: "NOT-REAL" }
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
      payload: { ...baseEdit, serialNo: "SN-3" }
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/disposed/);
  });

  describe("Parent/child linking", () => {
    beforeEach(async () => {
      await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, farId: "EDIT-PARENT-1" } });
    });

    it("links an asset to a parent", async () => {
      const res = await authedInject(app, {
        method: "PATCH",
        url: "/api/assets/EDIT-TEST-1",
        payload: { ...baseEdit, parentFarId: "EDIT-PARENT-1" }
      });
      expect(res.statusCode).toBe(200);

      const db = await getPool();
      const { rows } = await db.query(`SELECT parent_far_id FROM assets WHERE far_id = 'EDIT-TEST-1'`);
      expect(rows[0].parent_far_id).toBe("EDIT-PARENT-1");
    });

    it("unlinks an existing parent by sending parentFarId: null", async () => {
      await authedInject(app, {
        method: "PATCH",
        url: "/api/assets/EDIT-TEST-1",
        payload: { ...baseEdit, parentFarId: "EDIT-PARENT-1" }
      });
      const res = await authedInject(app, {
        method: "PATCH",
        url: "/api/assets/EDIT-TEST-1",
        payload: { ...baseEdit, parentFarId: null }
      });
      expect(res.statusCode).toBe(200);

      const db = await getPool();
      const { rows } = await db.query(`SELECT parent_far_id FROM assets WHERE far_id = 'EDIT-TEST-1'`);
      expect(rows[0].parent_far_id).toBeNull();
    });

    it("rejects an asset being its own parent", async () => {
      const res = await authedInject(app, {
        method: "PATCH",
        url: "/api/assets/EDIT-TEST-1",
        payload: { ...baseEdit, parentFarId: "EDIT-TEST-1" }
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/own parent/);
    });

    it("404s when the chosen parent doesn't exist", async () => {
      const res = await authedInject(app, {
        method: "PATCH",
        url: "/api/assets/EDIT-TEST-1",
        payload: { ...baseEdit, parentFarId: "NOT-REAL-PARENT" }
      });
      expect(res.statusCode).toBe(404);
    });

    it("rejects a disposed asset as a parent", async () => {
      await authedInject(app, {
        method: "PATCH",
        url: "/api/assets/EDIT-PARENT-1/disposal",
        payload: { dateOfDisposal: "2026-06-01", saleValue: 0 }
      });
      const res = await authedInject(app, {
        method: "PATCH",
        url: "/api/assets/EDIT-TEST-1",
        payload: { ...baseEdit, parentFarId: "EDIT-PARENT-1" }
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/disposed/);
    });

    it("rejects one level of nesting: a child can't itself be used as a parent", async () => {
      await authedInject(app, {
        method: "POST",
        url: "/api/assets",
        payload: { ...NEW_ASSET, farId: "EDIT-GRANDCHILD-1" }
      });
      await authedInject(app, {
        method: "PATCH",
        url: "/api/assets/EDIT-TEST-1",
        payload: { ...baseEdit, parentFarId: "EDIT-PARENT-1" }
      });
      const res = await authedInject(app, {
        method: "PATCH",
        url: "/api/assets/EDIT-GRANDCHILD-1",
        payload: { ...baseEdit, farId: "EDIT-GRANDCHILD-1", parentFarId: "EDIT-TEST-1" }
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/only one level/);
    });

    it("rejects becoming a child when the asset already has children of its own", async () => {
      // EDIT-PARENT-1 gets a child (EDIT-TEST-1) first, then tries to become a child
      // itself of a third, unrelated, childless asset -- isolates "already has children"
      // from the separate "target is itself a child" rule the other test covers.
      await authedInject(app, {
        method: "PATCH",
        url: "/api/assets/EDIT-TEST-1",
        payload: { ...baseEdit, parentFarId: "EDIT-PARENT-1" }
      });
      await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, farId: "EDIT-OTHER-PARENT-1" } });
      const res = await authedInject(app, {
        method: "PATCH",
        url: "/api/assets/EDIT-PARENT-1",
        payload: { ...baseEdit, farId: "EDIT-PARENT-1", parentFarId: "EDIT-OTHER-PARENT-1" }
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/already has its own child assets/);
    });

    it("re-parenting: cleanly drops the old link when switched to a new parent, with no leftover reference", async () => {
      await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, farId: "EDIT-PARENT-B" } });
      await authedInject(app, {
        method: "PATCH",
        url: "/api/assets/EDIT-TEST-1",
        payload: { ...baseEdit, parentFarId: "EDIT-PARENT-1" }
      });

      const res = await authedInject(app, {
        method: "PATCH",
        url: "/api/assets/EDIT-TEST-1",
        payload: { ...baseEdit, parentFarId: "EDIT-PARENT-B" }
      });
      expect(res.statusCode).toBe(200);

      const db = await getPool();
      const { rows } = await db.query(`SELECT parent_far_id FROM assets WHERE far_id = 'EDIT-TEST-1'`);
      expect(rows[0].parent_far_id).toBe("EDIT-PARENT-B");

      // Disposing the old parent must not cascade to this asset anymore — proves the old
      // link is truly gone, not just shadowed by the new one.
      await authedInject(app, {
        method: "PATCH",
        url: "/api/assets/EDIT-PARENT-1/disposal",
        payload: { dateOfDisposal: "2026-06-01", saleValue: 0 }
      });
      const { rows: afterOldParentDisposal } = await db.query(
        `SELECT date_of_disposal FROM assets WHERE far_id = 'EDIT-TEST-1'`
      );
      expect(afterOldParentDisposal[0].date_of_disposal).toBeNull();

      // Disposing the new parent DOES cascade — confirms only the new link is active.
      await authedInject(app, {
        method: "PATCH",
        url: "/api/assets/EDIT-PARENT-B/disposal",
        payload: { dateOfDisposal: "2026-06-01", saleValue: 0 }
      });
      const { rows: afterNewParentDisposal } = await db.query(
        `SELECT date_of_disposal FROM assets WHERE far_id = 'EDIT-TEST-1'`
      );
      expect(afterNewParentDisposal[0].date_of_disposal).not.toBeNull();
    });
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

  describe("Link to parent in the same request", () => {
    beforeEach(async () => {
      await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, farId: "ADD-PARENT-1" } });
    });

    it("links the asset to a parent atomically with the addition", async () => {
      const res = await authedInject(app, {
        method: "PATCH",
        url: "/api/assets/ADD-TEST-1/addition",
        payload: { additionsC1: 1000, additionsC2: 0, dateOfAddition: "2026-05-01", parentFarId: "ADD-PARENT-1" }
      });
      expect(res.statusCode).toBe(200);

      const db = await getPool();
      const { rows } = await db.query(
        `SELECT additions_c1, parent_far_id FROM assets WHERE far_id = 'ADD-TEST-1'`
      );
      expect(Number(rows[0].additions_c1)).toBe(1000);
      expect(rows[0].parent_far_id).toBe("ADD-PARENT-1");
    });

    it("leaves any existing parent link untouched when parentFarId is omitted", async () => {
      const db = await getPool();
      await db.query(`UPDATE assets SET parent_far_id = 'ADD-PARENT-1' WHERE far_id = 'ADD-TEST-1'`);

      const res = await authedInject(app, {
        method: "PATCH",
        url: "/api/assets/ADD-TEST-1/addition",
        payload: { additionsC1: 1000, additionsC2: 0, dateOfAddition: "2026-05-01" }
      });
      expect(res.statusCode).toBe(200);

      const { rows } = await db.query(`SELECT parent_far_id FROM assets WHERE far_id = 'ADD-TEST-1'`);
      expect(rows[0].parent_far_id).toBe("ADD-PARENT-1");
    });

    it("reuses the same validation as Edit — rejects a disposed asset as parent, without recording the addition", async () => {
      await authedInject(app, {
        method: "PATCH",
        url: "/api/assets/ADD-PARENT-1/disposal",
        payload: { dateOfDisposal: "2026-06-01", saleValue: 0 }
      });
      const res = await authedInject(app, {
        method: "PATCH",
        url: "/api/assets/ADD-TEST-1/addition",
        payload: { additionsC1: 1000, additionsC2: 0, dateOfAddition: "2026-05-01", parentFarId: "ADD-PARENT-1" }
      });
      expect(res.statusCode).toBe(409);

      const db = await getPool();
      const { rows } = await db.query(`SELECT additions_c1, parent_far_id FROM assets WHERE far_id = 'ADD-TEST-1'`);
      expect(Number(rows[0].additions_c1)).toBe(0);
      expect(rows[0].parent_far_id).toBeNull();
    });
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

  describe("Parent/child cascade", () => {
    it("disposing a parent also disposes its still-active children, with Sale Value 0", async () => {
      await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, farId: "DISP-CHILD-1" } });
      const db = await getPool();
      await db.query(`UPDATE assets SET parent_far_id = 'DISP-TEST-1' WHERE far_id = 'DISP-CHILD-1'`);

      const res = await authedInject(app, {
        method: "PATCH",
        url: "/api/assets/DISP-TEST-1/disposal",
        payload: { dateOfDisposal: "2026-08-01", saleValue: 500 }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().childrenDisposed).toEqual(["DISP-CHILD-1"]);

      const { rows } = await db.query(
        `SELECT date_of_disposal, sale_value, status FROM assets WHERE far_id = 'DISP-CHILD-1'`
      );
      expect(rows[0].date_of_disposal).not.toBeNull();
      expect(Number(rows[0].sale_value)).toBe(0);
      expect(rows[0].status).toBe("Disposed");
    });

    it("does not touch a child that was already disposed independently beforehand", async () => {
      await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, farId: "DISP-CHILD-2" } });
      const db = await getPool();
      await db.query(`UPDATE assets SET parent_far_id = 'DISP-TEST-1' WHERE far_id = 'DISP-CHILD-2'`);
      await authedInject(app, {
        method: "PATCH",
        url: "/api/assets/DISP-CHILD-2/disposal",
        payload: { dateOfDisposal: "2026-07-01", saleValue: 999 }
      });

      const res = await authedInject(app, {
        method: "PATCH",
        url: "/api/assets/DISP-TEST-1/disposal",
        payload: { dateOfDisposal: "2026-08-01", saleValue: 500 }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().childrenDisposed).toEqual([]);

      const { rows } = await db.query(`SELECT sale_value, date_of_disposal FROM assets WHERE far_id = 'DISP-CHILD-2'`);
      expect(Number(rows[0].sale_value)).toBe(999);
      expect(String(rows[0].date_of_disposal)).toMatch(/^2026-07-01/);
    });

    it("marks a cascaded child with disposed_via_parent_far_id, and leaves the parent's own row null", async () => {
      await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, farId: "DISP-CHILD-3" } });
      const db = await getPool();
      await db.query(`UPDATE assets SET parent_far_id = 'DISP-TEST-1' WHERE far_id = 'DISP-CHILD-3'`);

      await authedInject(app, {
        method: "PATCH",
        url: "/api/assets/DISP-TEST-1/disposal",
        payload: { dateOfDisposal: "2026-08-01", saleValue: 500 }
      });

      const { rows } = await db.query(
        `SELECT far_id, disposed_via_parent_far_id FROM assets WHERE far_id IN ('DISP-TEST-1', 'DISP-CHILD-3')`
      );
      const parent = rows.find((r: { far_id: string }) => r.far_id === "DISP-TEST-1");
      const child = rows.find((r: { far_id: string }) => r.far_id === "DISP-CHILD-3");
      expect(parent.disposed_via_parent_far_id).toBeNull();
      expect(child.disposed_via_parent_far_id).toBe("DISP-TEST-1");
    });

    it("leaves a cascaded child's cost, quantity, and useful life untouched — only Sale Value is overridden", async () => {
      const db = await getPool();
      await db.query(
        `INSERT INTO assets (
           far_id, sub_classification, asset_description, status, date_acquired, location,
           useful_life_c1_years, useful_life_c2_years, qty, c1_opening_cost, c2_opening_cost, parent_far_id
         ) VALUES ('DISP-CHILD-4', 'Test-Sub', 'Child Asset', 'Active', '2026-01-01', 'Center-Test', 9, 4, 3, 55000, 22000, 'DISP-TEST-1')`
      );

      await authedInject(app, {
        method: "PATCH",
        url: "/api/assets/DISP-TEST-1/disposal",
        payload: { dateOfDisposal: "2026-08-01", saleValue: 500 }
      });

      const { rows } = await db.query(
        `SELECT qty, useful_life_c1_years, useful_life_c2_years, c1_opening_cost, c2_opening_cost, sale_value
         FROM assets WHERE far_id = 'DISP-CHILD-4'`
      );
      expect(Number(rows[0].qty)).toBe(3);
      expect(Number(rows[0].useful_life_c1_years)).toBe(9);
      expect(Number(rows[0].useful_life_c2_years)).toBe(4);
      expect(Number(rows[0].c1_opening_cost)).toBe(55000);
      expect(Number(rows[0].c2_opening_cost)).toBe(22000);
      // The one deliberate exception — a cascaded child's Sale Value is always 0, never
      // the parent's sale value (500 here).
      expect(Number(rows[0].sale_value)).toBe(0);
    });
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

describe("Merge: POST /api/assets/merge", () => {
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
    await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, farId: "MERGE-PARENT-1" } });
    await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, farId: "MERGE-CHILD-1" } });
    await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, farId: "MERGE-CHILD-2" } });
  });

  it("links every child to the chosen parent in one request", async () => {
    const res = await authedInject(app, {
      method: "POST",
      url: "/api/assets/merge",
      payload: { parentFarId: "MERGE-PARENT-1", childFarIds: ["MERGE-CHILD-1", "MERGE-CHILD-2"] }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      parentFarId: "MERGE-PARENT-1",
      childFarIds: ["MERGE-CHILD-1", "MERGE-CHILD-2"],
      merged: 2
    });

    const db = await getPool();
    const { rows } = await db.query(
      `SELECT far_id, parent_far_id FROM assets WHERE far_id IN ('MERGE-CHILD-1', 'MERGE-CHILD-2') ORDER BY far_id`
    );
    expect(rows.every((r: { parent_far_id: string }) => r.parent_far_id === "MERGE-PARENT-1")).toBe(true);
  });

  it("rejects a self-parent (the parent listed among its own children)", async () => {
    const res = await authedInject(app, {
      method: "POST",
      url: "/api/assets/merge",
      payload: { parentFarId: "MERGE-PARENT-1", childFarIds: ["MERGE-PARENT-1"] }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/own parent/);
  });

  it("404s when a child FAR ID doesn't exist, and writes nothing", async () => {
    const res = await authedInject(app, {
      method: "POST",
      url: "/api/assets/merge",
      payload: { parentFarId: "MERGE-PARENT-1", childFarIds: ["MERGE-CHILD-1", "NOT-REAL-CHILD"] }
    });
    expect(res.statusCode).toBe(404);

    const db = await getPool();
    const { rows } = await db.query(`SELECT parent_far_id FROM assets WHERE far_id = 'MERGE-CHILD-1'`);
    expect(rows[0].parent_far_id).toBeNull();
  });

  it("rejects a disposed asset as the parent", async () => {
    await authedInject(app, {
      method: "PATCH",
      url: "/api/assets/MERGE-PARENT-1/disposal",
      payload: { dateOfDisposal: "2026-06-01", saleValue: 0 }
    });
    const res = await authedInject(app, {
      method: "POST",
      url: "/api/assets/merge",
      payload: { parentFarId: "MERGE-PARENT-1", childFarIds: ["MERGE-CHILD-1"] }
    });
    expect(res.statusCode).toBe(409);
  });

  it("rejects two-level nesting: a child that already has its own children can't be merged in as a child", async () => {
    // MERGE-CHILD-1 already has a child of its own (MERGE-CHILD-2) — merging it under
    // MERGE-PARENT-1 would make a 3-generation chain, not one level.
    const db = await getPool();
    await db.query(`UPDATE assets SET parent_far_id = 'MERGE-CHILD-1' WHERE far_id = 'MERGE-CHILD-2'`);

    const res = await authedInject(app, {
      method: "POST",
      url: "/api/assets/merge",
      payload: { parentFarId: "MERGE-PARENT-1", childFarIds: ["MERGE-CHILD-1"] }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/already has its own child assets/);
  });

  it("rejects two-level nesting: an asset that's itself already a child can't be used as the parent", async () => {
    await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, farId: "MERGE-GRANDPARENT-1" } });
    const db = await getPool();
    await db.query(`UPDATE assets SET parent_far_id = 'MERGE-GRANDPARENT-1' WHERE far_id = 'MERGE-PARENT-1'`);

    const res = await authedInject(app, {
      method: "POST",
      url: "/api/assets/merge",
      payload: { parentFarId: "MERGE-PARENT-1", childFarIds: ["MERGE-CHILD-1"] }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/only one level/);
  });

  it("all-or-nothing: rejects the whole batch (and writes nothing) if any one child fails validation", async () => {
    // MERGE-CHILD-2 already has its own child, so it fails validation — MERGE-CHILD-1
    // must not get linked either, even though it's independently fine.
    await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, farId: "MERGE-GRANDCHILD-1" } });
    const db = await getPool();
    await db.query(`UPDATE assets SET parent_far_id = 'MERGE-CHILD-2' WHERE far_id = 'MERGE-GRANDCHILD-1'`);

    const res = await authedInject(app, {
      method: "POST",
      url: "/api/assets/merge",
      payload: { parentFarId: "MERGE-PARENT-1", childFarIds: ["MERGE-CHILD-1", "MERGE-CHILD-2"] }
    });
    expect(res.statusCode).toBe(400);

    const { rows } = await db.query(`SELECT parent_far_id FROM assets WHERE far_id = 'MERGE-CHILD-1'`);
    expect(rows[0].parent_far_id).toBeNull();
  });
});
