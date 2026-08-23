import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import assetsRoutes from "./assets.js";
import transfersRoutes from "./transfers.js";
import { getPool } from "../db/pool.js";
import { authedInject } from "../testHelpers/authTestUtils.js";

const AS_AT = "2026-08-17";
const FY_START = "2026-04-01";
const FY_END = "2027-03-31";
const DAYS_IN_FY = 365;

async function insertAsset(farId: string, overrides: Record<string, unknown> = {}) {
  const db = await getPool();
  const row = {
    far_id: farId,
    sub_classification: "Test-Sub",
    asset_description: `Asset 360 test ${farId}`,
    status: "Active",
    date_acquired: "2020-01-01",
    location: "Center-A",
    useful_life_c1_years: 5,
    useful_life_c2_years: 5,
    c1_opening_cost: 10000,
    c2_opening_cost: 0,
    ...overrides
  };
  const columns = Object.keys(row);
  const values = Object.values(row);
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
  await db.query(`INSERT INTO assets (${columns.join(", ")}) VALUES (${placeholders})`, values);
}

describe("GET /api/assets/:farId (Asset 360)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(assetsRoutes);
    await app.register(transfersRoutes);
    await app.ready();

    const db = await getPool();
    await db.query(
      `INSERT INTO settings (id, as_at, fy_start, fy_end, days_in_fy) VALUES (TRUE, $1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET as_at = $1, fy_start = $2, fy_end = $3, days_in_fy = $4`,
      [AS_AT, FY_START, FY_END, DAYS_IN_FY]
    );
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const db = await getPool();
    await db.query(`DELETE FROM transfers`);
    await db.query(`DELETE FROM assets`);
  });

  it("returns the asset, its computed result, and full transfer history", async () => {
    await insertAsset("A360-1");
    await authedInject(app, {
      method: "POST",
      url: "/api/transfers",
      payload: { farIds: ["A360-1"], toLocation: "Center-B", transactionDate: "2022-01-01" }
    });
    await authedInject(app, {
      method: "POST",
      url: "/api/transfers",
      payload: { farIds: ["A360-1"], toLocation: "Center-C", transactionDate: "2024-06-01" }
    });

    const res = await authedInject(app, { method: "GET", url: "/api/assets/A360-1" });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.asset.farId).toBe("A360-1");
    expect(body.result.effectiveLocation).toBe("Center-C");
    expect(body.transfers).toHaveLength(2);
    expect(body.transfers[0].location).toBe("Center-B");
    expect(body.transfers[1].location).toBe("Center-C");
    expect(body.asAt).toBe(AS_AT);
  });

  it("exact-matches the FAR ID, unlike the prefix-matching list search", async () => {
    await insertAsset("A360-2");
    await insertAsset("A360-20"); // shares a prefix with A360-2
    await authedInject(app, {
      method: "POST",
      url: "/api/transfers",
      payload: { farIds: ["A360-20"], toLocation: "Center-Z", transactionDate: "2022-01-01" }
    });

    const res = await authedInject(app, { method: "GET", url: "/api/assets/A360-2" });
    expect(res.json().asset.farId).toBe("A360-2");
    expect(res.json().transfers).toHaveLength(0); // must not pick up A360-20's transfer
  });

  it("404s for an unknown FAR ID", async () => {
    const res = await authedInject(app, { method: "GET", url: "/api/assets/DOES-NOT-EXIST" });
    expect(res.statusCode).toBe(404);
  });

  it("includes disposal fields directly on the asset when disposed", async () => {
    await insertAsset("A360-3", {
      status: "Disposed",
      date_of_disposal: "2026-05-01",
      deletions_c1: 10000,
      sale_value: 500
    });

    const res = await authedInject(app, { method: "GET", url: "/api/assets/A360-3" });
    const body = res.json();
    expect(body.asset.dateOfDisposal).toBe("2026-05-01");
    expect(body.asset.saleValue).toBe(500);
    expect(body.result.c1.wdvAtDisposal).not.toBeNull();
  });
});
