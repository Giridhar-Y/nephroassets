import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import bulkMastersRoutes from "./bulkMasters.js";
import { getPool } from "../db/pool.js";
import { authedInject } from "../testHelpers/authTestUtils.js";
import { csvPayload, emptyMultipartPayload } from "./bulkTestHelpers.js";

describe("Bulk Masters", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(multipart);
    await app.register(bulkMastersRoutes);
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

  describe("Centers: /api/masters/centers/bulk-upload", () => {
    it("400s when no file is uploaded", async () => {
      const res = await authedInject(app, { method: "POST", url: "/api/masters/centers/bulk-upload", ...emptyMultipartPayload() });
      expect(res.statusCode).toBe(400);
    });

    it("creates new centers and updates an existing one, matched case-insensitively by code", async () => {
      const db = await getPool();
      await db.query(`INSERT INTO centers (code, description) VALUES ('Center-001', 'Old desc')`);

      const csv = ["code,description,active", "center-001,New desc,true", "Center-026,Fresh site,"].join("\n");
      const res = await authedInject(app, { method: "POST", url: "/api/masters/centers/bulk-upload", ...csvPayload(csv) });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ totalRows: 2, processed: 2, added: 1, updated: 1, errors: [] });

      const { rows } = await db.query(`SELECT code, description, active FROM centers ORDER BY code`);
      expect(rows).toEqual([
        { code: "Center-001", description: "New desc", active: true },
        { code: "Center-026", description: "Fresh site", active: true }
      ]);
    });

    it("rejects a duplicate code within the same file", async () => {
      const csv = ["code,description", "Center-050,First", "Center-050,Second"].join("\n");
      const res = await authedInject(app, { method: "POST", url: "/api/masters/centers/bulk-upload?preview=true", ...csvPayload(csv) });
      const body = res.json();
      expect(body.summary).toEqual({ new: 1, update: 0, error: 1 });
      expect(body.rows[1].message).toMatch(/Duplicate Code "Center-050"/);
    });

    it("flags deactivating a center that's still in use, without erroring", async () => {
      const db = await getPool();
      await db.query(`INSERT INTO centers (code) VALUES ('Center-USED')`);
      await db.query(
        `INSERT INTO assets (far_id, sub_classification, asset_description, status, date_acquired, location, useful_life_c1_years, useful_life_c2_years)
         VALUES ('A-1', 'Test-Sub', 'Test asset', 'Active', '2020-01-01', 'Center-USED', 5, 5)`
      );

      const csv = ["code,active", "Center-USED,false"].join("\n");
      const preview = await authedInject(app, { method: "POST", url: "/api/masters/centers/bulk-upload?preview=true", ...csvPayload(csv) });
      const previewBody = preview.json();
      expect(previewBody.summary).toEqual({ new: 0, update: 1, error: 0 });
      expect(previewBody.rows[0].message).toMatch(/Will deactivate — currently used by 1 asset/);

      const commit = await authedInject(app, { method: "POST", url: "/api/masters/centers/bulk-upload", ...csvPayload(csv) });
      expect(commit.json()).toMatchObject({ processed: 1, updated: 1, errors: [] });
      const { rows } = await db.query(`SELECT active FROM centers WHERE code = 'Center-USED'`);
      expect(rows[0].active).toBe(false);
    });
  });

  describe("Sub Classifications: /api/masters/sub-classifications/bulk-upload", () => {
    it("creates and updates by name", async () => {
      const db = await getPool();
      await db.query(`INSERT INTO sub_classifications (name) VALUES ('IT Equipment')`);

      const csv = ["name,active", "IT Equipment,false", "X-Ray Machines,"].join("\n");
      const res = await authedInject(app, { method: "POST", url: "/api/masters/sub-classifications/bulk-upload", ...csvPayload(csv) });
      const body = res.json();
      expect(body).toMatchObject({ added: 1, updated: 1, errors: [] });

      const { rows } = await db.query(`SELECT name, active FROM sub_classifications ORDER BY name`);
      expect(rows).toEqual([
        { name: "IT Equipment", active: false },
        { name: "X-Ray Machines", active: true }
      ]);
    });
  });

  describe("Statuses: /api/masters/statuses/bulk-upload", () => {
    it("rejects a row that tries to modify a system-managed status", async () => {
      const db = await getPool();
      await db.query(`INSERT INTO statuses (name, system_managed) VALUES ('Disposed', TRUE)`);

      const csv = ["name,active", "Disposed,false"].join("\n");
      const res = await authedInject(app, { method: "POST", url: "/api/masters/statuses/bulk-upload", ...csvPayload(csv) });
      const body = res.json();
      expect(body.processed).toBe(0);
      expect(body.errors[0].message).toMatch(/'Disposed' is system-managed and cannot be modified via Bulk Upload/);

      const { rows } = await db.query(`SELECT active FROM statuses WHERE name = 'Disposed'`);
      expect(rows[0].active).toBe(true);
    });

    it("creates a new status", async () => {
      const csv = ["name", "Loaned Out"].join("\n");
      const res = await authedInject(app, { method: "POST", url: "/api/masters/statuses/bulk-upload", ...csvPayload(csv) });
      expect(res.json()).toMatchObject({ added: 1, updated: 0, errors: [] });
    });
  });
});
