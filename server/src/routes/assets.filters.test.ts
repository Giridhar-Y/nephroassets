import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import assetsRoutes from "./assets.js";
import { getPool } from "../db/pool.js";
import { authedInject } from "../testHelpers/authTestUtils.js";
import { authGateHook } from "../auth/middleware.js";

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

describe("GET /api/assets: an asset never appears before its own capitalization date", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    app.decorateRequest("user", null);
    app.addHook("preHandler", authGateHook);
    await app.register(cookie);
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
    // Capitalized mid-way through the current FY (2026-04-01 to 2027-03-31).
    await db.query(
      `INSERT INTO assets (
         far_id, sub_classification, asset_description, status, date_acquired, location,
         useful_life_c1_years, useful_life_c2_years, c1_opening_cost
       ) VALUES ('THIS-FY-ASSET', 'Test-Sub', 'Capitalized this FY', 'Active', '2026-06-01', 'Center-A', 5, 5, 100000)`
    );
  });

  it("is excluded from the list when AS_AT is a prior-FY date, before it existed", async () => {
    const res = await authedInject(app, { method: "GET", url: "/api/assets?asAt=2026-03-31" });
    const items = res.json().items;
    expect(items.some((i: { asset: { farId: string } }) => i.asset.farId === "THIS-FY-ASSET")).toBe(false);
  });

  it("is included once AS_AT reaches its capitalization date", async () => {
    const res = await authedInject(app, { method: "GET", url: "/api/assets?asAt=2026-06-01" });
    const items = res.json().items;
    expect(items.some((i: { asset: { farId: string } }) => i.asset.farId === "THIS-FY-ASSET")).toBe(true);
  });

  it("is excluded the day before its capitalization date (boundary is exclusive)", async () => {
    const res = await authedInject(app, { method: "GET", url: "/api/assets?asAt=2026-05-31" });
    const items = res.json().items;
    expect(items.some((i: { asset: { farId: string } }) => i.asset.farId === "THIS-FY-ASSET")).toBe(false);
  });

  it("an explicit dateAcquiredTo filter still combines correctly with the always-on AS_AT gate", async () => {
    // dateAcquiredTo alone would have let this asset through even at a prior AS_AT
    // under the old bug — proves the two conditions are AND'd, not one replacing the other.
    const res = await authedInject(app, {
      method: "GET",
      url: "/api/assets?asAt=2026-03-31&dateAcquiredTo=2026-12-31"
    });
    const items = res.json().items;
    expect(items.some((i: { asset: { farId: string } }) => i.asset.farId === "THIS-FY-ASSET")).toBe(false);
  });
});

describe("GET /api/assets: hasAddition filter (Additions Log)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    app.decorateRequest("user", null);
    app.addHook("preHandler", authGateHook);
    await app.register(cookie);
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
    await db.query(
      `INSERT INTO assets (far_id, sub_classification, asset_description, status, date_acquired, location, useful_life_c1_years, useful_life_c2_years, additions_c1, date_of_addition)
       VALUES ('HAS-ADD-1', 'Test-Sub', 'Has an addition', 'Active', '2020-01-01', 'Center-A', 5, 5, 50000, '2026-05-01')`
    );
    await db.query(
      `INSERT INTO assets (far_id, sub_classification, asset_description, status, date_acquired, location, useful_life_c1_years, useful_life_c2_years)
       VALUES ('NO-ADD-1', 'Test-Sub', 'No addition', 'Active', '2020-01-01', 'Center-A', 5, 5)`
    );
  });

  it("hasAddition=true returns only assets with a non-zero addition recorded", async () => {
    const res = await authedInject(app, { method: "GET", url: "/api/assets?hasAddition=true" });
    const items = res.json().items;
    expect(items).toHaveLength(1);
    expect(items[0].asset.farId).toBe("HAS-ADD-1");
  });

  it("omitting hasAddition returns every asset", async () => {
    const res = await authedInject(app, { method: "GET", url: "/api/assets" });
    const items = res.json().items;
    expect(items.map((i: { asset: { farId: string } }) => i.asset.farId).sort()).toEqual(["HAS-ADD-1", "NO-ADD-1"]);
  });
});

describe("GET /api/assets: descriptionSearch filter", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    app.decorateRequest("user", null);
    app.addHook("preHandler", authGateHook);
    await app.register(cookie);
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
    app.decorateRequest("user", null);
    app.addHook("preHandler", authGateHook);
    await app.register(cookie);
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
    app.decorateRequest("user", null);
    app.addHook("preHandler", authGateHook);
    await app.register(cookie);
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

describe("GET /api/assets: capLocation filter (Capitalized Location)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    app.decorateRequest("user", null);
    app.addHook("preHandler", authGateHook);
    await app.register(cookie);
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

  it("filters on the raw capitalization location, unaffected by a later transfer", async () => {
    await insertAsset("CAPLOC-1", "A", { location: "Center-X" });
    await insertAsset("CAPLOC-2", "B", { location: "Center-Y" });
    const db = await getPool();
    // CAPLOC-1 has since moved to Center-Y — capLocation should still find it under its
    // original Center-X, unlike the existing `center` (current-location) filter.
    await db.query(`UPDATE assets SET revised_location = 'Center-Y' WHERE far_id = 'CAPLOC-1'`);

    const res = await authedInject(app, { method: "GET", url: "/api/assets?capLocation=Center-X" });
    expect(res.json().items.map((i: { asset: { farId: string } }) => i.asset.farId)).toEqual(["CAPLOC-1"]);
  });

  it("a transferred asset no longer matches its old center (current-location) filter, but still matches capLocation", async () => {
    await insertAsset("CAPLOC-3", "A", { location: "Center-X" });
    const db = await getPool();
    await db.query(`UPDATE assets SET revised_location = 'Center-Y' WHERE far_id = 'CAPLOC-3'`);

    const byCenter = await authedInject(app, { method: "GET", url: "/api/assets?center=Center-X" });
    expect(byCenter.json().items).toHaveLength(0);

    const byCapLocation = await authedInject(app, { method: "GET", url: "/api/assets?capLocation=Center-X" });
    expect(byCapLocation.json().items.map((i: { asset: { farId: string } }) => i.asset.farId)).toEqual(["CAPLOC-3"]);
  });
});
