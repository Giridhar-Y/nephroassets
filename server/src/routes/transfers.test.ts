import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import transfersRoutes from "./transfers.js";
import { getPool } from "../db/pool.js";

async function insertAsset(farId: string, description = "Transfer History Asset") {
  const db = await getPool();
  await db.query(
    `INSERT INTO assets (
       far_id, sub_classification, asset_description, status, date_acquired, location,
       useful_life_c1_years, useful_life_c2_years
     ) VALUES ($1, 'Test-Sub', $2, 'Active', '2020-01-01', 'Center-A', 5, 5)`,
    [farId, description]
  );
}

describe("Transfers", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
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

  it("creates a transfer and moves the asset's revised location", async () => {
    await insertAsset("XFER-1");
    const res = await app.inject({
      method: "POST",
      url: "/api/transfers",
      payload: { farIds: ["XFER-1"], toLocation: "Center-B", transactionDate: "2026-05-01" }
    });
    expect(res.statusCode).toBe(200);

    const db = await getPool();
    const { rows } = await db.query(`SELECT revised_location FROM assets WHERE far_id = 'XFER-1'`);
    expect(rows[0].revised_location).toBe("Center-B");
  });

  it("GET /api/transfers lists history newest first, with asset description", async () => {
    await insertAsset("XFER-2");
    await app.inject({
      method: "POST",
      url: "/api/transfers",
      payload: { farIds: ["XFER-2"], toLocation: "Center-B", transactionDate: "2026-05-01" }
    });
    await app.inject({
      method: "POST",
      url: "/api/transfers",
      payload: { farIds: ["XFER-2"], toLocation: "Center-C", transactionDate: "2026-06-01" }
    });

    const res = await app.inject({ method: "GET", url: "/api/transfers" });
    expect(res.statusCode).toBe(200);
    const { items } = res.json();
    expect(items).toHaveLength(2);
    expect(items[0].location).toBe("Center-C");
    expect(items[0].assetDescription).toBe("Transfer History Asset");
    expect(items[1].location).toBe("Center-B");
  });

  it("filters history by FAR ID search", async () => {
    await insertAsset("XFER-3");
    await insertAsset("OTHER-1");
    await app.inject({
      method: "POST",
      url: "/api/transfers",
      payload: { farIds: ["XFER-3"], toLocation: "Center-B", transactionDate: "2026-05-01" }
    });
    await app.inject({
      method: "POST",
      url: "/api/transfers",
      payload: { farIds: ["OTHER-1"], toLocation: "Center-B", transactionDate: "2026-05-01" }
    });

    const res = await app.inject({ method: "GET", url: "/api/transfers?search=XFER" });
    const { items } = res.json();
    expect(items).toHaveLength(1);
    expect(items[0].farId).toBe("XFER-3");
  });

  it("filters history by destination location (Moved To)", async () => {
    await insertAsset("XFER-5");
    await app.inject({
      method: "POST",
      url: "/api/transfers",
      payload: { farIds: ["XFER-5"], toLocation: "Center-B", transactionDate: "2026-05-01" }
    });
    await app.inject({
      method: "POST",
      url: "/api/transfers",
      payload: { farIds: ["XFER-5"], toLocation: "Center-C", transactionDate: "2026-06-01" }
    });

    const res = await app.inject({ method: "GET", url: "/api/transfers?location=Center-B" });
    const { items } = res.json();
    expect(items).toHaveLength(1);
    expect(items[0].location).toBe("Center-B");
  });

  it("filters history by multiple destination locations at once", async () => {
    await insertAsset("XFER-9");
    await app.inject({
      method: "POST",
      url: "/api/transfers",
      payload: { farIds: ["XFER-9"], toLocation: "Center-B", transactionDate: "2026-05-01" }
    });
    await app.inject({
      method: "POST",
      url: "/api/transfers",
      payload: { farIds: ["XFER-9"], toLocation: "Center-C", transactionDate: "2026-06-01" }
    });
    await app.inject({
      method: "POST",
      url: "/api/transfers",
      payload: { farIds: ["XFER-9"], toLocation: "Center-D", transactionDate: "2026-07-01" }
    });

    const res = await app.inject({ method: "GET", url: "/api/transfers?location=Center-B,Center-D" });
    const { items } = res.json();
    const locations = items.map((i: { location: string }) => i.location).sort();
    expect(locations).toEqual(["Center-B", "Center-D"]);
  });

  it("filters history by transaction date range", async () => {
    await insertAsset("XFER-6");
    await app.inject({
      method: "POST",
      url: "/api/transfers",
      payload: { farIds: ["XFER-6"], toLocation: "Center-B", transactionDate: "2026-01-01" }
    });
    await app.inject({
      method: "POST",
      url: "/api/transfers",
      payload: { farIds: ["XFER-6"], toLocation: "Center-C", transactionDate: "2026-06-01" }
    });

    const res = await app.inject({
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
    await app.inject({
      method: "POST",
      url: "/api/transfers",
      payload: { farIds: ["XFER-7"], toLocation: "Center-B", transactionDate: "2026-05-01" }
    });
    await app.inject({
      method: "POST",
      url: "/api/transfers",
      payload: { farIds: ["XFER-8"], toLocation: "Center-B", transactionDate: "2026-05-01" }
    });

    const res = await app.inject({ method: "GET", url: "/api/transfers?descriptionSearch=dialysis" });
    const { items } = res.json();
    expect(items).toHaveLength(1);
    expect(items[0].farId).toBe("XFER-7");
  });

  it("paginates with a cursor", async () => {
    await insertAsset("XFER-4");
    for (let i = 1; i <= 3; i++) {
      await app.inject({
        method: "POST",
        url: "/api/transfers",
        payload: { farIds: ["XFER-4"], toLocation: `Center-${i}`, transactionDate: "2026-05-01" }
      });
    }

    const first = await app.inject({ method: "GET", url: "/api/transfers?limit=2" });
    const firstBody = first.json();
    expect(firstBody.items).toHaveLength(2);
    expect(firstBody.nextCursor).not.toBeNull();

    const second = await app.inject({ method: "GET", url: `/api/transfers?limit=2&cursor=${firstBody.nextCursor}` });
    const secondBody = second.json();
    expect(secondBody.items).toHaveLength(1);
    expect(secondBody.nextCursor).toBeNull();
  });
});
