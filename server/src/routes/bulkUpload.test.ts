import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import bulkUploadRoutes from "./bulkUpload.js";
import { getPool } from "../db/pool.js";
import { csvPayload, emptyMultipartPayload } from "./bulkTestHelpers.js";

const HEADER =
  "farId,subClassification,assetDescription,status,dateAcquired,location,usefulLifeC1Years,usefulLifeC2Years,c1OpeningCost,c2OpeningCost";

describe("Bulk Upload: POST /api/assets/bulk-upload", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(multipart);
    await app.register(bulkUploadRoutes);
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

  it("upserts valid rows and reports errors for invalid ones", async () => {
    const csv = [
      HEADER,
      "BULK-1,Test-Sub,Bulk Asset One,Active,2020-01-01,Center-A,5,5,1000,1000",
      "BULK-2,,Bulk Asset Missing Sub,Active,2020-01-01,Center-A,5,5,1000,1000"
    ].join("\n");

    const res = await app.inject({ method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(csv) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.processed).toBe(1);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].farId).toBe("BULK-2");

    const db = await getPool();
    const { rows } = await db.query(`SELECT far_id FROM assets WHERE far_id = 'BULK-1'`);
    expect(rows).toHaveLength(1);
  });

  it("re-uploading the same FAR ID updates the existing asset instead of erroring", async () => {
    const first = [HEADER, "BULK-3,Test-Sub,Original,Active,2020-01-01,Center-A,5,5,1000,1000"].join("\n");
    await app.inject({ method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(first) });

    const second = [HEADER, "BULK-3,Test-Sub,Updated Description,Active,2020-01-01,Center-A,5,5,2000,2000"].join(
      "\n"
    );
    const res = await app.inject({ method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(second) });
    expect(res.json().processed).toBe(1);

    const db = await getPool();
    const { rows } = await db.query(`SELECT asset_description, c1_opening_cost FROM assets WHERE far_id = 'BULK-3'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].asset_description).toBe("Updated Description");
    expect(rows[0].c1_opening_cost).toBe("2000");
  });

  it("400s when no file is uploaded", async () => {
    const res = await app.inject({ method: "POST", url: "/api/assets/bulk-upload", ...emptyMultipartPayload() });
    expect(res.statusCode).toBe(400);
  });

  it("accepts DD-MM-YYYY dates, and reports a clear error for a malformed one", async () => {
    const csv = [
      HEADER,
      "BULK-DMY,Test-Sub,DD-MM-YYYY Asset,Active,25-12-2023,Center-A,5,5,1000,1000",
      "BULK-BAD,Test-Sub,Bad Date Asset,Active,31-13-2023,Center-A,5,5,1000,1000"
    ].join("\n");
    const res = await app.inject({ method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(csv) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.processed).toBe(1);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].message).toMatch(/Invalid date '31-13-2023' — expected DD-MM-YYYY/);

    const db = await getPool();
    const { rows } = await db.query(`SELECT date_acquired FROM assets WHERE far_id = 'BULK-DMY'`);
    expect(String(rows[0].date_acquired)).toMatch(/^2023-12-25/);
  });

  it("also accepts a plain ISO date (e.g. a real Date-typed .xlsx cell already normalized)", async () => {
    const csv = [HEADER, "BULK-ISO,Test-Sub,ISO Date Asset,Active,2023-12-25,Center-A,5,5,1000,1000"].join("\n");
    const res = await app.inject({ method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(csv) });
    expect(res.json().processed).toBe(1);

    const db = await getPool();
    const { rows } = await db.query(`SELECT date_acquired FROM assets WHERE far_id = 'BULK-ISO'`);
    expect(String(rows[0].date_acquired)).toMatch(/^2023-12-25/);
  });

  it("preview mode classifies new vs. update rows without writing anything", async () => {
    const csv = [
      HEADER,
      "BULK-1,Test-Sub,Bulk Asset One,Active,2020-01-01,Center-A,5,5,1000,1000",
      "BULK-2,,Bulk Asset Missing Sub,Active,2020-01-01,Center-A,5,5,1000,1000"
    ].join("\n");
    await app.inject({ method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(csv) });

    const second = [
      HEADER,
      "BULK-1,Test-Sub,Bulk Asset One Updated,Active,2020-01-01,Center-A,5,5,1000,1000",
      "BULK-4,Test-Sub,Bulk Asset Four,Active,2020-01-01,Center-A,5,5,1000,1000"
    ].join("\n");
    const res = await app.inject({ method: "POST", url: "/api/assets/bulk-upload?preview=true", ...csvPayload(second) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.summary).toEqual({ new: 1, update: 1, error: 0 });
    expect(body.rows.find((r: { farId: string }) => r.farId === "BULK-1").status).toBe("update");
    expect(body.rows.find((r: { farId: string }) => r.farId === "BULK-4").status).toBe("new");

    const db = await getPool();
    const { rows } = await db.query(`SELECT asset_description FROM assets WHERE far_id = 'BULK-1'`);
    expect(rows[0].asset_description).toBe("Bulk Asset One");
    const { rows: notCreated } = await db.query(`SELECT far_id FROM assets WHERE far_id = 'BULK-4'`);
    expect(notCreated).toHaveLength(0);
  });
});
