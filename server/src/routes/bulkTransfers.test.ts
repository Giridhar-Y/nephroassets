import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import bulkTransfersRoutes from "./bulkTransfers.js";
import { getPool } from "../db/pool.js";
import { csvPayload, emptyMultipartPayload } from "./bulkTestHelpers.js";

async function insertAsset(farId: string) {
  const db = await getPool();
  await db.query(
    `INSERT INTO assets (
       far_id, sub_classification, asset_description, status, date_acquired, location,
       useful_life_c1_years, useful_life_c2_years
     ) VALUES ($1, 'Test-Sub', 'Bulk transfer test asset', 'Active', '2020-01-01', 'Center-A', 5, 5)`,
    [farId]
  );
}

const HEADER = "farId,toLocation,transactionDate";

describe("Bulk Transfers: POST /api/transfers/bulk-upload", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
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
    const res = await app.inject({ method: "POST", url: "/api/transfers/bulk-upload", ...csvPayload(csv) });
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

  it("400s when no file is uploaded", async () => {
    const res = await app.inject({ method: "POST", url: "/api/transfers/bulk-upload", ...emptyMultipartPayload() });
    expect(res.statusCode).toBe(400);
  });

  it("preview mode classifies rows without transferring anything", async () => {
    await insertAsset("BXFER-1");

    const csv = [HEADER, "BXFER-1,Center-B,2026-05-01", "BXFER-9,Center-D,2026-05-01"].join("\n");
    const res = await app.inject({
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

  it("rejects a toLocation that isn't an active Masters center", async () => {
    await insertAsset("BXFER-BADCENTER");
    const csv = [HEADER, "BXFER-BADCENTER,Not-A-Real-Center,2026-05-01"].join("\n");
    const res = await app.inject({ method: "POST", url: "/api/transfers/bulk-upload", ...csvPayload(csv) });
    const body = res.json();
    expect(body.processed).toBe(0);
    expect(body.errors[0].message).toMatch(/Location "Not-A-Real-Center" not recognized/);
  });

  it("matches a center case-insensitively but stores the master list's own canonical casing", async () => {
    await insertAsset("BXFER-CASING");
    const csv = [HEADER, "BXFER-CASING,center-b,2026-05-01"].join("\n");
    const res = await app.inject({ method: "POST", url: "/api/transfers/bulk-upload", ...csvPayload(csv) });
    expect(res.json().processed).toBe(1);

    const db = await getPool();
    const { rows } = await db.query(`SELECT location FROM transfers WHERE far_id = 'BXFER-CASING'`);
    expect(rows[0].location).toBe("Center-B");
  });

  it("accepts a DD-MM-YYYY transfer date and rejects a malformed one with a clear message", async () => {
    await insertAsset("BXFER-DMY");
    await insertAsset("BXFER-BAD");

    const csv = [HEADER, "BXFER-DMY,Center-B,05-05-2026", "BXFER-BAD,Center-B,05-13-2026"].join("\n");
    const res = await app.inject({ method: "POST", url: "/api/transfers/bulk-upload", ...csvPayload(csv) });
    const body = res.json();
    expect(body.processed).toBe(1);
    expect(body.errors[0].message).toMatch(/Invalid date '05-13-2026' — expected DD-MM-YYYY/);

    const db = await getPool();
    const { rows } = await db.query(`SELECT transaction_date FROM transfers WHERE far_id = 'BXFER-DMY'`);
    expect(String(rows[0].transaction_date)).toMatch(/^2026-05-05/);
  });
});
