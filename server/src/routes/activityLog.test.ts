import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import cookie from "@fastify/cookie";
import ExcelJS from "exceljs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import assetsRoutes from "./assets.js";
import transfersRoutes from "./transfers.js";
import bulkUploadRoutes from "./bulkUpload.js";
import bulkTransfersRoutes from "./bulkTransfers.js";
import bulkDisposalsRoutes from "./bulkDisposals.js";
import mastersRoutes from "./masters.js";
import bulkMastersRoutes from "./bulkMasters.js";
import activityLogRoutes, { resolveFinancialYear } from "./activityLog.js";
import { getPool } from "../db/pool.js";
import { authedInject } from "../testHelpers/authTestUtils.js";
import { authGateHook } from "../auth/middleware.js";
import { csvPayload } from "./bulkTestHelpers.js";

// Pure function, no app/DB needed — isolated from the rest of this file's Fastify+DB
// suite so the boundary math itself is pinned down directly rather than only inferred
// from whatever dates happen to land in a live export test. All timestamps are picked
// well clear of the IST offset (UTC+5:30) so there's no ambiguity about which calendar
// day they fall on in Asia/Kolkata.
describe("resolveFinancialYear (FY boundary math)", () => {
  it("a date exactly on the FY start date belongs to the new FY", () => {
    expect(resolveFinancialYear("2026-04-01T10:00:00Z", 4, 1)).toBe("FY 2026-27");
  });

  it("the day before FY start belongs to the previous FY — a different label from the start date itself", () => {
    expect(resolveFinancialYear("2026-03-31T10:00:00Z", 4, 1)).toBe("FY 2025-26");
  });

  it("the day after FY start stays in the same FY as the start date", () => {
    expect(resolveFinancialYear("2026-04-02T10:00:00Z", 4, 1)).toBe("FY 2026-27");
  });

  it("the last day of an FY (the day before the NEXT year's start date) still belongs to the earlier FY", () => {
    expect(resolveFinancialYear("2027-03-31T10:00:00Z", 4, 1)).toBe("FY 2026-27");
  });

  it("a date several years before the configured fy_start still resolves correctly — the year-rollback math doesn't drift for older entries", () => {
    expect(resolveFinancialYear("2020-04-01T10:00:00Z", 4, 1)).toBe("FY 2020-21");
    expect(resolveFinancialYear("2020-03-31T10:00:00Z", 4, 1)).toBe("FY 2019-20");
    expect(resolveFinancialYear("2015-06-15T10:00:00Z", 4, 1)).toBe("FY 2015-16");
    expect(resolveFinancialYear("2015-01-15T10:00:00Z", 4, 1)).toBe("FY 2014-15");
  });

  it("respects a non-April FY start configured in Settings, not a hardcoded April 1", () => {
    // A July 1 FY start: June 30 is the last day of the OLD FY, July 1 starts the new one.
    expect(resolveFinancialYear("2026-06-30T10:00:00Z", 7, 1)).toBe("FY 2025-26");
    expect(resolveFinancialYear("2026-07-01T10:00:00Z", 7, 1)).toBe("FY 2026-27");
  });

  it("a timestamp near the IST day boundary still resolves against the IST calendar date, not UTC's", () => {
    // 2026-03-31T19:00:00Z is already 2026-04-01 00:30 IST (UTC+5:30) — the new FY.
    expect(resolveFinancialYear("2026-03-31T19:00:00Z", 4, 1)).toBe("FY 2026-27");
    // 2026-03-31T17:00:00Z is still 2026-03-31 22:30 IST — the old FY.
    expect(resolveFinancialYear("2026-03-31T17:00:00Z", 4, 1)).toBe("FY 2025-26");
  });
});

const NEW_ASSET = {
  farId: "ACT-TEST-1",
  subClassification: "Test-Sub",
  assetDescription: "Activity Log Test Asset",
  status: "Active",
  dateAcquired: "2026-01-01",
  location: "Center-Test",
  usefulLifeC1Years: 5,
  usefulLifeC2Years: 5,
  c1OpeningCost: 10000,
  c2OpeningCost: 10000
};

