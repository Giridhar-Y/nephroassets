import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import assetsRoutes from "./assets.js";
import { getPool } from "../db/pool.js";

const AS_AT = "2026-08-17";
const FY_START = "2026-04-01";
const FY_END = "2027-03-31";
const DAYS_IN_FY = 365;

async function insertAsset(farId: string, description: string) {
  const db = await getPool();
  await db.query(
    `INSERT INTO assets (
       far_id, sub_classification, asset_description, status, date_acquired, location,
       useful_life_c1_years, useful_life_c2_years
     ) VALUES ($1, 'Test-Sub', $2, 'Active', '2020-01-01', 'Center-A', 5, 5)`,
    [farId, description]
  );
}

describe("GET /api/assets: descriptionSearch filter", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(assetsRoutes);
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

  it("matches a case-insensitive substring anywhere in the description", async () => {
    await insertAsset("DESC-1", "Dialysis Machine — Ward 3");
    await insertAsset("DESC-2", "Office Chair");

    const res = await app.inject({ method: "GET", url: "/api/assets?descriptionSearch=dialysis" });
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].asset.farId).toBe("DESC-1");
  });

  it("combines with other filters", async () => {
    await insertAsset("DESC-3", "Backup Generator");
    await insertAsset("DESC-4", "Backup Battery");

    const res = await app.inject({ method: "GET", url: "/api/assets?descriptionSearch=Backup&search=DESC-3" });
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].asset.farId).toBe("DESC-3");
  });

  it("returns nothing when no description matches", async () => {
    await insertAsset("DESC-5", "Water Pump");

    const res = await app.inject({ method: "GET", url: "/api/assets?descriptionSearch=nonexistentterm" });
    expect(res.json().items).toHaveLength(0);
  });
});
