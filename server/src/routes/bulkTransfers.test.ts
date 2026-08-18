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
});
