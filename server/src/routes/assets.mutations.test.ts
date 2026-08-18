import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import assetsRoutes from "./assets.js";
import { getPool } from "../db/pool.js";

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

describe("Capitalization: POST /api/assets", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
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
    await db.query(
      `INSERT INTO settings (id, as_at, fy_start, fy_end, days_in_fy) VALUES (TRUE, '2026-08-17', '2026-04-01', '2027-03-31', 365)
       ON CONFLICT (id) DO UPDATE SET as_at = '2026-08-17', fy_start = '2026-04-01', fy_end = '2027-03-31', days_in_fy = 365`
    );
  });

  it("creates a new asset and it appears in the register", async () => {
    const create = await app.inject({ method: "POST", url: "/api/assets", payload: NEW_ASSET });
    expect(create.statusCode).toBe(200);
    expect(create.json()).toEqual({ farId: "CAP-TEST-1", created: true });

    const list = await app.inject({ method: "GET", url: "/api/assets?asAt=2026-08-17" });
    const items = list.json().items;
    expect(items.some((i: { asset: { farId: string } }) => i.asset.farId === "CAP-TEST-1")).toBe(true);
  });

  it("rejects a duplicate FAR ID", async () => {
    await app.inject({ method: "POST", url: "/api/assets", payload: NEW_ASSET });
    const dup = await app.inject({ method: "POST", url: "/api/assets", payload: NEW_ASSET });
    expect(dup.statusCode).toBe(409);
  });

  it("rejects a payload missing required fields", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/assets",
      payload: { farId: "CAP-BAD-1" }
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("Disposal: PATCH /api/assets/:farId/disposal", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
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
    await app.inject({ method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, farId: "DISP-TEST-1" } });
  });

  it("fully disposes an asset: deletions become the full capitalized cost", async () => {
    const res = await app.inject({
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

  it("rejects disposing the same asset twice", async () => {
    await app.inject({
      method: "PATCH",
      url: "/api/assets/DISP-TEST-1/disposal",
      payload: { dateOfDisposal: "2026-08-01", saleValue: 500 }
    });
    const second = await app.inject({
      method: "PATCH",
      url: "/api/assets/DISP-TEST-1/disposal",
      payload: { dateOfDisposal: "2026-08-05", saleValue: 100 }
    });
    expect(second.statusCode).toBe(409);
  });

  it("404s for an unknown FAR ID", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/assets/DOES-NOT-EXIST/disposal",
      payload: { dateOfDisposal: "2026-08-01", saleValue: 0 }
    });
    expect(res.statusCode).toBe(404);
  });
});
