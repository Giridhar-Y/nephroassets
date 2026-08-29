import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import assetsRoutes from "./assets.js";
import transfersRoutes from "./transfers.js";
import deleteAuditLogRoutes from "./deleteAuditLog.js";
import { getPool } from "../db/pool.js";
import { authedInject } from "../testHelpers/authTestUtils.js";
import { authGateHook } from "../auth/middleware.js";

const NEW_ASSET = {
  farId: "AUDIT-TEST-1",
  subClassification: "Test-Sub",
  assetDescription: "Audit Log Test Asset",
  status: "Active",
  dateAcquired: "2026-01-01",
  location: "Center-Test",
  usefulLifeC1Years: 5,
  usefulLifeC2Years: 5,
  c1OpeningCost: 10000,
  c2OpeningCost: 10000
};

async function seedMasters() {
  const db = await getPool();
  await db.query(`DELETE FROM centers`);
  await db.query(`DELETE FROM sub_classifications`);
  await db.query(`DELETE FROM statuses`);
  await db.query(`INSERT INTO centers (code) VALUES ('Center-Test'), ('Center-Other')`);
  await db.query(`INSERT INTO sub_classifications (name) VALUES ('Test-Sub')`);
  await db.query(`INSERT INTO statuses (name, system_managed) VALUES ('Active', FALSE), ('Disposed', TRUE)`);
}

