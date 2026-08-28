import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import assetsRoutes from "./assets.js";
import { getPool } from "../db/pool.js";
import { authedInject } from "../testHelpers/authTestUtils.js";

const AS_AT = "2026-08-17";
const FY_START = "2026-04-01";
const FY_END = "2027-03-31";
const DAYS_IN_FY = 365;

// A very long useful life keeps this period's depreciation negligible relative to cost,
// so C1 NBV stays close enough to C1 Opening Cost that two assets with a clearly
// different cost never risk landing on the wrong side of a threshold in between them —
// without needing to replicate the calc engine's day-count math in this test.
async function insertAsset(
  farId: string,
  overrides: {
    description?: string;
    dateAcquired?: string;
    c1OpeningCost?: number;
    dateOfDisposal?: string | null;
    saleValue?: number;
  } = {}
) {
  const db = await getPool();
  await db.query(
    `INSERT INTO assets (
       far_id, sub_classification, asset_description, status, date_acquired, location,
       useful_life_c1_years, useful_life_c2_years, c1_opening_cost, deletions_c1, sale_value, date_of_disposal
     ) VALUES ($1, 'Test-Sub', $2, 'Active', $3, 'Center-A', 1000, 1000, $4, $5, $6, $7)`,
    [
      farId,
      overrides.description ?? "Ordinary Asset",
      overrides.dateAcquired ?? "2020-01-01",
      overrides.c1OpeningCost ?? 100000,
      overrides.dateOfDisposal ? overrides.c1OpeningCost ?? 100000 : 0,
      overrides.saleValue ?? 0,
      overrides.dateOfDisposal ?? null
    ]
  );
}

function conditionsParam(conditions: unknown[]): string {
  return `conditions=${encodeURIComponent(JSON.stringify(conditions))}`;
}

