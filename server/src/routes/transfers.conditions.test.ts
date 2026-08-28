import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import transfersRoutes from "./transfers.js";
import { TRANSFER_COLUMNS } from "./transferColumnFilters.js";
import { getPool } from "../db/pool.js";
import { authedInject } from "../testHelpers/authTestUtils.js";
import { authGateHook } from "../auth/middleware.js";

async function insertAsset(farId: string, description = "Transfer History Asset", location = "Center-A") {
  const db = await getPool();
  await db.query(
    `INSERT INTO assets (
       far_id, sub_classification, asset_description, status, date_acquired, location,
       useful_life_c1_years, useful_life_c2_years
     ) VALUES ($1, 'Test-Sub', $2, 'Active', '2020-01-01', $3, 5, 5)`,
    [farId, description, location]
  );
}

async function insertTransfer(farId: string, transactionDate: string, toLocation: string) {
  const db = await getPool();
  await db.query(`INSERT INTO transfers (far_id, transaction_date, location) VALUES ($1, $2, $3)`, [
    farId,
    transactionDate,
    toLocation
  ]);
}

function conditionsParam(conditions: unknown[]): string {
  return `conditions=${encodeURIComponent(JSON.stringify(conditions))}`;
}

describe("GET /api/transfers: Excel-style column conditions", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    app.decorateRequest("user", null);
    app.addHook("preHandler", authGateHook);
    await app.register(cookie);
    await app.register(transfersRoutes);
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

  it("a text condition (contains) on Description filters server-side", async () => {
    await insertAsset("COND-1", "Dialysis Machine");
    await insertAsset("COND-2", "Office Chair");
    await insertTransfer("COND-1", "2026-06-01", "Center-B");
    await insertTransfer("COND-2", "2026-06-01", "Center-B");

    const res = await authedInject(app, {
      method: "GET",
      url: `/api/transfers?${conditionsParam([{ columnId: "assetDescription", op: "contains", value: "dialysis" }])}`
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((i: { farId: string }) => i.farId)).toEqual(["COND-1"]);
  });

  it("a date condition on Transfer Date", async () => {
    await insertAsset("COND-3");
    await insertAsset("COND-4");
    await insertTransfer("COND-3", "2020-01-15", "Center-B");
    await insertTransfer("COND-4", "2026-06-01", "Center-B");

    const res = await authedInject(app, {
      method: "GET",
      url: `/api/transfers?${conditionsParam([{ columnId: "transactionDate", op: "after", value: "2025-01-01" }])}`
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((i: { farId: string }) => i.farId)).toEqual(["COND-4"]);
  });

  it("filters on To Location", async () => {
    await insertAsset("COND-5");
    await insertAsset("COND-6");
    await insertTransfer("COND-5", "2026-06-01", "Center-X");
    await insertTransfer("COND-6", "2026-06-01", "Center-Y");

    const res = await authedInject(app, {
      method: "GET",
      url: `/api/transfers?${conditionsParam([{ columnId: "toLocation", op: "equals", value: "Center-X" }])}`
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((i: { farId: string }) => i.farId)).toEqual(["COND-5"]);
  });

  it("filters on From Location (the column this whole round was named for — previously had no filter UI at all)", async () => {
    await insertAsset("COND-7", "Asset A", "Center-Origin");
    await insertAsset("COND-8", "Asset B", "Center-Other");
    // COND-7's from_location resolves to its capitalized location (Center-Origin) since
    // this is its first-ever transfer.
    await insertTransfer("COND-7", "2026-06-01", "Center-Z");
    await insertTransfer("COND-8", "2026-06-01", "Center-Z");

    const res = await authedInject(app, {
      method: "GET",
      url: `/api/transfers?${conditionsParam([{ columnId: "fromLocation", op: "equals", value: "Center-Origin" }])}`
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((i: { farId: string }) => i.farId)).toEqual(["COND-7"]);
  });

  it("filters on FAR ID", async () => {
    await insertAsset("COND-PREFIX-1");
    await insertAsset("OTHER-1");
    await insertTransfer("COND-PREFIX-1", "2026-06-01", "Center-B");
    await insertTransfer("OTHER-1", "2026-06-01", "Center-B");

    const res = await authedInject(app, {
      method: "GET",
      url: `/api/transfers?${conditionsParam([{ columnId: "farId", op: "beginsWith", value: "COND-PREFIX" }])}`
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((i: { farId: string }) => i.farId)).toEqual(["COND-PREFIX-1"]);
  });

  it("combines a condition with an existing named filter (AND across the two mechanisms)", async () => {
    await insertAsset("COND-9");
    await insertAsset("COND-10");
    await insertTransfer("COND-9", "2026-06-01", "Center-B");
    await insertTransfer("COND-10", "2026-06-01", "Center-C");

    const res = await authedInject(app, {
      method: "GET",
      url: `/api/transfers?location=Center-B,Center-C&${conditionsParam([{ columnId: "farId", op: "equals", value: "COND-9" }])}`
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((i: { farId: string }) => i.farId)).toEqual(["COND-9"]);
  });

  it("an unknown columnId is rejected with 400, not silently ignored", async () => {
    const res = await authedInject(app, {
      method: "GET",
      url: `/api/transfers?${conditionsParam([{ columnId: "notARealColumn", op: "equals", value: "x" }])}`
    });
    expect(res.statusCode).toBe(400);
  });

  it("filtering composes correctly with cursor pagination — a filtered set spread across multiple small pages returns every match exactly once", async () => {
    for (let i = 0; i < 4; i++) {
      await insertAsset(`PAGE-MATCH-${i}`, "One-of-a-kind Widget");
      await insertTransfer(`PAGE-MATCH-${i}`, "2026-06-01", "Center-B");
    }
    for (let i = 0; i < 4; i++) {
      await insertAsset(`PAGE-SKIP-${i}`, "Ordinary Item");
      await insertTransfer(`PAGE-SKIP-${i}`, "2026-06-01", "Center-B");
    }

    const seen: string[] = [];
    let cursor: number | null = null;
    let pages = 0;
    do {
      const url: string = `/api/transfers?${conditionsParam([
        { columnId: "assetDescription", op: "contains", value: "one-of-a-kind" }
      ])}&limit=2${cursor !== null ? `&cursor=${cursor}` : ""}`;
      const res = await authedInject(app, { method: "GET", url });
      const body = res.json();
      seen.push(...body.items.map((i: { farId: string }) => i.farId));
      cursor = body.nextCursor;
      pages++;
      expect(pages).toBeLessThan(10);
    } while (cursor !== null);

    expect(pages).toBeGreaterThan(1);
    expect(seen.sort()).toEqual(["PAGE-MATCH-0", "PAGE-MATCH-1", "PAGE-MATCH-2", "PAGE-MATCH-3"]);
  });

  it("returns a plain-language JSON error, never the raw driver error text, if the query itself throws unexpectedly", async () => {
    await insertAsset("DBFAIL-1");
    await insertTransfer("DBFAIL-1", "2026-06-01", "Center-B");
    const db = await getPool();
    const originalQuery = db.query.bind(db);
    const spy = vi.spyOn(db, "query").mockImplementation((...args: unknown[]) => {
      const sql = args[0];
      if (typeof sql === "string" && sql.includes("WITH log AS")) {
        return Promise.reject(Object.assign(new Error('column reference "some_column" is ambiguous'), { code: "42702" }));
      }
      return (originalQuery as (...a: unknown[]) => unknown)(...args);
    });

    try {
      const res = await authedInject(app, { method: "GET", url: "/api/transfers" });
      expect(res.statusCode).toBe(500);
      const body = res.json();
      expect(body.error).not.toMatch(/ambiguous|42702|column reference/i);
      expect(body.error).toMatch(/could not load the transfer log/i);
    } finally {
      spy.mockRestore();
    }
  });
});

// Every filterable column, driven straight from TRANSFER_COLUMNS (not a hand-maintained
// list) — same regression pattern as assets.allColumns.test.ts, built proactively this
// time rather than after a user-reported crash.
describe("GET /api/transfers: every registered filterable column executes without a server error", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    app.decorateRequest("user", null);
    app.addHook("preHandler", authGateHook);
    await app.register(cookie);
    await app.register(transfersRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const db = await getPool();
    await db.query(`DELETE FROM transfers`);
    await db.query(`DELETE FROM assets`);
    await insertAsset("ALLCOL-1", "Fully populated asset", "Center-Origin");
    await insertTransfer("ALLCOL-1", "2026-06-01", "Center-Z");
  });

  const columnIds = Object.keys(TRANSFER_COLUMNS);

  it("sanity: the registry actually has all 5 columns the Transfer Log UI offers a filter for", () => {
    expect(columnIds.length).toBe(5);
  });

  for (const columnId of columnIds) {
    it(`"${columnId}" (${TRANSFER_COLUMNS[columnId]}) filters without a 500`, async () => {
      const res = await authedInject(app, {
        method: "GET",
        url: `/api/transfers?${conditionsParam([{ columnId, op: "notBlank" }])}`
      });
      expect(res.statusCode, `expected 200, got ${res.statusCode}: ${res.body}`).toBe(200);
      expect(Array.isArray(res.json().items)).toBe(true);
    });
  }
});