const BULK_HEADER =
  "farId,subClassification,assetDescription,status,dateAcquired,location,usefulLifeC1Years,usefulLifeC2Years,c1OpeningCost,c2OpeningCost";

async function seedMasters() {
  const db = await getPool();
  await db.query(`DELETE FROM centers`);
  await db.query(`DELETE FROM sub_classifications`);
  await db.query(`DELETE FROM statuses`);
  await db.query(`INSERT INTO centers (code) VALUES ('Center-Test'), ('Center-Other')`);
  await db.query(`INSERT INTO sub_classifications (name) VALUES ('Test-Sub')`);
  await db.query(`INSERT INTO statuses (name, system_managed) VALUES ('Active', FALSE), ('Disposed', TRUE)`);
}

// GET /api/audit-log/activity: one consolidated feed over asset_activity_log (every
// Capitalization/Addition/Transfer/Disposal CREATE event), asset_delete_audit_log
// (every Global-Admin delete/undo — the former standalone Delete Log, now the "delete"
// category here instead of its own page), and master_activity_log (every Masters
// create/rename/deactivate/reactivate, the "masters" category). Editor+ enforcement is
// covered in roles.test.ts; this file covers that each write path actually logs, the
// category filter groups things correctly, and listing/filtering/pagination work across
// all three sources merged together.
describe("Activity Log", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    app.decorateRequest("user", null);
    app.addHook("preHandler", authGateHook);
    await app.register(cookie);
    await app.register(multipart);
    await app.register(assetsRoutes);
    await app.register(transfersRoutes);
    await app.register(bulkUploadRoutes);
    await app.register(bulkTransfersRoutes);
    await app.register(bulkDisposalsRoutes);
    await app.register(mastersRoutes);
    await app.register(bulkMastersRoutes);
    await app.register(activityLogRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const db = await getPool();
    await db.query(`DELETE FROM asset_activity_log`);
    await db.query(`DELETE FROM asset_delete_audit_log`);
    await db.query(`DELETE FROM master_activity_log`);
    await db.query(`DELETE FROM transfers`);
    await db.query(`DELETE FROM assets`);
    await seedMasters();
    await db.query(
      `INSERT INTO settings (id, as_at, fy_start, fy_end, days_in_fy) VALUES (TRUE, '2026-08-17', '2026-04-01', '2027-03-31', 365)
       ON CONFLICT (id) DO UPDATE SET as_at = '2026-08-17', fy_start = '2026-04-01', fy_end = '2027-03-31', days_in_fy = 365`
    );
  });

  it("returns an empty list before any activity", async () => {
    const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [], nextCursor: null });
  });

  it("logs a single-item Capitalization with actor and entered details", async () => {
    await authedInject(app, { method: "POST", url: "/api/assets", payload: NEW_ASSET });

    const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity" });
    const { items } = res.json();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ action: "capitalization_create", category: "capitalization", farId: "ACT-TEST-1" });
    expect(items[0].actorUsername).toBeTruthy();
    expect(items[0].details.assetDescription).toBe("Activity Log Test Asset");
    expect(items[0].details.source).toBe("single");
  });

  it("logs a single-item Addition", async () => {
    await authedInject(app, { method: "POST", url: "/api/assets", payload: NEW_ASSET });
    await authedInject(app, {
      method: "PATCH",
      url: "/api/assets/ACT-TEST-1/addition",
      payload: { additionsC1: 1000, additionsC2: 0, dateOfAddition: "2026-06-01" }
    });

    const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?category=addition" });
    const { items } = res.json();
    expect(items).toHaveLength(1);
    expect(items[0].details).toMatchObject({ additionsC1: 1000, additionsC2: 0, dateOfAddition: "2026-06-01" });
    // previous state, captured from the same pre-write SELECT the route already ran for
    // its own validation — an asset can't reach this route with a prior addition, so
    // these are always 0/0/null, but diffPrevious still skips additionsC2 here since 0
    // (old) === 0 (new), the same skip-if-unchanged convention masters.ts's own diff uses.
    expect(items[0].details.previous).toEqual({ additionsC1: 0, dateOfAddition: null });
  });

  it("logs a single-item Disposal, with the pre-disposal status/sale value/date as previous", async () => {
    await authedInject(app, { method: "POST", url: "/api/assets", payload: NEW_ASSET });
    await authedInject(app, {
      method: "PATCH",
      url: "/api/assets/ACT-TEST-1/disposal",
      payload: { dateOfDisposal: "2026-07-01", saleValue: 500 }
    });

    const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?category=disposal" });
    const { items } = res.json();
    expect(items).toHaveLength(1);
    expect(items[0].details).toMatchObject({ status: "Disposed", dateOfDisposal: "2026-07-01", saleValue: 500 });
    expect(items[0].details.previous).toEqual({ status: "Active", saleValue: 0, dateOfDisposal: null });
  });

  it("logs a single-item Transfer, one row per FAR ID moved, with each asset's prior location as previous", async () => {
    await authedInject(app, { method: "POST", url: "/api/assets", payload: NEW_ASSET });
    await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, farId: "ACT-TEST-2" } });
    await authedInject(app, {
      method: "POST",
      url: "/api/transfers",
      payload: { farIds: ["ACT-TEST-1", "ACT-TEST-2"], toLocation: "Center-Other", transactionDate: "2026-06-01" }
    });

    const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?category=transfer" });
    const { items } = res.json();
    expect(items).toHaveLength(2);
    expect(items.map((i: { farId: string }) => i.farId).sort()).toEqual(["ACT-TEST-1", "ACT-TEST-2"]);
    expect(items[0].details).toMatchObject({ location: "Center-Other", transactionDate: "2026-06-01" });
    expect(items[0].details.previous).toEqual({ location: "Center-Test" });
  });

  it("logs a Bulk Upload Capitalization (new rows only, not updates)", async () => {
    const csv = [BULK_HEADER, "ACT-BULK-1,Test-Sub,Bulk Asset,Active,2020-01-01,Center-Test,5,5,1000,1000"].join("\n");
    await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(csv) });
    // Re-uploading the same row is an update, not a create — must not log a second time.
    await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(csv) });

    const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?category=capitalization" });
    const { items } = res.json();
    expect(items).toHaveLength(1);
    expect(items[0].farId).toBe("ACT-BULK-1");
    expect(items[0].details).toMatchObject({ source: "bulk", sourceFilename: "upload.csv" });
  });

  it("logs a Bulk Transfer", async () => {
    await authedInject(app, { method: "POST", url: "/api/assets", payload: NEW_ASSET });
    const csv = "farId,toLocation,transactionDate\nACT-TEST-1,Center-Other,01-06-2026";
    await authedInject(app, { method: "POST", url: "/api/transfers/bulk-upload", ...csvPayload(csv) });

    const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?category=transfer" });
    const { items } = res.json();
    expect(items).toHaveLength(1);
    expect(items[0].details).toMatchObject({ source: "bulk", sourceFilename: "upload.csv" });
  });

  it("logs a Bulk Disposal", async () => {
    await authedInject(app, { method: "POST", url: "/api/assets", payload: NEW_ASSET });
    const csv = "farId,dateOfDisposal,saleValue\nACT-TEST-1,01-07-2026,500";
    await authedInject(app, { method: "POST", url: "/api/assets/bulk-dispose", ...csvPayload(csv) });

    const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?category=disposal" });
    const { items } = res.json();
    expect(items).toHaveLength(1);
    expect(items[0].details).toMatchObject({ source: "bulk", sourceFilename: "upload.csv" });
  });

  describe("Delete category — merged in from the former standalone Delete Log", () => {
    it("groups all four delete/undo actions under one 'delete' category, with reason preserved", async () => {
      await authedInject(app, { method: "POST", url: "/api/assets", payload: NEW_ASSET });
      await authedInject(app, {
        method: "DELETE",
        url: "/api/assets/ACT-TEST-1",
        payload: { reason: "created by mistake" }
      });

      const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?category=delete" });
      const { items } = res.json();
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ action: "capitalization_delete", category: "delete", farId: "ACT-TEST-1" });
      expect(items[0].details.reason).toBe("created by mistake");
      expect(items[0].details.type).toBe("Capitalization Delete");
    });

    it("excludes delete-category rows when filtering by a create category, and vice versa", async () => {
      await authedInject(app, { method: "POST", url: "/api/assets", payload: NEW_ASSET });
      await authedInject(app, { method: "DELETE", url: "/api/assets/ACT-TEST-1", payload: { reason: "test" } });

      const capOnly = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?category=capitalization" });
      expect(capOnly.json().items.map((i: { category: string }) => i.category)).toEqual(["capitalization"]);

      const deleteOnly = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?category=delete" });
      expect(deleteOnly.json().items.map((i: { category: string }) => i.category)).toEqual(["delete"]);

      const all = await authedInject(app, { method: "GET", url: "/api/audit-log/activity" });
      expect(all.json().items).toHaveLength(2);
    });

    it("a transfer delete still carries its farId and reason", async () => {
      await authedInject(app, { method: "POST", url: "/api/assets", payload: NEW_ASSET });
      await authedInject(app, {
        method: "POST",
        url: "/api/transfers",
        payload: { farIds: ["ACT-TEST-1"], toLocation: "Center-Other", transactionDate: "2026-06-01" }
      });
      const db = await getPool();
      const { rows } = await db.query<{ id: string }>(`SELECT id FROM transfers WHERE far_id = 'ACT-TEST-1'`);
      await authedInject(app, {
        method: "DELETE",
        url: `/api/transfers/${rows[0]!.id}`,
        payload: { reason: "recorded in error" }
      });

      const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?category=delete" });
      const { items } = res.json();
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ action: "transfer_delete", farId: "ACT-TEST-1" });
      expect(items[0].details.reason).toBe("recorded in error");
    });
  });

  describe("Masters category", () => {
    it("logs a single-item Center create and update, with a null FAR ID", async () => {
      const create = await authedInject(app, {
        method: "POST",
        url: "/api/masters/centers",
        payload: { code: "Center-New", description: "A new center" }
      });
      const { id } = create.json();
      await authedInject(app, {
        method: "PATCH",
        url: `/api/masters/centers/${id}`,
        payload: { description: "Renamed description" }
      });

      const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?category=masters" });
      const { items } = res.json();
      expect(items).toHaveLength(2);
      expect(items.every((i: { farId: string | null }) => i.farId === null)).toBe(true);
      expect(items[0]).toMatchObject({ action: "center_update", category: "masters" });
      expect(items[0].details.type).toBe("Center Updated");
      expect(items[1]).toMatchObject({ action: "center_create", category: "masters" });
      expect(items[1].details.type).toBe("Center Created");
    });

    it("logs a Sub Classification and a Status change too", async () => {
      await authedInject(app, {
        method: "POST",
        url: "/api/masters/sub-classifications",
        payload: { name: "New-Sub" }
      });
      await authedInject(app, { method: "POST", url: "/api/masters/statuses", payload: { name: "New-Status" } });

      const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?category=masters" });
      const actions = res.json().items.map((i: { action: string }) => i.action).sort();
      expect(actions).toEqual(["status_create", "sub_classification_create"]);
    });

    it("logs a Bulk Masters Upload create", async () => {
      const csv = "code,description\nCenter-Bulk,Bulk-created center";
      await authedInject(app, { method: "POST", url: "/api/masters/centers/bulk-upload", ...csvPayload(csv) });

      const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?category=masters" });
      const { items } = res.json();
      expect(items).toHaveLength(1);
      expect(items[0].action).toBe("center_create");
      expect(items[0].details).toMatchObject({ code: "Center-Bulk", source: "bulk", sourceFilename: "upload.csv" });
    });

    it("does not log a Bulk Masters row that matched with nothing to change", async () => {
      const csv = "code,description\nCenter-Test,";
      await authedInject(app, { method: "POST", url: "/api/masters/centers/bulk-upload", ...csvPayload(csv) });

      const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?category=masters" });
      expect(res.json().items).toHaveLength(0);
    });

    it("a FAR ID filter never matches a Masters entry", async () => {
      await authedInject(app, { method: "POST", url: "/api/masters/centers", payload: { code: "Center-New" } });
      const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?farId=Center-New" });
      expect(res.json().items).toHaveLength(0);
    });
  });

  it("filters by FAR ID (contains, case-insensitive)", async () => {
    await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, farId: "ACT-MATCH-1" } });
    await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, farId: "OTHER-2" } });

    const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?farId=match" });
    const { items } = res.json();
    expect(items).toHaveLength(1);
    expect(items[0].farId).toBe("ACT-MATCH-1");
  });

  it("filters by actor (contains, case-insensitive)", async () => {
    await authedInject(app, { method: "POST", url: "/api/assets", payload: NEW_ASSET });

    const match = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?actor=HARNESS" });
    expect(match.json().items).toHaveLength(1);

    const noMatch = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?actor=nobody-with-this-name" });
    expect(noMatch.json().items).toHaveLength(0);
  });

  describe("GET /api/audit-log/activity/summary", () => {
    it("counts each category correctly, unaffected by which category (if any) is separately selected on screen", async () => {
      await authedInject(app, { method: "POST", url: "/api/assets", payload: NEW_ASSET });
      await authedInject(app, { method: "POST", url: "/api/masters/centers", payload: { code: "Center-Summary" } });
      await authedInject(app, { method: "DELETE", url: "/api/assets/ACT-TEST-1", payload: { reason: "test" } });

      const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity/summary" });
      expect(res.json()).toEqual({
        counts: { capitalization: 1, addition: 0, transfer: 0, disposal: 0, delete: 1, masters: 1 },
        total: 3
      });
    });

    it("respects farId/actor/date filters but not category, so the strip stays meaningful while one category is selected", async () => {
      await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, farId: "ACT-SUM-1" } });
      await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, farId: "OTHER-SUM" } });

      const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity/summary?farId=ACT-SUM" });
      expect(res.json().counts).toMatchObject({ capitalization: 1 });
      expect(res.json().total).toBe(1);
    });
  });

  it("filters by date range", async () => {
    await authedInject(app, { method: "POST", url: "/api/assets", payload: NEW_ASSET });

    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
    const past = "2000-01-01";
    const future = "2999-01-01";

    const withinRange = await authedInject(app, {
      method: "GET",
      url: `/api/audit-log/activity?dateFrom=${past}&dateTo=${future}`
    });
    expect(withinRange.json().items).toHaveLength(1);

    const outsideRange = await authedInject(app, {
      method: "GET",
      url: `/api/audit-log/activity?dateFrom=${future}`
    });
    expect(outsideRange.json().items).toHaveLength(0);

    const fromToday = await authedInject(app, {
      method: "GET",
      url: `/api/audit-log/activity?dateFrom=${today}&dateTo=${today}`
    });
    expect(fromToday.json().items).toHaveLength(1);
  });

  it("returns newest first and paginates with a keyset cursor", async () => {
    for (const farId of ["ACT-PAGE-1", "ACT-PAGE-2", "ACT-PAGE-3"]) {
      await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, farId } });
    }

    const page1 = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?limit=1" });
    const body1 = page1.json();
    expect(body1.items).toHaveLength(1);
    expect(body1.items[0].farId).toBe("ACT-PAGE-3");
    expect(body1.nextCursor).toBeTruthy();

    const page2 = await authedInject(app, {
      method: "GET",
      url: `/api/audit-log/activity?limit=1&cursor=${body1.nextCursor}`
    });
    expect(page2.json().items[0].farId).toBe("ACT-PAGE-2");
  });

  it("paginates correctly across mixed sources (activity + delete + masters) in one newest-first feed", async () => {
    await authedInject(app, { method: "POST", url: "/api/assets", payload: NEW_ASSET }); // activity
    await authedInject(app, { method: "POST", url: "/api/masters/centers", payload: { code: "Center-New" } }); // masters
    await authedInject(app, { method: "DELETE", url: "/api/assets/ACT-TEST-1", payload: { reason: "test" } }); // delete

    const page1 = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?limit=2" });
    const body1 = page1.json();
    expect(body1.items).toHaveLength(2);
    expect(body1.items.map((i: { category: string }) => i.category)).toEqual(["delete", "masters"]);
    expect(body1.nextCursor).toBeTruthy();

    const page2 = await authedInject(app, {
      method: "GET",
      url: `/api/audit-log/activity?limit=2&cursor=${body1.nextCursor}`
    });
    const body2 = page2.json();
    expect(body2.items).toHaveLength(1);
    expect(body2.items[0].category).toBe("capitalization");
    expect(body2.nextCursor).toBeNull();
  });

  it("rejects an invalid category query with 400", async () => {
    const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?category=not-a-real-category" });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a malformed cursor with 400", async () => {
    const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity?cursor=not-a-real-cursor" });
    expect(res.statusCode).toBe(400);
  });

  // GET /api/audit-log/activity/export — permission gating (activityLog:export) is
  // covered by permissionEnforcement.test.ts's shared registry; these tests cover that
  // the export actually contains the right rows and columns, sharing the same
  // buildActivityLogConditions/shapeRow the list endpoint uses.
  describe("Export to Excel (GET /api/audit-log/activity/export)", () => {
    async function readSheet(payload: Buffer) {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(payload as any);
      return workbook.worksheets[0]!;
    }

    // Row 1: brand title band. Row 2: generated-by. Row 3: filter summary. Row 4: blank
    // spacer. Row 5: the real column header row. Row 6+: data — one row per changed
    // field (or one blank-diff row for an action with nothing to diff), see
    // buildChangedFields's own comment.
    const HEADER_ROW = 5;
    const FIRST_DATA_ROW = HEADER_ROW + 1;

    it("streams a branded header band, the expected column headers, and every matching row with no filters applied", async () => {
      await authedInject(app, { method: "POST", url: "/api/assets", payload: NEW_ASSET });

      const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity/export" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      expect(res.headers["content-disposition"]).toMatch(/attachment; filename="activity-log-\d{4}-\d{2}-\d{2}\.xlsx"/);

      const sheet = await readSheet(res.rawPayload);
      expect((sheet.getRow(1).values as unknown[])[1]).toBe("NephroPlus - Activity Log Export");
      expect((sheet.getRow(2).values as unknown[])[1]).toMatch(/^Generated by .+ on \d{2}-\d{2}-\d{4} \d{2}:\d{2} IST$/);
      expect((sheet.getRow(3).values as unknown[])[1]).toBe("Filters: None - showing all activity");

      const headerRow = sheet.getRow(HEADER_ROW).values as unknown[];
      expect(headerRow.slice(1)).toEqual([
        "Timestamp (IST)",
        "Category",
        "Type / Action",
        "FAR ID",
        "Actor",
        "Financial Year",
        "Reason",
        "Field Changed",
        "Old Value",
        "New Value",
        "Other Details"
      ]);
      const dataRow = sheet.getRow(FIRST_DATA_ROW).values as unknown[];
      expect(dataRow[2]).toBe("Capitalization");
      expect(dataRow[3]).toBe("Capitalization Create");
      expect(dataRow[4]).toBe("ACT-TEST-1");
      // settings.fy_start is 2026-04-01 in this suite — derived from wall-clock time
      // rather than hardcoded, so this doesn't quietly start failing once fy_end passes.
      const nowParts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit" })
        .formatToParts(new Date())
        .reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {} as Record<string, string>);
      const expectedStartYear = Number(nowParts.month) >= 4 ? Number(nowParts.year) : Number(nowParts.year) - 1;
      expect(dataRow[6]).toBe(`FY ${expectedStartYear}-${String((expectedStartYear + 1) % 100).padStart(2, "0")}`);
      expect(sheet.rowCount).toBe(FIRST_DATA_ROW); // header band + one data row
    });

    it("the filter summary line reflects the category filter actually applied", async () => {
      const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity/export?category=masters" });
      const sheet = await readSheet(res.rawPayload);
      expect((sheet.getRow(3).values as unknown[])[1]).toBe("Filters: Category: Masters");
    });

    it("Old Value / New Value carry a Masters update's diff, and Other Details carries the rest", async () => {
      const create = await authedInject(app, {
        method: "POST",
        url: "/api/masters/centers",
        payload: { code: "Center-ExportDiff", description: "Old description" }
      });
      const { id } = create.json();
      await authedInject(app, {
        method: "PATCH",
        url: `/api/masters/centers/${id}`,
        payload: { description: "New description" }
      });

      const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity/export?category=masters" });
      const sheet = await readSheet(res.rawPayload);
      // Newest-first isn't guaranteed by the export (it streams oldest-first for keyset
      // pagination) — the update is the second Masters row written, so the second data row.
      const updateRow = sheet.getRow(FIRST_DATA_ROW + 1).values as unknown[];
      expect(updateRow[3]).toBe("Center Updated");
      expect(updateRow[8]).toBe("Description");
      expect(updateRow[9]).toBe("Old description");
      expect(updateRow[10]).toBe("New description");
      expect(updateRow[11]).toMatch(/Source: single/);
      expect(updateRow[11]).not.toMatch(/Description/); // already in Old/New Value, not repeated here
    });

    it("a Disposal's status/sale value/date all show up as their own Old -> New rows", async () => {
      await authedInject(app, { method: "POST", url: "/api/assets", payload: NEW_ASSET });
      await authedInject(app, {
        method: "PATCH",
        url: "/api/assets/ACT-TEST-1/disposal",
        payload: { dateOfDisposal: "2026-07-01", saleValue: 500 }
      });

      const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity/export?category=disposal" });
      const sheet = await readSheet(res.rawPayload);
      const fieldsChanged = [];
      for (let i = 0; i < 3; i++) {
        fieldsChanged.push((sheet.getRow(FIRST_DATA_ROW + i).values as unknown[])[8]);
      }
      expect(fieldsChanged.sort()).toEqual(["Date Of Disposal", "Sale Value", "Status"]);
      expect(sheet.rowCount).toBe(FIRST_DATA_ROW + 2); // one row per changed field, no blank-diff row
    });

    it("the Reason column is populated for a Delete entry and empty for a create", async () => {
      await authedInject(app, { method: "POST", url: "/api/assets", payload: NEW_ASSET });
      await authedInject(app, {
        method: "DELETE",
        url: "/api/assets/ACT-TEST-1",
        payload: { reason: "created by mistake" }
      });

      const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity/export" });
      const sheet = await readSheet(res.rawPayload);
      const createRow = sheet.getRow(FIRST_DATA_ROW).values as unknown[];
      const deleteRow = sheet.getRow(FIRST_DATA_ROW + 1).values as unknown[];
      // ExcelJS round-trips a written "" as undefined on read-back (no <v> element for an
      // empty inline string) — both mean "blank cell" to a reader opening the file.
      expect(createRow[7]).toBeFalsy();
      expect(deleteRow[3]).toBe("Capitalization Delete");
      expect(deleteRow[7]).toBe("created by mistake");
    });

    it("respects the same category/farId filters as the list endpoint", async () => {
      await authedInject(app, { method: "POST", url: "/api/assets", payload: NEW_ASSET });
      await authedInject(app, { method: "POST", url: "/api/masters/centers", payload: { code: "Center-ExportFilter" } });

      const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity/export?category=capitalization" });
      const sheet = await readSheet(res.rawPayload);
      expect(sheet.rowCount).toBe(FIRST_DATA_ROW);
      expect((sheet.getRow(FIRST_DATA_ROW).values as unknown[])[2]).toBe("Capitalization");
    });

    it("an empty result still returns a valid workbook with just the header band", async () => {
      const res = await authedInject(app, { method: "GET", url: "/api/audit-log/activity/export" });
      expect(res.statusCode).toBe(200);
      const sheet = await readSheet(res.rawPayload);
      expect(sheet.rowCount).toBe(HEADER_ROW);
    });
  });
});
