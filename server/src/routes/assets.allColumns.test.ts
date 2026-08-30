import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import assetsRoutes from "./assets.js";
import { REGISTER_COLUMNS } from "./assetColumnFilters.js";
import { getPool } from "../db/pool.js";
import { authedInject } from "../testHelpers/authTestUtils.js";
import { authGateHook } from "../auth/middleware.js";

const AS_AT = "2026-08-17";
const FY_START = "2026-04-01";
const FY_END = "2027-03-31";
const DAYS_IN_FY = 365;

function conditionsParam(conditions: unknown[]): string {
  return `conditions=${encodeURIComponent(JSON.stringify(conditions))}`;
}

// Every filterable column, driven straight from the same registry the route itself
// uses (assetColumnFilters.ts's REGISTER_COLUMNS) — a column added there without a
// matching SQL mapping, or given a SQL alias that collides with a real `assets` column
// (exactly what broke lastDateOfTransaction — see assetColumnFilters.ts's header
// comment), fails this test automatically without needing its own hand-written case.
// `notBlank` needs no value and is valid for every type (text/number/date), so it's
// purely a "does the query execute" probe — semantic correctness of individual operators
// is covered by assets.conditions.test.ts and assetsExport.test.ts.
describe("GET /api/assets: every registered filterable column executes without a server error", () => {
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
    // One fully-populated asset (parent link, addition, disposal, and a transfer) so a
    // `notBlank` condition has something real to match on every nullable column too —
    // not just a structural "the SQL parsed" check.
    await db.query(
      `INSERT INTO assets (
         far_id, sub_classification, asset_description, serial_no, status, date_acquired, location,
         useful_life_c1_years, useful_life_c2_years, c1_opening_cost, c2_opening_cost,
         additions_c1, date_of_addition, date_of_disposal, deletions_c1, deletions_c2, sale_value,
         acc_dep_c1_opening, acc_dep_c2_opening
       ) VALUES (
         'ALLCOL-PARENT', 'Test-Sub', 'Parent asset', 'SN-1', 'Disposed', '2020-01-01', 'Center-A',
         5, 5, 100000, 50000,
         10000, '2026-05-01', '2026-07-01', 110000, 50000, 5000,
         1000, 1000
       )`
    );
    await db.query(
      `INSERT INTO assets (far_id, sub_classification, asset_description, status, date_acquired, location,
         useful_life_c1_years, useful_life_c2_years, parent_far_id)
       VALUES ('ALLCOL-CHILD', 'Test-Sub', 'Child asset', 'Active', '2020-06-01', 'Center-A', 5, 5, 'ALLCOL-PARENT')`
    );
    await db.query(
      `INSERT INTO transfers (far_id, transaction_date, location) VALUES ('ALLCOL-CHILD', '2026-06-01', 'Center-B')`
    );
  });

  const columnIds = Object.keys(REGISTER_COLUMNS);

  it("sanity: the registry actually has every column Register's UI offers a filter for (not an empty/stale list)", () => {
    expect(columnIds.length).toBeGreaterThan(35);
  });

  for (const columnId of columnIds) {
    it(`"${columnId}" (${REGISTER_COLUMNS[columnId]}) filters without a 500`, async () => {
      const res = await authedInject(app, {
        method: "GET",
        url: `/api/assets?${conditionsParam([{ columnId, op: "notBlank" }])}`
      });
      expect(res.statusCode, `expected 200, got ${res.statusCode}: ${res.body}`).toBe(200);
      const body = res.json();
      expect(Array.isArray(body.items)).toBe(true);
    });
  }
});

describe("GET /api/assets: Last Transaction Date filter (regression — was a 500 due to a column-name collision)", () => {
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

  it("filters correctly on the AS_AT-aware computed value, not the raw denormalized column", async () => {
    const db = await getPool();
    // OLD-TXN: no transfers, last transaction is just its own capitalization date.
    await db.query(
      `INSERT INTO assets (far_id, sub_classification, asset_description, status, date_acquired, location, useful_life_c1_years, useful_life_c2_years)
       VALUES ('OLD-TXN', 'Test-Sub', 'No recent activity', 'Active', '2020-01-01', 'Center-A', 5, 5)`
    );
    // NEW-TXN: transferred recently — its last transaction date should be the transfer date.
    await db.query(
      `INSERT INTO assets (far_id, sub_classification, asset_description, status, date_acquired, location, useful_life_c1_years, useful_life_c2_years)
       VALUES ('NEW-TXN', 'Test-Sub', 'Recently transferred', 'Active', '2020-01-01', 'Center-A', 5, 5)`
    );
    await db.query(`INSERT INTO transfers (far_id, transaction_date, location) VALUES ('NEW-TXN', '2026-08-01', 'Center-B')`);

    const res = await authedInject(app, {
      method: "GET",
      url: `/api/assets?${conditionsParam([{ columnId: "lastDateOfTransaction", op: "after", value: "2026-01-01" }])}`
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().items;
    expect(items.map((i: { asset: { farId: string } }) => i.asset.farId)).toEqual(["NEW-TXN"]);
  });

  it("still works combined with a second filter, exactly as originally reported", async () => {
    const db = await getPool();
    await db.query(
      `INSERT INTO assets (far_id, sub_classification, asset_description, status, date_acquired, location, useful_life_c1_years, useful_life_c2_years)
       VALUES ('COMBO-1', 'Test-Sub', 'Active + recent', 'Active', '2020-01-01', 'Center-A', 5, 5)`
    );
    await db.query(`INSERT INTO transfers (far_id, transaction_date, location) VALUES ('COMBO-1', '2026-08-01', 'Center-B')`);
    await db.query(
      `INSERT INTO assets (far_id, sub_classification, asset_description, status, date_acquired, location, useful_life_c1_years, useful_life_c2_years)
       VALUES ('COMBO-2', 'Test-Sub', 'Disposed + recent', 'Disposed', '2020-01-01', 'Center-A', 5, 5)`
    );
    await db.query(`INSERT INTO transfers (far_id, transaction_date, location) VALUES ('COMBO-2', '2026-08-01', 'Center-B')`);

    const res = await authedInject(app, {
      method: "GET",
      url: `/api/assets?status=Active&${conditionsParam([{ columnId: "lastDateOfTransaction", op: "after", value: "2026-01-01" }])}`
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((i: { asset: { farId: string } }) => i.asset.farId)).toEqual(["COMBO-1"]);
  });
});

describe("GET /api/assets: an unexpected DB-level query failure is reported gracefully, not as a raw 500", () => {
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

  it("returns a plain-language JSON error, never the raw driver error text, if the list query itself throws", async () => {
    const db = await getPool();
    const originalQuery = db.query.bind(db);
    const spy = vi.spyOn(db, "query").mockImplementation((...args: unknown[]) => {
      const sql = args[0];
      // Only the main list query (identified by its ORDER BY, unique to this route) —
      // every other query this route/beforeAll issue (settings lookup, the follow-up
      // transfers fetch) must keep working normally.
      if (typeof sql === "string" && sql.includes("ORDER BY") && sql.includes("calc")) {
        return Promise.reject(
          Object.assign(new Error('column reference "some_column" is ambiguous'), { code: "42702" })
        );
      }
      return (originalQuery as (...a: unknown[]) => unknown)(...args);
    });

    try {
      const res = await authedInject(app, { method: "GET", url: "/api/assets" });
      expect(res.statusCode).toBe(500);
      const body = res.json();
      expect(body.error).not.toMatch(/ambiguous|42702|column reference/i);
      expect(body.error).toMatch(/could not load the register/i);
    } finally {
      spy.mockRestore();
    }
  });
});
