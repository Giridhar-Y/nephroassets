import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import transfersRoutes from "./transfers.js";
import { getPool } from "../db/pool.js";
import { authedInject } from "../testHelpers/authTestUtils.js";
import { authGateHook } from "../auth/middleware.js";

async function insertAsset(farId: string, description = "Transfer History Asset", dateAcquired = "2020-01-01") {
  const db = await getPool();
  await db.query(
    `INSERT INTO assets (
       far_id, sub_classification, asset_description, status, date_acquired, location,
       useful_life_c1_years, useful_life_c2_years
     ) VALUES ($1, 'Test-Sub', $2, 'Active', $3, 'Center-A', 5, 5)`,
    [farId, description, dateAcquired]
  );
}

describe("Transfers", () => {
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
    // toLocation is now validated against the active Centers master list
    // (routes/masters.ts) — seed the ones these fixtures move assets to.
    await db.query(`DELETE FROM centers`);
    await db.query(
      `INSERT INTO centers (code) VALUES ('Center-A'), ('Center-B'), ('Center-C'), ('Center-D'), ('Center-1'), ('Center-2'), ('Center-3')`
    );
  });

  it("creates a transfer and moves the asset's revised location", async () => {
    await insertAsset("XFER-1");
    const res = await authedInject(app, {
      method: "POST",
      url: "/api/transfers",
      payload: { farIds: ["XFER-1"], toLocation: "Center-B", transactionDate: "2026-05-01" }
    });
    expect(res.statusCode).toBe(200);

    const db = await getPool();
    const { rows } = await db.query(`SELECT revised_location FROM assets WHERE far_id = 'XFER-1'`);
    expect(rows[0].revised_location).toBe("Center-B");
  });

  it("rejects a transfer dated before the asset's capitalization date", async () => {
    await insertAsset("XFER-EARLY", "Transfer History Asset", "2026-04-01");
    const res = await authedInject(app, {
      method: "POST",
      url: "/api/transfers",
      payload: { farIds: ["XFER-EARLY"], toLocation: "Center-B", transactionDate: "2026-03-15" }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Transfer date cannot be before the asset's capitalization date/);
    expect(res.json().error).toMatch(/01-04-2026/);

    const db = await getPool();
    const { rows } = await db.query(`SELECT revised_location FROM assets WHERE far_id = 'XFER-EARLY'`);
    expect(rows[0].revised_location).toBeNull();
  });

  it("allows a transfer dated exactly on the asset's capitalization date (boundary is >=, not >)", async () => {
    await insertAsset("XFER-BOUNDARY", "Transfer History Asset", "2026-04-01");
    const res = await authedInject(app, {
      method: "POST",
      url: "/api/transfers",
      payload: { farIds: ["XFER-BOUNDARY"], toLocation: "Center-B", transactionDate: "2026-04-01" }
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects the whole batch if any selected asset's transfer date is before its capitalization date", async () => {
    await insertAsset("XFER-BATCH-OK", "Transfer History Asset", "2020-01-01");
    await insertAsset("XFER-BATCH-BAD", "Transfer History Asset", "2026-04-01");
    const res = await authedInject(app, {
      method: "POST",
      url: "/api/transfers",
      payload: { farIds: ["XFER-BATCH-OK", "XFER-BATCH-BAD"], toLocation: "Center-B", transactionDate: "2026-03-15" }
    });
    expect(res.statusCode).toBe(400);

    const db = await getPool();
    const { rows } = await db.query(
      `SELECT far_id, revised_location FROM assets WHERE far_id IN ('XFER-BATCH-OK', 'XFER-BATCH-BAD')`
    );
    // Neither asset was moved — the whole transaction was rejected up front, not just
    // the offending row.
    expect(rows.every((r) => r.revised_location === null)).toBe(true);
  });

  it("rejects a toLocation that isn't an active Masters center", async () => {
    await insertAsset("XFER-BADCENTER");
    const res = await authedInject(app, {
      method: "POST",
      url: "/api/transfers",
      payload: { farIds: ["XFER-BADCENTER"], toLocation: "Not-A-Real-Center", transactionDate: "2026-05-01" }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Location "Not-A-Real-Center" not recognized/);
  });

  it("matches a center case-insensitively but stores the master list's own canonical casing", async () => {
    await insertAsset("XFER-CASING");
    const res = await authedInject(app, {
      method: "POST",
      url: "/api/transfers",
      payload: { farIds: ["XFER-CASING"], toLocation: "center-b", transactionDate: "2026-05-01" }
    });
    expect(res.statusCode).toBe(200);

    const db = await getPool();
    const { rows } = await db.query(`SELECT revised_location FROM assets WHERE far_id = 'XFER-CASING'`);
    expect(rows[0].revised_location).toBe("Center-B");
  });

  it("GET /api/transfers lists history newest first, with asset description", async () => {
    await insertAsset("XFER-2");
    await authedInject(app, {
      method: "POST",
      url: "/api/transfers",
      payload: { farIds: ["XFER-2"], toLocation: "Center-B", transactionDate: "2026-05-01" }
    });
    await authedInject(app, {
      method: "POST",
      url: "/api/transfers",
      payload: { farIds: ["XFER-2"], toLocation: "Center-C", transactionDate: "2026-06-01" }
    });

    const res = await authedInject(app, { method: "GET", url: "/api/transfers" });
    expect(res.statusCode).toBe(200);
    const { items } = res.json();
    expect(items).toHaveLength(2);
    expect(items[0].location).toBe("Center-C");
    expect(items[0].assetDescription).toBe("Transfer History Asset");
    expect(items[1].location).toBe("Center-B");
  });

  it("reports From Location as the capitalized location for a first transfer, and the prior transfer's destination for a later one", async () => {
    await insertAsset("XFER-FROM", "Transfer History Asset", "2020-01-01"); // capitalized at Center-A
    await authedInject(app, {
      method: "POST",
      url: "/api/transfers",
      payload: { farIds: ["XFER-FROM"], toLocation: "Center-B", transactionDate: "2026-05-01" }
    });
    await authedInject(app, {
      method: "POST",
      url: "/api/transfers",
      payload: { farIds: ["XFER-FROM"], toLocation: "Center-C", transactionDate: "2026-06-01" }
    });

    const res = await authedInject(app, { method: "GET", url: "/api/transfers" });
    const { items } = res.json();
    const second = items.find((i: { location: string }) => i.location === "Center-C");
    const first = items.find((i: { location: string }) => i.location === "Center-B");
    expect(second.fromLocation).toBe("Center-B");
    expect(first.fromLocation).toBe("Center-A");
  });

  it("From Location is unaffected by filters that exclude the prior transfer from the result set", async () => {
    // A window-function (LAG) implementation would get this wrong: filtering the
    // outer query down to just the Center-C leg would make LAG see no prior row within
    // the filtered set and fall back incorrectly, instead of finding the true prior
    // transfer (to Center-B) that a correlated subquery over the unfiltered table finds.
    await insertAsset("XFER-FROM-FILTERED", "Transfer History Asset", "2020-01-01");
    await authedInject(app, {
      method: "POST",
      url: "/api/transfers",
      payload: { farIds: ["XFER-FROM-FILTERED"], toLocation: "Center-B", transactionDate: "2026-05-01" }
    });
    await authedInject(app, {
      method: "POST",
      url: "/api/transfers",
      payload: { farIds: ["XFER-FROM-FILTERED"], toLocation: "Center-C", transactionDate: "2026-06-01" }
    });

    const res = await authedInject(app, { method: "GET", url: "/api/transfers?location=Center-C" });
    const { items } = res.json();
    expect(items).toHaveLength(1);
    expect(items[0].fromLocation).toBe("Center-B");
  });

  it("filters history by FAR ID search", async () => {
    await insertAsset("XFER-3");
    await insertAsset("OTHER-1");
    await authedInject(app, {
      method: "POST",
      url: "/api/transfers",
      payload: { farIds: ["XFER-3"], toLocation: "Center-B", transactionDate: "2026-05-01" }
    });
    await authedInject(app, {
      method: "POST",
      url: "/api/transfers",
      payload: { farIds: ["OTHER-1"], toLocation: "Center-B", transactionDate: "2026-05-01" }
    });

    const res = await authedInject(app, { method: "GET", url: "/api/transfers?search=XFER" });
    const { items } = res.json();
    expect(items).toHaveLength(1);
    expect(items[0].farId).toBe("XFER-3");
  });

  it("filters history by destination location (Moved To)", async () => {
    await insertAsset("XFER-5");
    await authedInject(app, {
      method: "POST",
      url: "/api/transfers",
      payload: { farIds: ["XFER-5"], toLocation: "Center-B", transactionDate: "2026-05-01" }
    });
    await authedInject(app, {
      method: "POST",
      url: "/api/transfers",
      payload: { farIds: ["XFER-5"], toLocation: "Center-C", transactionDate: "2026-06-01" }
    });

    const res = await authedInject(app, { method: "GET", url: "/api/transfers?location=Center-B" });
    const { items } = res.json();
    expect(items).toHaveLength(1);
    expect(items[0].location).toBe("Center-B");
  });

  it("filters history by multiple destination locations at once", async () => {
    await insertAsset("XFER-9");
    await authedInject(app, {
      method: "POST",
      url: "/api/transfers",
      payload: { farIds: ["XFER-9"], toLocation: "Center-B", transactionDate: "2026-05-01" }
    });
    await authedInject(app, {
      method: "POST",
      url: "/api/transfers",
      payload: { farIds: ["XFER-9"], toLocation: "Center-C", transactionDate: "2026-06-01" }
    });
    await authedInject(app, {
      method: "POST",
      url: "/api/transfers",
      payload: { farIds: ["XFER-9"], toLocation: "Center-D", transactionDate: "2026-07-01" }
    });

    const res = await authedInject(app, { method: "GET", url: "/api/transfers?location=Center-B,Center-D" });
    const { items } = res.json();
    const locations = items.map((i: { location: string }) => i.location).sort();
    expect(locations).toEqual(["Center-B", "Center-D"]);
  });

  it("filters history by transaction date range", async () => {
    await insertAsset("XFER-6");
    await authedInject(app, {
      method: "POST",
      url: "/api/transfers",
      payload: { farIds: ["XFER-6"], toLocation: "Center-B", transactionDate: "2026-01-01" }
    });
    await authedInject(app, {
      method: "POST",
      url: "/api/transfers",
      payload: { farIds: ["XFER-6"], toLocation: "Center-C", transactionDate: "2026-06-01" }
    });

    const res = await authedInject(app, {
      method: "GET",
      url: "/api/transfers?transactionDateFrom=2026-05-01&transactionDateTo=2026-07-01"
    });
    const { items } = res.json();
    expect(items).toHaveLength(1);
    expect(items[0].location).toBe("Center-C");
  });

  it("filters history by asset description search", async () => {
    await insertAsset("XFER-7", "Dialysis Machine");
    await insertAsset("XFER-8", "Office Chair");
    await authedInject(app, {
      method: "POST",
      url: "/api/transfers",
      payload: { farIds: ["XFER-7"], toLocation: "Center-B", transactionDate: "2026-05-01" }
    });
    await authedInject(app, {
      method: "POST",
      url: "/api/transfers",
      payload: { farIds: ["XFER-8"], toLocation: "Center-B", transactionDate: "2026-05-01" }
    });

    const res = await authedInject(app, { method: "GET", url: "/api/transfers?descriptionSearch=dialysis" });
    const { items } = res.json();
    expect(items).toHaveLength(1);
    expect(items[0].farId).toBe("XFER-7");
  });

  it("paginates with a cursor", async () => {
    await insertAsset("XFER-4");
    for (let i = 1; i <= 3; i++) {
      await authedInject(app, {
        method: "POST",
        url: "/api/transfers",
        payload: { farIds: ["XFER-4"], toLocation: `Center-${i}`, transactionDate: "2026-05-01" }
      });
    }

    const first = await authedInject(app, { method: "GET", url: "/api/transfers?limit=2" });
    const firstBody = first.json();
    expect(firstBody.items).toHaveLength(2);
    expect(firstBody.nextCursor).not.toBeNull();

    const second = await authedInject(app, { method: "GET", url: `/api/transfers?limit=2&cursor=${firstBody.nextCursor}` });
    const secondBody = second.json();
    expect(secondBody.items).toHaveLength(1);
    expect(secondBody.nextCursor).toBeNull();
  });

  describe("Parent/child cascade", () => {
    it("transferring a parent also transfers its still-active children", async () => {
      await insertAsset("XFER-PARENT-1");
      await insertAsset("XFER-CHILD-1");
      const db = await getPool();
      await db.query(`UPDATE assets SET parent_far_id = 'XFER-PARENT-1' WHERE far_id = 'XFER-CHILD-1'`);

      const res = await authedInject(app, {
        method: "POST",
        url: "/api/transfers",
        payload: { farIds: ["XFER-PARENT-1"], toLocation: "Center-B", transactionDate: "2026-05-01" }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().childrenIncluded).toEqual(["XFER-CHILD-1"]);

      const { rows } = await db.query(
        `SELECT far_id, revised_location FROM assets WHERE far_id IN ('XFER-PARENT-1', 'XFER-CHILD-1')`
      );
      expect(rows.every((r) => r.revised_location === "Center-B")).toBe(true);
    });

    it("does not transfer a child that's already disposed", async () => {
      await insertAsset("XFER-PARENT-2");
      await insertAsset("XFER-CHILD-2");
      const db = await getPool();
      await db.query(`UPDATE assets SET parent_far_id = 'XFER-PARENT-2' WHERE far_id = 'XFER-CHILD-2'`);
      await db.query(`UPDATE assets SET date_of_disposal = '2026-04-01', status = 'Disposed' WHERE far_id = 'XFER-CHILD-2'`);

      const res = await authedInject(app, {
        method: "POST",
        url: "/api/transfers",
        payload: { farIds: ["XFER-PARENT-2"], toLocation: "Center-B", transactionDate: "2026-05-01" }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().childrenIncluded).toEqual([]);

      const { rows } = await db.query(`SELECT revised_location FROM assets WHERE far_id = 'XFER-CHILD-2'`);
      expect(rows[0].revised_location).toBeNull();
    });

    it("does not double-transfer a child that was also explicitly selected, but still marks it cascaded (its parent moved too)", async () => {
      await insertAsset("XFER-PARENT-3");
      await insertAsset("XFER-CHILD-3");
      const db = await getPool();
      await db.query(`UPDATE assets SET parent_far_id = 'XFER-PARENT-3' WHERE far_id = 'XFER-CHILD-3'`);

      const res = await authedInject(app, {
        method: "POST",
        url: "/api/transfers",
        payload: { farIds: ["XFER-PARENT-3", "XFER-CHILD-3"], toLocation: "Center-B", transactionDate: "2026-05-01" }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().transferred).toBe(2);

      const { rows } = await db.query(`SELECT far_id, cascaded_from_parent_far_id FROM transfers WHERE far_id = 'XFER-CHILD-3'`);
      expect(rows).toHaveLength(1);
      // The audit note is mechanical, not intent-based — this child's parent_far_id was
      // also moving in the same batch (e.g. Register's checkbox auto-select already
      // includes active children in what it sends), so it's still correctly "cascaded"
      // even though its FAR ID was also literally present in the request.
      expect(rows[0].cascaded_from_parent_far_id).toBe("XFER-PARENT-3");
    });

    it("marks a cascaded child's transfer row with the parent it cascaded from, and leaves the parent's own row null", async () => {
      await insertAsset("XFER-PARENT-4");
      await insertAsset("XFER-CHILD-4");
      const db = await getPool();
      await db.query(`UPDATE assets SET parent_far_id = 'XFER-PARENT-4' WHERE far_id = 'XFER-CHILD-4'`);

      await authedInject(app, {
        method: "POST",
        url: "/api/transfers",
        payload: { farIds: ["XFER-PARENT-4"], toLocation: "Center-B", transactionDate: "2026-05-01" }
      });

      const { rows: parentRows } = await db.query(
        `SELECT cascaded_from_parent_far_id FROM transfers WHERE far_id = 'XFER-PARENT-4'`
      );
      expect(parentRows[0].cascaded_from_parent_far_id).toBeNull();
      const { rows: childRows } = await db.query(
        `SELECT cascaded_from_parent_far_id FROM transfers WHERE far_id = 'XFER-CHILD-4'`
      );
      expect(childRows[0].cascaded_from_parent_far_id).toBe("XFER-PARENT-4");
    });

    it("leaves a cascaded child's cost, quantity, and useful life fully independent of the transfer", async () => {
      await insertAsset("XFER-PARENT-5");
      const db = await getPool();
      await db.query(
        `INSERT INTO assets (
           far_id, sub_classification, asset_description, status, date_acquired, location,
           useful_life_c1_years, useful_life_c2_years, qty, c1_opening_cost, c2_opening_cost, parent_far_id
         ) VALUES ('XFER-CHILD-5', 'Test-Sub', 'Child Asset', 'Active', '2020-01-01', 'Center-A', 7, 3, 4, 12345, 6789, 'XFER-PARENT-5')`
      );

      await authedInject(app, {
        method: "POST",
        url: "/api/transfers",
        payload: { farIds: ["XFER-PARENT-5"], toLocation: "Center-B", transactionDate: "2026-05-01" }
      });

      const { rows } = await db.query(
        `SELECT qty, useful_life_c1_years, useful_life_c2_years, c1_opening_cost, c2_opening_cost
         FROM assets WHERE far_id = 'XFER-CHILD-5'`
      );
      expect(Number(rows[0].qty)).toBe(4);
      expect(Number(rows[0].useful_life_c1_years)).toBe(7);
      expect(Number(rows[0].useful_life_c2_years)).toBe(3);
      expect(Number(rows[0].c1_opening_cost)).toBe(12345);
      expect(Number(rows[0].c2_opening_cost)).toBe(6789);
    });
  });
});
