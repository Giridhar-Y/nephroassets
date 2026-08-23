import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mastersRoutes from "./masters.js";
import { getPool } from "../db/pool.js";
import { authedInject } from "../testHelpers/authTestUtils.js";

async function insertAsset(farId: string, overrides: Record<string, unknown> = {}) {
  const db = await getPool();
  const row = {
    far_id: farId,
    sub_classification: "Test-Sub",
    asset_description: `Masters test ${farId}`,
    status: "Active",
    date_acquired: "2020-01-01",
    location: "Center-A",
    useful_life_c1_years: 5,
    useful_life_c2_years: 5,
    ...overrides
  };
  const columns = Object.keys(row);
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
  await db.query(`INSERT INTO assets (${columns.join(", ")}) VALUES (${placeholders})`, Object.values(row));
}

describe("Masters", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(mastersRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const db = await getPool();
    await db.query(`DELETE FROM transfers`);
    await db.query(`DELETE FROM assets`);
    await db.query(`DELETE FROM centers`);
    await db.query(`DELETE FROM sub_classifications`);
    await db.query(`DELETE FROM statuses`);
  });

  describe("Centers", () => {
    it("creates a center and lists it with a usage count", async () => {
      await insertAsset("CTR-1", { location: "Center-X" });
      const create = await authedInject(app, {
        method: "POST",
        url: "/api/masters/centers",
        payload: { code: "Center-X", description: "Main building" }
      });
      expect(create.statusCode).toBe(200);

      const list = await authedInject(app, { method: "GET", url: "/api/masters/centers" });
      const body = list.json();
      expect(body).toHaveLength(1);
      expect(body[0].usageCount).toBe(1);
    });

    it("rejects a case-insensitive duplicate code", async () => {
      await authedInject(app, { method: "POST", url: "/api/masters/centers", payload: { code: "Center-Y" } });
      const dup = await authedInject(app, { method: "POST", url: "/api/masters/centers", payload: { code: "center-y" } });
      expect(dup.statusCode).toBe(409);
    });

    it("renaming a code cascades to assets.location, assets.revised_location, and transfers.location", async () => {
      const created = await authedInject(app, { method: "POST", url: "/api/masters/centers", payload: { code: "Center-OLD" } });
      const { id } = created.json();

      await insertAsset("CTR-2", { location: "Center-OLD" });
      await insertAsset("CTR-3", { location: "Center-Elsewhere", revised_location: "Center-OLD" });
      const db = await getPool();
      await db.query(`INSERT INTO transfers (far_id, transaction_date, location) VALUES ($1, '2026-01-01', 'Center-OLD')`, [
        "CTR-2"
      ]);

      const patch = await authedInject(app, {
        method: "PATCH",
        url: `/api/masters/centers/${id}`,
        payload: { code: "Center-NEW" }
      });
      expect(patch.statusCode).toBe(200);
      const body = patch.json();
      expect(body.assetsUpdated).toBe(2);
      expect(body.transfersUpdated).toBe(1);

      const { rows: assets } = await db.query(`SELECT far_id, location, revised_location FROM assets ORDER BY far_id`);
      expect(assets).toEqual([
        { far_id: "CTR-2", location: "Center-NEW", revised_location: null },
        { far_id: "CTR-3", location: "Center-Elsewhere", revised_location: "Center-NEW" }
      ]);
      const { rows: transfers } = await db.query(`SELECT location FROM transfers`);
      expect(transfers[0].location).toBe("Center-NEW");
    });

    it("deactivating never touches existing assets", async () => {
      const created = await authedInject(app, { method: "POST", url: "/api/masters/centers", payload: { code: "Center-Z" } });
      const { id } = created.json();
      await insertAsset("CTR-4", { location: "Center-Z" });

      const patch = await authedInject(app, { method: "PATCH", url: `/api/masters/centers/${id}`, payload: { active: false } });
      expect(patch.statusCode).toBe(200);
      expect(patch.json().active).toBe(false);

      const db = await getPool();
      const { rows } = await db.query(`SELECT location FROM assets WHERE far_id = 'CTR-4'`);
      expect(rows[0].location).toBe("Center-Z");
    });
  });

  describe("Sub Classifications", () => {
    it("creates one with optional default useful-life fields and round-trips them", async () => {
      const res = await authedInject(app, {
        method: "POST",
        url: "/api/masters/sub-classifications",
        payload: { name: "Dialysis Machines", defaultUsefulLifeC1Years: 10, defaultUsefulLifeC2Years: 5 }
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.defaultUsefulLifeC1Years).toBe(10);
      expect(body.defaultUsefulLifeC2Years).toBe(5);
    });

    it("rejects a duplicate name", async () => {
      await authedInject(app, { method: "POST", url: "/api/masters/sub-classifications", payload: { name: "RO Plants" } });
      const dup = await authedInject(app, { method: "POST", url: "/api/masters/sub-classifications", payload: { name: "RO Plants" } });
      expect(dup.statusCode).toBe(409);
    });

    it("PATCH also round-trips the default useful-life fields as numbers, not raw DB strings", async () => {
      const created = await authedInject(app, { method: "POST", url: "/api/masters/sub-classifications", payload: { name: "Vehicles" } });
      const { id } = created.json();
      const patch = await authedInject(app, {
        method: "PATCH",
        url: `/api/masters/sub-classifications/${id}`,
        payload: { defaultUsefulLifeC1Years: 8, defaultUsefulLifeC2Years: 4 }
      });
      const body = patch.json();
      expect(body.defaultUsefulLifeC1Years).toBe(8);
      expect(body.defaultUsefulLifeC2Years).toBe(4);
    });

    it("renaming cascades to every asset using the old name", async () => {
      const created = await authedInject(app, { method: "POST", url: "/api/masters/sub-classifications", payload: { name: "IT Equipment" } });
      const { id } = created.json();
      await insertAsset("SUB-1", { sub_classification: "IT Equipment" });
      await insertAsset("SUB-2", { sub_classification: "IT Equipment" });
      await insertAsset("SUB-3", { sub_classification: "Vehicles" });

      const patch = await authedInject(app, {
        method: "PATCH",
        url: `/api/masters/sub-classifications/${id}`,
        payload: { name: "IT & Computer Equipment" }
      });
      expect(patch.json().assetsUpdated).toBe(2);

      const db = await getPool();
      const { rows } = await db.query(`SELECT far_id, sub_classification FROM assets ORDER BY far_id`);
      expect(rows).toEqual([
        { far_id: "SUB-1", sub_classification: "IT & Computer Equipment" },
        { far_id: "SUB-2", sub_classification: "IT & Computer Equipment" },
        { far_id: "SUB-3", sub_classification: "Vehicles" }
      ]);
    });
  });

  describe("Statuses", () => {
    it("creates a non-system-managed status", async () => {
      const res = await authedInject(app, { method: "POST", url: "/api/masters/statuses", payload: { name: "Loaned Out" } });
      expect(res.statusCode).toBe(200);
      expect(res.json().systemManaged).toBe(false);
    });

    it("rejects a duplicate name", async () => {
      await authedInject(app, { method: "POST", url: "/api/masters/statuses", payload: { name: "Active" } });
      const dup = await authedInject(app, { method: "POST", url: "/api/masters/statuses", payload: { name: "active" } });
      expect(dup.statusCode).toBe(409);
    });

    it("renaming cascades to every asset using the old name", async () => {
      const created = await authedInject(app, { method: "POST", url: "/api/masters/statuses", payload: { name: "Under Repair" } });
      const { id } = created.json();
      await insertAsset("STA-1", { status: "Under Repair" });

      const patch = await authedInject(app, {
        method: "PATCH",
        url: `/api/masters/statuses/${id}`,
        payload: { name: "Under Maintenance" }
      });
      expect(patch.json().assetsUpdated).toBe(1);

      const db = await getPool();
      const { rows } = await db.query(`SELECT status FROM assets WHERE far_id = 'STA-1'`);
      expect(rows[0].status).toBe("Under Maintenance");
    });

    it("a system-managed status (Disposed) can never be edited via the API", async () => {
      const db = await getPool();
      const { rows } = await db.query(
        `INSERT INTO statuses (name, system_managed) VALUES ('Disposed', TRUE) RETURNING id`
      );
      const id = rows[0].id;

      const rename = await authedInject(app, { method: "PATCH", url: `/api/masters/statuses/${id}`, payload: { name: "Sold" } });
      expect(rename.statusCode).toBe(409);

      const deactivate = await authedInject(app, { method: "PATCH", url: `/api/masters/statuses/${id}`, payload: { active: false } });
      expect(deactivate.statusCode).toBe(409);
    });
  });
});
