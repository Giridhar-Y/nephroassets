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
});