// GET /api/audit-log/deletes: read-only view of asset_delete_audit_log — the record of
// every Global-Admin delete/undo action (see assetDelete.test.ts for the actions
// themselves). Admin-only enforcement is covered in roles.test.ts alongside every other
// FAR-module route; this file covers listing/filtering/pagination correctness.
describe("GET /api/audit-log/deletes", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    app.decorateRequest("user", null);
    app.addHook("preHandler", authGateHook);
    await app.register(cookie);
    await app.register(assetsRoutes);
    await app.register(transfersRoutes);
    await app.register(deleteAuditLogRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const db = await getPool();
    await db.query(`DELETE FROM asset_delete_audit_log`);
    await db.query(`DELETE FROM transfers`);
    await db.query(`DELETE FROM assets`);
    await seedMasters();
    await db.query(
      `INSERT INTO settings (id, as_at, fy_start, fy_end, days_in_fy) VALUES (TRUE, '2026-08-17', '2026-04-01', '2027-03-31', 365)
       ON CONFLICT (id) DO UPDATE SET as_at = '2026-08-17', fy_start = '2026-04-01', fy_end = '2027-03-31', days_in_fy = 365`
    );
  });

  it("returns an empty list before any delete/undo action has happened", async () => {
    const res = await authedInject(app, { method: "GET", url: "/api/audit-log/deletes" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [], nextCursor: null });
  });

  it("lists a capitalization delete with actor, reason, and a details snapshot", async () => {
    await authedInject(app, { method: "POST", url: "/api/assets", payload: NEW_ASSET });
    await authedInject(app, {
      method: "DELETE",
      url: "/api/assets/AUDIT-TEST-1",
      payload: { reason: "created by mistake" }
    });

    const res = await authedInject(app, { method: "GET", url: "/api/audit-log/deletes" });
    expect(res.statusCode).toBe(200);
    const { items } = res.json();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      action: "capitalization_delete",
      farId: "AUDIT-TEST-1",
      transferId: null,
      reason: "created by mistake"
    });
    expect(items[0].actorUsername).toBeTruthy();
    expect(items[0].details.assetDescription).toBe("Audit Log Test Asset");
    expect(typeof items[0].createdAt).toBe("string");
  });

  it("lists a transfer delete with its transferId populated", async () => {
    await authedInject(app, { method: "POST", url: "/api/assets", payload: NEW_ASSET });
    await authedInject(app, {
      method: "POST",
      url: "/api/transfers",
      payload: { farIds: ["AUDIT-TEST-1"], toLocation: "Center-Other", transactionDate: "2026-06-01" }
    });
    const db = await getPool();
    const { rows } = await db.query<{ id: string }>(`SELECT id FROM transfers WHERE far_id = 'AUDIT-TEST-1'`);
    const transferId = Number(rows[0]!.id);

    await authedInject(app, {
      method: "DELETE",
      url: `/api/transfers/${transferId}`,
      payload: { reason: "recorded in error" }
    });

    const res = await authedInject(app, { method: "GET", url: "/api/audit-log/deletes" });
    const { items } = res.json();
    expect(items).toHaveLength(1);
    expect(items[0].action).toBe("transfer_delete");
    expect(items[0].transferId).toBe(transferId);
  });

  it("returns newest first", async () => {
    await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, farId: "AUDIT-TEST-A" } });
    await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, farId: "AUDIT-TEST-B" } });
    await authedInject(app, { method: "DELETE", url: "/api/assets/AUDIT-TEST-A", payload: { reason: "first" } });
    await authedInject(app, { method: "DELETE", url: "/api/assets/AUDIT-TEST-B", payload: { reason: "second" } });

    const res = await authedInject(app, { method: "GET", url: "/api/audit-log/deletes" });
    const { items } = res.json();
    expect(items.map((i: { farId: string }) => i.farId)).toEqual(["AUDIT-TEST-B", "AUDIT-TEST-A"]);
  });

  it("filters by FAR ID (contains, case-insensitive)", async () => {
    await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, farId: "AUDIT-MATCH-1" } });
    await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, farId: "OTHER-2" } });
    await authedInject(app, { method: "DELETE", url: "/api/assets/AUDIT-MATCH-1", payload: { reason: "test" } });
    await authedInject(app, { method: "DELETE", url: "/api/assets/OTHER-2", payload: { reason: "test" } });

    const res = await authedInject(app, { method: "GET", url: "/api/audit-log/deletes?farId=match" });
    const { items } = res.json();
    expect(items).toHaveLength(1);
    expect(items[0].farId).toBe("AUDIT-MATCH-1");
  });

  it("filters by action", async () => {
    await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, farId: "AUDIT-ACTION-1" } });
    await authedInject(app, {
      method: "PATCH",
      url: "/api/assets/AUDIT-ACTION-1/addition",
      payload: { additionsC1: 1000, additionsC2: 0, dateOfAddition: "2026-06-01" }
    });
    await authedInject(app, {
      method: "POST",
      url: "/api/assets/AUDIT-ACTION-1/addition/undo",
      payload: { reason: "test" }
    });
    await authedInject(app, { method: "DELETE", url: "/api/assets/AUDIT-ACTION-1", payload: { reason: "test" } });

    const res = await authedInject(app, { method: "GET", url: "/api/audit-log/deletes?action=addition_undo" });
    const { items } = res.json();
    expect(items).toHaveLength(1);
    expect(items[0].action).toBe("addition_undo");
  });

  it("filters by date range", async () => {
    await authedInject(app, { method: "POST", url: "/api/assets", payload: NEW_ASSET });
    await authedInject(app, { method: "DELETE", url: "/api/assets/AUDIT-TEST-1", payload: { reason: "test" } });

    // IST, not UTC — matches the server's own AT TIME ZONE 'Asia/Kolkata' comparison.
    // new Date().toISOString() alone would disagree with the server for roughly the
    // first 5.5 hours of every UTC day (IST is UTC+5:30), which is exactly the kind of
    // narrow, hard-to-reproduce timing bug this explicit conversion avoids.
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
    const past = "2000-01-01";
    const future = "2999-01-01";

    const withinRange = await authedInject(app, {
      method: "GET",
      url: `/api/audit-log/deletes?dateFrom=${past}&dateTo=${future}`
    });
    expect(withinRange.json().items).toHaveLength(1);

    const outsideRange = await authedInject(app, {
      method: "GET",
      url: `/api/audit-log/deletes?dateFrom=${future}`
    });
    expect(outsideRange.json().items).toHaveLength(0);

    const fromToday = await authedInject(app, {
      method: "GET",
      url: `/api/audit-log/deletes?dateFrom=${today}&dateTo=${today}`
    });
    expect(fromToday.json().items).toHaveLength(1);
  });

  it("paginates with a keyset cursor — newest-first order preserved across pages, no repeats or gaps", async () => {
    for (const farId of ["AUDIT-PAGE-1", "AUDIT-PAGE-2", "AUDIT-PAGE-3"]) {
      await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, farId } });
      await authedInject(app, { method: "DELETE", url: `/api/assets/${farId}`, payload: { reason: "test" } });
    }

    const page1 = await authedInject(app, { method: "GET", url: "/api/audit-log/deletes?limit=1" });
    const body1 = page1.json();
    expect(body1.items).toHaveLength(1);
    expect(body1.items[0].farId).toBe("AUDIT-PAGE-3");
    expect(body1.nextCursor).toBeTruthy();

    const page2 = await authedInject(app, {
      method: "GET",
      url: `/api/audit-log/deletes?limit=1&cursor=${body1.nextCursor}`
    });
    const body2 = page2.json();
    expect(body2.items).toHaveLength(1);
    expect(body2.items[0].farId).toBe("AUDIT-PAGE-2");

    const page3 = await authedInject(app, {
      method: "GET",
      url: `/api/audit-log/deletes?limit=1&cursor=${body2.nextCursor}`
    });
    const body3 = page3.json();
    expect(body3.items).toHaveLength(1);
    expect(body3.items[0].farId).toBe("AUDIT-PAGE-1");

    // Same convention as every other cursor-paginated endpoint in this app (e.g.
    // GET /api/transfers): a full page's own nextCursor is non-null even when it
    // happens to be the last page with data — exhaustion is only confirmed by the
    // NEXT fetch coming back empty, not by inspecting the last real page's cursor.
    expect(body3.nextCursor).toBeTruthy();
    const page4 = await authedInject(app, {
      method: "GET",
      url: `/api/audit-log/deletes?limit=1&cursor=${body3.nextCursor}`
    });
    const body4 = page4.json();
    expect(body4.items).toHaveLength(0);
    expect(body4.nextCursor).toBeNull();
  });

  it("rejects an invalid query with 400", async () => {
    const res = await authedInject(app, { method: "GET", url: "/api/audit-log/deletes?action=not-a-real-action" });
    expect(res.statusCode).toBe(400);
  });
});
