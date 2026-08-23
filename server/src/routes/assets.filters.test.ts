import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import assetsRoutes from "./assets.js";
import { getPool } from "../db/pool.js";
import { authedInject } from "../testHelpers/authTestUtils.js";

const AS_AT = "2026-08-17";
const FY_START = "2026-04-01";
const FY_END = "2027-03-31";
const DAYS_IN_FY = 365;

async function insertAsset(
  farId: string,
  description: string,
  overrides: { subClassification?: string; status?: string; location?: string } = {}
) {
  const db = await getPool();
  await db.query(
    `INSERT INTO assets (
       far_id, sub_classification, asset_description, status, date_acquired, location,
       useful_life_c1_years, useful_life_c2_years
     ) VALUES ($1, $2, $3, $4, '2020-01-01', $5, 5, 5)`,
    [farId, overrides.subClassification ?? "Test-Sub", description, overrides.status ?? "Active", overrides.location ?? "Center-A"]
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

    const res = await authedInject(app, { method: "GET", url: "/api/assets?descriptionSearch=dialysis" });
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].asset.farId).toBe("DESC-1");
  });

  it("combines with other filters", async () => {
    await insertAsset("DESC-3", "Backup Generator");
    await insertAsset("DESC-4", "Backup Battery");

    const res = await authedInject(app, { method: "GET", url: "/api/assets?descriptionSearch=Backup&search=DESC-3" });
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].asset.farId).toBe("DESC-3");
  });

  it("returns nothing when no description matches", async () => {
    await insertAsset("DESC-5", "Water Pump");

    const res = await authedInject(app, { method: "GET", url: "/api/assets?descriptionSearch=nonexistentterm" });
    expect(res.json().items).toHaveLength(0);
  });
});

describe("GET /api/assets: globalSearch (Register's toolbar search box)", () => {
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

  it("matches by FAR ID prefix OR description substring, unlike the AND'd column filters", async () => {
    await insertAsset("GLB-001", "Dialysis Machine");
    await insertAsset("OTHER-1", "Backup Generator");
    await insertAsset("OTHER-2", "Office Chair");

    const byFarId = await authedInject(app, { method: "GET", url: "/api/assets?globalSearch=GLB-001" });
    expect(byFarId.json().items.map((i: { asset: { farId: string } }) => i.asset.farId)).toEqual(["GLB-001"]);

    const byDescription = await authedInject(app, { method: "GET", url: "/api/assets?globalSearch=generator" });
    expect(byDescription.json().items.map((i: { asset: { farId: string } }) => i.asset.farId)).toEqual(["OTHER-1"]);
  });

  it("also matches Sub Classification, Status, and Current Location", async () => {
    await insertAsset("GLB-010", "Item A", { subClassification: "RO Plants" });
    await insertAsset("GLB-011", "Item B", { status: "Under Repair" });
    await insertAsset("GLB-012", "Item C", { location: "Center-099" });
    await insertAsset("GLB-013", "Item D"); // matches none of the three

    const bySubClass = await authedInject(app, { method: "GET", url: "/api/assets?globalSearch=RO Plants" });
    expect(bySubClass.json().items.map((i: { asset: { farId: string } }) => i.asset.farId)).toEqual(["GLB-010"]);

    const byStatus = await authedInject(app, { method: "GET", url: "/api/assets?globalSearch=Under Repair" });
    expect(byStatus.json().items.map((i: { asset: { farId: string } }) => i.asset.farId)).toEqual(["GLB-011"]);

    const byLocation = await authedInject(app, { method: "GET", url: "/api/assets?globalSearch=Center-099" });
    expect(byLocation.json().items.map((i: { asset: { farId: string } }) => i.asset.farId)).toEqual(["GLB-012"]);
  });

  it("searches the whole table, not just what a small page limit would return", async () => {
    // Insert 30 non-matching rows, then one matching row after them — with a page
    // limit of 10, a client-side "search only what's loaded" implementation would
    // never see it. The match must still come back, proving this is a server-side
    // WHERE clause, not a filter over an already-fetched page.
    for (let i = 0; i < 30; i++) {
      await insertAsset(`PAGE-${String(i).padStart(3, "0")}`, "Ordinary Asset");
    }
    await insertAsset("PAGE-030", "One-of-a-kind Widget");

    const res = await authedInject(app, { method: "GET", url: "/api/assets?globalSearch=one-of-a-kind&limit=10" });
    const body = res.json();
    expect(body.items.map((i: { asset: { farId: string } }) => i.asset.farId)).toEqual(["PAGE-030"]);
  });
});

describe("GET /api/assets: multi-value status/subClassification/center filters", () => {
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

  it("status=Active,Disposed matches either, not neither and not AND'd", async () => {
    await insertAsset("MULTI-1", "A", { status: "Active" });
    await insertAsset("MULTI-2", "B", { status: "Disposed" });
    await insertAsset("MULTI-3", "C", { status: "Under Repair" });

    const res = await authedInject(app, { method: "GET", url: "/api/assets?status=Active,Disposed" });
    const farIds = res.json().items.map((i: { asset: { farId: string } }) => i.asset.farId).sort();
    expect(farIds).toEqual(["MULTI-1", "MULTI-2"]);
  });

  it("a single value (no comma) still works exactly as before", async () => {
    await insertAsset("MULTI-4", "A", { subClassification: "RO Plants" });
    await insertAsset("MULTI-5", "B", { subClassification: "IT Equipment" });

    const res = await authedInject(app, { method: "GET", url: "/api/assets?subClassification=RO Plants" });
    expect(res.json().items.map((i: { asset: { farId: string } }) => i.asset.farId)).toEqual(["MULTI-4"]);
  });

  it("combines a multi-value center filter with another column filter (AND across fields, OR within one)", async () => {
    await insertAsset("MULTI-6", "A", { location: "Center-X", status: "Active" });
    await insertAsset("MULTI-7", "B", { location: "Center-Y", status: "Active" });
    await insertAsset("MULTI-8", "C", { location: "Center-X", status: "Disposed" });

    const res = await authedInject(app, {
      method: "GET",
      url: "/api/assets?center=Center-X,Center-Y&status=Active"
    });
    const farIds = res.json().items.map((i: { asset: { farId: string } }) => i.asset.farId).sort();
    expect(farIds).toEqual(["MULTI-6", "MULTI-7"]);
  });
});
