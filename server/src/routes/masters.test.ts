import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mastersRoutes from "./masters.js";
import { getPool } from "../db/pool.js";
import { authedInject } from "../testHelpers/authTestUtils.js";
import { authGateHook } from "../auth/middleware.js";

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
    app.decorateRequest("user", null);
    app.addHook("preHandler", authGateHook);
    await app.register(cookie);
    await app.register(mastersRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const db = await getPool();
    await db.query(`DELETE FROM master_activity_log`);
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

    describe("Has Component 2", () => {
      it("defaults to true for a newly created entry, and stays true when not specified", async () => {
        const res = await authedInject(app, { method: "POST", url: "/api/masters/sub-classifications", payload: { name: "New Class" } });
        expect(res.json().hasComponent2).toBe(true);
      });

      it("can be created as false explicitly, and round-trips through PATCH", async () => {
        const created = await authedInject(app, {
          method: "POST",
          url: "/api/masters/sub-classifications",
          payload: { name: "C1-Only Class", hasComponent2: false }
        });
        expect(created.json().hasComponent2).toBe(false);

        const patch = await authedInject(app, {
          method: "PATCH",
          url: `/api/masters/sub-classifications/${created.json().id}`,
          payload: { hasComponent2: true }
        });
        expect(patch.json().hasComponent2).toBe(true);
      });

      it("blocks turning Component 2 off while an asset still has non-zero C2 opening cost, naming the blocking asset", async () => {
        const created = await authedInject(app, { method: "POST", url: "/api/masters/sub-classifications", payload: { name: "Blocked Class" } });
        const { id } = created.json();
        await insertAsset("BLK-1", { sub_classification: "Blocked Class", c2_opening_cost: 50000 });

        const patch = await authedInject(app, {
          method: "PATCH",
          url: `/api/masters/sub-classifications/${id}`,
          payload: { hasComponent2: false }
        });
        expect(patch.statusCode).toBe(409);
        expect(patch.json().error).toContain("BLK-1");
        expect(patch.json().error).toContain("1 asset");

        // Rejected — the toggle must not have actually flipped.
        const list = await authedInject(app, { method: "GET", url: "/api/masters/sub-classifications" });
        expect(list.json().find((r: { name: string }) => r.name === "Blocked Class").hasComponent2).toBe(true);
      });

      it("blocks on non-zero additions C2, deletions C2, or opening acc. dep. C2 individually, and names every blocking asset", async () => {
        const created = await authedInject(app, { method: "POST", url: "/api/masters/sub-classifications", payload: { name: "Multi-Blocked" } });
        const { id } = created.json();
        await insertAsset("BLK-ADD", { sub_classification: "Multi-Blocked", additions_c2: 1000, date_of_addition: "2026-05-01" });
        await insertAsset("BLK-DEL", { sub_classification: "Multi-Blocked", deletions_c2: 1000, date_of_disposal: "2026-06-01", status: "Disposed" });
        await insertAsset("BLK-DEP", { sub_classification: "Multi-Blocked", acc_dep_c2_opening: 500 });

        const patch = await authedInject(app, {
          method: "PATCH",
          url: `/api/masters/sub-classifications/${id}`,
          payload: { hasComponent2: false }
        });
        expect(patch.statusCode).toBe(409);
        const error: string = patch.json().error;
        expect(error).toContain("3 assets");
        expect(error).toContain("BLK-ADD");
        expect(error).toContain("BLK-DEL");
        expect(error).toContain("BLK-DEP");
      });

      it("does NOT block on a leftover non-zero Useful Life C2 alone — only real cost/dep/deletions figures count", async () => {
        const created = await authedInject(app, { method: "POST", url: "/api/masters/sub-classifications", payload: { name: "Stale Life Only" } });
        const { id } = created.json();
        // useful_life_c2_years is 5 by default in insertAsset, but every actual C2 figure
        // (cost, additions, deletions, opening acc. dep.) is 0 — the calc engine
        // contributes nothing for a component like this (confirmed by tracing engine.ts),
        // so it must not block cleanup.
        await insertAsset("STALE-1", { sub_classification: "Stale Life Only" });

        const patch = await authedInject(app, {
          method: "PATCH",
          url: `/api/masters/sub-classifications/${id}`,
          payload: { hasComponent2: false }
        });
        expect(patch.statusCode).toBe(200);
        expect(patch.json().hasComponent2).toBe(false);
      });

      it("allows turning Component 2 off once its blocking asset's C2 data is cleared", async () => {
        const created = await authedInject(app, { method: "POST", url: "/api/masters/sub-classifications", payload: { name: "Cleared Class" } });
        const { id } = created.json();
        await insertAsset("CLR-1", { sub_classification: "Cleared Class", c2_opening_cost: 20000 });

        const blocked = await authedInject(app, {
          method: "PATCH",
          url: `/api/masters/sub-classifications/${id}`,
          payload: { hasComponent2: false }
        });
        expect(blocked.statusCode).toBe(409);

        const db = await getPool();
        await db.query(`UPDATE assets SET c2_opening_cost = 0 WHERE far_id = 'CLR-1'`);

        const allowed = await authedInject(app, {
          method: "PATCH",
          url: `/api/masters/sub-classifications/${id}`,
          payload: { hasComponent2: false }
        });
        expect(allowed.statusCode).toBe(200);
        expect(allowed.json().hasComponent2).toBe(false);
      });

      it("does not block turning Component 2 back ON (only the off-switch is guarded)", async () => {
        const created = await authedInject(app, {
          method: "POST",
          url: "/api/masters/sub-classifications",
          payload: { name: "Toggle Back On", hasComponent2: false }
        });
        const patch = await authedInject(app, {
          method: "PATCH",
          url: `/api/masters/sub-classifications/${created.json().id}`,
          payload: { hasComponent2: true }
        });
        expect(patch.statusCode).toBe(200);
        expect(patch.json().hasComponent2).toBe(true);
      });
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
