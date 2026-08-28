import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import cookie from "@fastify/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import bulkTransfersRoutes from "./bulkTransfers.js";
import { getPool } from "../db/pool.js";
import { authedInject } from "../testHelpers/authTestUtils.js";
import { authGateHook } from "../auth/middleware.js";
import { csvPayload, emptyMultipartPayload } from "./bulkTestHelpers.js";

async function insertAsset(farId: string, dateAcquired = "2020-01-01") {
  const db = await getPool();
  await db.query(
    `INSERT INTO assets (
       far_id, sub_classification, asset_description, status, date_acquired, location,
       useful_life_c1_years, useful_life_c2_years
     ) VALUES ($1, 'Test-Sub', 'Bulk transfer test asset', 'Active', $2, 'Center-A', 5, 5)`,
    [farId, dateAcquired]
  );
}

const HEADER = "farId,toLocation,transactionDate";

describe("Bulk Transfers: POST /api/transfers/bulk-upload", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    app.decorateRequest("user", null);
    app.addHook("preHandler", authGateHook);
    await app.register(cookie);
    await app.register(multipart);
    await app.register(bulkTransfersRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const db = await getPool();
    await db.query(`DELETE FROM transfers`);
    await db.query(`DELETE FROM assets`);
    // toLocation is now validated against the active Centers master list
    // (routes/masters.ts) — seed the ones these fixtures move assets to.
    await db.query(`DELETE FROM centers`);
    await db.query(`INSERT INTO centers (code) VALUES ('Center-A'), ('Center-B'), ('Center-C'), ('Center-D')`);
  });

  it("transfers valid rows (each to its own destination) and reports errors for the rest", async () => {
    await insertAsset("BXFER-1");
    await insertAsset("BXFER-2");

    const csv = [HEADER, "BXFER-1,Center-B,2026-05-01", "BXFER-2,Center-C,2026-06-01", "BXFER-9,Center-D,2026-05-01"].join(
      "\n"
    );
    const res = await authedInject(app, { method: "POST", url: "/api/transfers/bulk-upload", ...csvPayload(csv) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalRows).toBe(3);
    expect(body.processed).toBe(2);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].farId).toBe("BXFER-9");
    expect(body.errors[0].message).toMatch(/No asset found/);

    const db = await getPool();
    const { rows: a1 } = await db.query(`SELECT revised_location FROM assets WHERE far_id = 'BXFER-1'`);
    expect(a1[0].revised_location).toBe("Center-B");
    const { rows: a2 } = await db.query(`SELECT revised_location FROM assets WHERE far_id = 'BXFER-2'`);
    expect(a2[0].revised_location).toBe("Center-C");

    const { rows: history } = await db.query(`SELECT far_id, location FROM transfers ORDER BY far_id`);
    expect(history).toEqual([
      { far_id: "BXFER-1", location: "Center-B" },
      { far_id: "BXFER-2", location: "Center-C" }
    ]);
  });

  it("still records both transfers, but a backdated row later in the file does not regress the denormalized current location", async () => {
    await insertAsset("BXFER-BACKDATE");

    const csv = [HEADER, "BXFER-BACKDATE,Center-B,2026-08-01", "BXFER-BACKDATE,Center-C,2026-05-01"].join("\n");
    const res = await authedInject(app, { method: "POST", url: "/api/transfers/bulk-upload", ...csvPayload(csv) });
    expect(res.statusCode).toBe(200);
    expect(res.json().processed).toBe(2);

    const db = await getPool();
    const { rows: history } = await db.query(
      `SELECT location FROM transfers WHERE far_id = 'BXFER-BACKDATE' ORDER BY transaction_date`
    );
    expect(history.map((r) => r.location)).toEqual(["Center-C", "Center-B"]);

    const { rows: asset } = await db.query(
      `SELECT revised_location, last_date_of_transaction FROM assets WHERE far_id = 'BXFER-BACKDATE'`
    );
    expect(asset[0].revised_location).toBe("Center-B");
    expect(String(asset[0].last_date_of_transaction)).toMatch(/^2026-08-01/);
  });

  it("400s when no file is uploaded", async () => {
    const res = await authedInject(app, { method: "POST", url: "/api/transfers/bulk-upload", ...emptyMultipartPayload() });
    expect(res.statusCode).toBe(400);
  });

  it("preview mode classifies rows without transferring anything", async () => {
    await insertAsset("BXFER-1");

    const csv = [HEADER, "BXFER-1,Center-B,2026-05-01", "BXFER-9,Center-D,2026-05-01"].join("\n");
    const res = await authedInject(app, {
      method: "POST",
      url: "/api/transfers/bulk-upload?preview=true",
      ...csvPayload(csv)
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.summary).toEqual({ new: 0, update: 1, error: 1 });
    expect(body.rows.find((r: { farId: string }) => r.farId === "BXFER-1").status).toBe("update");
    expect(body.rows.find((r: { farId: string }) => r.farId === "BXFER-9").message).toMatch(/No asset found/);

    const db = await getPool();
    const { rows } = await db.query(`SELECT revised_location FROM assets WHERE far_id = 'BXFER-1'`);
    expect(rows[0].revised_location).toBeNull();
    const { rows: history } = await db.query(`SELECT * FROM transfers`);
    expect(history).toHaveLength(0);
  });

  it("rejects a row transferred before the asset's capitalization date, and reports it in preview too", async () => {
    await insertAsset("BXFER-EARLY", "2026-04-01");

    const csv = [HEADER, "BXFER-EARLY,Center-B,2026-03-15"].join("\n");
    const preview = await authedInject(app, {
      method: "POST",
      url: "/api/transfers/bulk-upload?preview=true",
      ...csvPayload(csv)
    });
    const previewBody = preview.json();
    expect(previewBody.rows[0].status).toBe("error");
    expect(previewBody.rows[0].message).toMatch(/Transfer date cannot be before the asset's capitalization date \(01-04-2026\)/);

    const res = await authedInject(app, { method: "POST", url: "/api/transfers/bulk-upload", ...csvPayload(csv) });
    const body = res.json();
    expect(body.processed).toBe(0);
    expect(body.errors[0].message).toMatch(/Transfer date cannot be before the asset's capitalization date \(01-04-2026\)/);

    const db = await getPool();
    const { rows } = await db.query(`SELECT revised_location FROM assets WHERE far_id = 'BXFER-EARLY'`);
    expect(rows[0].revised_location).toBeNull();
  });

  it("allows a row transferred exactly on the asset's capitalization date (boundary is >=, not >)", async () => {
    await insertAsset("BXFER-BOUNDARY", "2026-04-01");
    const csv = [HEADER, "BXFER-BOUNDARY,Center-B,2026-04-01"].join("\n");
    const res = await authedInject(app, { method: "POST", url: "/api/transfers/bulk-upload", ...csvPayload(csv) });
    expect(res.json().processed).toBe(1);
  });

  it("rejects a toLocation that isn't an active Masters center", async () => {
    await insertAsset("BXFER-BADCENTER");
    const csv = [HEADER, "BXFER-BADCENTER,Not-A-Real-Center,2026-05-01"].join("\n");
    const res = await authedInject(app, { method: "POST", url: "/api/transfers/bulk-upload", ...csvPayload(csv) });
    const body = res.json();
    expect(body.processed).toBe(0);
    expect(body.errors[0].message).toMatch(/Location "Not-A-Real-Center" not recognized/);
  });

  it("matches a center case-insensitively but stores the master list's own canonical casing", async () => {
    await insertAsset("BXFER-CASING");
    const csv = [HEADER, "BXFER-CASING,center-b,2026-05-01"].join("\n");
    const res = await authedInject(app, { method: "POST", url: "/api/transfers/bulk-upload", ...csvPayload(csv) });
    expect(res.json().processed).toBe(1);

    const db = await getPool();
    const { rows } = await db.query(`SELECT location FROM transfers WHERE far_id = 'BXFER-CASING'`);
    expect(rows[0].location).toBe("Center-B");
  });

  it("accepts a DD-MM-YYYY transfer date and rejects a malformed one with a clear message", async () => {
    await insertAsset("BXFER-DMY");
    await insertAsset("BXFER-BAD");

    const csv = [HEADER, "BXFER-DMY,Center-B,05-05-2026", "BXFER-BAD,Center-B,05-13-2026"].join("\n");
    const res = await authedInject(app, { method: "POST", url: "/api/transfers/bulk-upload", ...csvPayload(csv) });
    const body = res.json();
    expect(body.processed).toBe(1);
    expect(body.errors[0].message).toMatch(/Invalid date '05-13-2026' — expected DD-MM-YYYY/);

    const db = await getPool();
    const { rows } = await db.query(`SELECT transaction_date FROM transfers WHERE far_id = 'BXFER-DMY'`);
    expect(String(rows[0].transaction_date)).toMatch(/^2026-05-05/);
  });

  describe("Parent/child (2026-08-28)", () => {
    it("bulk-transferring a parent also moves its still-active children — the cascade gap this route used to have", async () => {
      await insertAsset("BXFER-PARENT-1");
      await insertAsset("BXFER-CHILD-1");
      const db = await getPool();
      await db.query(`UPDATE assets SET parent_far_id = 'BXFER-PARENT-1' WHERE far_id = 'BXFER-CHILD-1'`);

      const csv = [HEADER, "BXFER-PARENT-1,Center-B,2026-05-01"].join("\n");
      const res = await authedInject(app, { method: "POST", url: "/api/transfers/bulk-upload", ...csvPayload(csv) });
      expect(res.json().processed).toBe(1);

      const { rows } = await db.query(`SELECT revised_location FROM assets WHERE far_id = 'BXFER-CHILD-1'`);
      expect(rows[0].revised_location).toBe("Center-B");
      const { rows: history } = await db.query(
        `SELECT cascaded_from_parent_far_id FROM transfers WHERE far_id = 'BXFER-CHILD-1'`
      );
      expect(history[0].cascaded_from_parent_far_id).toBe("BXFER-PARENT-1");
    });

    it("does not transfer a child that's already disposed", async () => {
      await insertAsset("BXFER-PARENT-2");
      await insertAsset("BXFER-CHILD-2");
      const db = await getPool();
      await db.query(`UPDATE assets SET parent_far_id = 'BXFER-PARENT-2' WHERE far_id = 'BXFER-CHILD-2'`);
      await db.query(`UPDATE assets SET date_of_disposal = '2026-01-01', status = 'Disposed' WHERE far_id = 'BXFER-CHILD-2'`);

      const csv = [HEADER, "BXFER-PARENT-2,Center-B,2026-05-01"].join("\n");
      await authedInject(app, { method: "POST", url: "/api/transfers/bulk-upload", ...csvPayload(csv) });

      const { rows } = await db.query(`SELECT revised_location FROM assets WHERE far_id = 'BXFER-CHILD-2'`);
      expect(rows[0].revised_location).toBeNull();
    });

    it("(Rule 1) rejects a bulk row that transfers a child directly, in both preview and commit", async () => {
      await insertAsset("BXFER-PARENT-3");
      await insertAsset("BXFER-CHILD-3");
      const db = await getPool();
      await db.query(`UPDATE assets SET parent_far_id = 'BXFER-PARENT-3' WHERE far_id = 'BXFER-CHILD-3'`);

      const csv = [HEADER, "BXFER-CHILD-3,Center-B,2026-05-01"].join("\n");
      const preview = await authedInject(app, {
        method: "POST",
        url: "/api/transfers/bulk-upload?preview=true",
        ...csvPayload(csv)
      });
      expect(preview.json().rows[0].message).toMatch(/child of "BXFER-PARENT-3".*transfer the parent instead/);

      const res = await authedInject(app, { method: "POST", url: "/api/transfers/bulk-upload", ...csvPayload(csv) });
      const body = res.json();
      expect(body.processed).toBe(0);
      expect(body.errors[0].message).toMatch(/child of "BXFER-PARENT-3".*transfer the parent instead/);

      const { rows } = await db.query(`SELECT revised_location FROM assets WHERE far_id = 'BXFER-CHILD-3'`);
      expect(rows[0].revised_location).toBeNull();
    });
  });
});