describe("GET /api/assets: Excel-style column conditions", () => {
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

  it("a text condition (contains) matches server-side, same as the existing named filters", async () => {
    await insertAsset("COND-1", { description: "Dialysis Machine — Ward 3" });
    await insertAsset("COND-2", { description: "Office Chair" });

    const res = await authedInject(app, {
      method: "GET",
      url: `/api/assets?${conditionsParam([{ columnId: "assetDescription", op: "contains", value: "dialysis" }])}`
    });
    const items = res.json().items;
    expect(items.map((i: { asset: { farId: string } }) => i.asset.farId)).toEqual(["COND-1"]);
  });

  it("a text condition (beginsWith) on FAR ID", async () => {
    await insertAsset("PFX-100");
    await insertAsset("OTHER-1");

    const res = await authedInject(app, {
      method: "GET",
      url: `/api/assets?${conditionsParam([{ columnId: "farId", op: "beginsWith", value: "PFX" }])}`
    });
    expect(res.json().items.map((i: { asset: { farId: string } }) => i.asset.farId)).toEqual(["PFX-100"]);
  });

  it("a number condition on a computed field (C1 NBV) filters at the database level via far_calc_component", async () => {
    await insertAsset("NUM-LOW", { c1OpeningCost: 50000 });
    await insertAsset("NUM-HIGH", { c1OpeningCost: 900000 });

    const res = await authedInject(app, {
      method: "GET",
      url: `/api/assets?${conditionsParam([{ columnId: "c1Nbv", op: "gt", value: "500000" }])}`
    });
    expect(res.json().items.map((i: { asset: { farId: string } }) => i.asset.farId)).toEqual(["NUM-HIGH"]);
  });

  it("a number condition's between operator uses both bounds", async () => {
    await insertAsset("BETW-1", { c1OpeningCost: 10000 });
    await insertAsset("BETW-2", { c1OpeningCost: 60000 });
    await insertAsset("BETW-3", { c1OpeningCost: 200000 });

    const res = await authedInject(app, {
      method: "GET",
      url: `/api/assets?${conditionsParam([{ columnId: "c1OpeningCost", op: "between", value: "20000", valueTo: "100000" }])}`
    });
    expect(res.json().items.map((i: { asset: { farId: string } }) => i.asset.farId)).toEqual(["BETW-2"]);
  });

  it("blank/notBlank on a disposal-only computed field (C1 WDV) distinguishes disposed from active assets", async () => {
    await insertAsset("DISP-1", { dateOfDisposal: "2026-06-01", saleValue: 1000 });
    await insertAsset("ACTIVE-1");

    const disposedOnly = await authedInject(app, {
      method: "GET",
      url: `/api/assets?${conditionsParam([{ columnId: "c1Wdv", op: "notBlank" }])}`
    });
    expect(disposedOnly.json().items.map((i: { asset: { farId: string } }) => i.asset.farId)).toEqual(["DISP-1"]);

    const activeOnly = await authedInject(app, {
      method: "GET",
      url: `/api/assets?${conditionsParam([{ columnId: "c1Wdv", op: "blank" }])}`
    });
    expect(activeOnly.json().items.map((i: { asset: { farId: string } }) => i.asset.farId)).toEqual(["ACTIVE-1"]);
  });

  it("a date condition (before/after) on Date Acquired", async () => {
    await insertAsset("DATE-OLD", { dateAcquired: "2019-01-01" });
    await insertAsset("DATE-NEW", { dateAcquired: "2026-01-01" });

    const before = await authedInject(app, {
      method: "GET",
      url: `/api/assets?${conditionsParam([{ columnId: "dateAcquired", op: "before", value: "2020-01-01" }])}`
    });
    expect(before.json().items.map((i: { asset: { farId: string } }) => i.asset.farId)).toEqual(["DATE-OLD"]);

    const after = await authedInject(app, {
      method: "GET",
      url: `/api/assets?${conditionsParam([{ columnId: "dateAcquired", op: "after", value: "2025-01-01" }])}`
    });
    expect(after.json().items.map((i: { asset: { farId: string } }) => i.asset.farId)).toEqual(["DATE-NEW"]);
  });

  it("multiple conditions AND together, same as the existing named filters do", async () => {
    await insertAsset("AND-1", { description: "Backup Generator", c1OpeningCost: 900000 });
    await insertAsset("AND-2", { description: "Backup Battery", c1OpeningCost: 50000 });

    const res = await authedInject(app, {
      method: "GET",
      url: `/api/assets?${conditionsParam([
        { columnId: "assetDescription", op: "contains", value: "Backup" },
        { columnId: "c1Nbv", op: "gt", value: "500000" }
      ])}`
    });
    expect(res.json().items.map((i: { asset: { farId: string } }) => i.asset.farId)).toEqual(["AND-1"]);
  });

  it("combines with an existing named filter (AND across the two mechanisms)", async () => {
    await insertAsset("MIX-1", { description: "Widget A", c1OpeningCost: 900000 });
    await insertAsset("MIX-2", { description: "Widget B", c1OpeningCost: 900000 });

    const res = await authedInject(app, {
      method: "GET",
      url: `/api/assets?search=MIX-1&${conditionsParam([{ columnId: "c1Nbv", op: "gt", value: "500000" }])}`
    });
    expect(res.json().items.map((i: { asset: { farId: string } }) => i.asset.farId)).toEqual(["MIX-1"]);
  });

  it("an unknown columnId is rejected with 400, not silently ignored", async () => {
    const res = await authedInject(app, {
      method: "GET",
      url: `/api/assets?${conditionsParam([{ columnId: "notARealColumn", op: "equals", value: "x" }])}`
    });
    expect(res.statusCode).toBe(400);
  });

  it("filtering still composes correctly with cursor pagination — a filtered set spread across multiple small pages returns every match exactly once", async () => {
    for (let i = 0; i < 4; i++) {
      await insertAsset(`PAGE-MATCH-${i}`, { description: "One-of-a-kind Widget" });
    }
    for (let i = 0; i < 4; i++) {
      await insertAsset(`PAGE-SKIP-${i}`, { description: "Ordinary Item" });
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `/api/assets?${conditionsParam([
        { columnId: "assetDescription", op: "contains", value: "one-of-a-kind" }
      ])}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res = await authedInject(app, { method: "GET", url });
      const body = res.json();
      seen.push(...body.items.map((i: { asset: { farId: string } }) => i.asset.farId));
      cursor = body.nextCursor;
      pages++;
      expect(pages).toBeLessThan(10); // guard against an infinite loop if this regresses
    } while (cursor);

    expect(pages).toBeGreaterThan(1); // proves multiple pages were actually walked
    expect(seen.sort()).toEqual(["PAGE-MATCH-0", "PAGE-MATCH-1", "PAGE-MATCH-2", "PAGE-MATCH-3"]);
  });
});
