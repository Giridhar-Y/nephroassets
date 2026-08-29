import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import assetsRoutes from "./assets.js";
import transfersRoutes from "./transfers.js";
import bulkUploadRoutes from "./bulkUpload.js";
import reportsRoutes from "./reports.js";
import { getPool } from "../db/pool.js";
import { authedInject } from "../testHelpers/authTestUtils.js";
import { authGateHook } from "../auth/middleware.js";
import { csvPayload } from "./bulkTestHelpers.js";

const NEW_ASSET = {
  farId: "DEL-TEST-1",
  subClassification: "Test-Sub",
  assetDescription: "Delete Test Asset",
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

// The Global-Admin-only delete/undo feature: soft-delete (not hard delete), dependency
// blocking, recalculation (the calc engine reads live columns on every request — see
// module comments in assets.ts/transfers.ts for why "recalculation" here means "correctly
// clear/revert the source columns," not a batch job), and an audit log entry per action.
// Role enforcement itself (admin-only, editor/viewer rejected) lives in roles.test.ts —
// this file assumes admin auth throughout (authedInject's shared user is admin) and
// covers business-logic correctness only.
describe("Global-Admin-only delete/undo", () => {
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
    await app.register(reportsRoutes);
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

  describe("Capitalization delete: DELETE /api/assets/:farId", () => {
    beforeEach(async () => {
      await authedInject(app, { method: "POST", url: "/api/assets", payload: NEW_ASSET });
    });

    it("soft-deletes a clean asset — it disappears from the Register but the row itself survives", async () => {
      const del = await authedInject(app, {
        method: "DELETE",
        url: "/api/assets/DEL-TEST-1",
        payload: { reason: "created by mistake" }
      });
      expect(del.statusCode).toBe(200);
      expect(del.json()).toEqual({ farId: "DEL-TEST-1", deleted: true });

      const list = await authedInject(app, { method: "GET", url: "/api/assets?asAt=2026-08-17" });
      expect(list.json().items.some((i: { asset: { farId: string } }) => i.asset.farId === "DEL-TEST-1")).toBe(false);

      const detail = await authedInject(app, { method: "GET", url: "/api/assets/DEL-TEST-1" });
      expect(detail.statusCode).toBe(404);

      const db = await getPool();
      const { rows } = await db.query(`SELECT deleted_at, deleted_by, delete_reason FROM assets WHERE far_id = 'DEL-TEST-1'`);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.deleted_at).not.toBeNull();
      expect(rows[0]!.delete_reason).toBe("created by mistake");
      expect(rows[0]!.deleted_by).not.toBeNull();
    });

    it("disappears from Reports too (Depreciation Posting spot check)", async () => {
      const before = await authedInject(app, { method: "GET", url: "/api/reports/depreciation-posting?asAt=2026-08-17" });
      const beforeTotal = before.json().totalPeriodDepreciation;
      expect(beforeTotal).toBeGreaterThan(0);

      await authedInject(app, {
        method: "DELETE",
        url: "/api/assets/DEL-TEST-1",
        payload: { reason: "test" }
      });

      const after = await authedInject(app, { method: "GET", url: "/api/reports/depreciation-posting?asAt=2026-08-17" });
      expect(after.json().totalPeriodDepreciation).toBe(0);
    });

    it("rejects an empty reason with 400", async () => {
      const res = await authedInject(app, { method: "DELETE", url: "/api/assets/DEL-TEST-1", payload: { reason: "  " } });
      expect(res.statusCode).toBe(400);
    });

    it("404s for a FAR ID that doesn't exist", async () => {
      const res = await authedInject(app, {
        method: "DELETE",
        url: "/api/assets/NOPE-NOT-REAL",
        payload: { reason: "test" }
      });
      expect(res.statusCode).toBe(404);
    });

    it("404s deleting an already-deleted asset — not a silent no-op", async () => {
      await authedInject(app, { method: "DELETE", url: "/api/assets/DEL-TEST-1", payload: { reason: "first" } });
      const second = await authedInject(app, {
        method: "DELETE",
        url: "/api/assets/DEL-TEST-1",
        payload: { reason: "second" }
      });
      expect(second.statusCode).toBe(404);
    });

    it("is blocked when the asset has a transfer on record", async () => {
      await authedInject(app, {
        method: "POST",
        url: "/api/transfers",
        payload: { farIds: ["DEL-TEST-1"], toLocation: "Center-Other", transactionDate: "2026-06-01" }
      });
      const res = await authedInject(app, {
        method: "DELETE",
        url: "/api/assets/DEL-TEST-1",
        payload: { reason: "test" }
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/transfer/i);
    });

    it("is blocked when the asset has an addition recorded", async () => {
      await authedInject(app, {
        method: "PATCH",
        url: "/api/assets/DEL-TEST-1/addition",
        payload: { additionsC1: 2000, additionsC2: 0, dateOfAddition: "2026-06-01" }
      });
      const res = await authedInject(app, {
        method: "DELETE",
        url: "/api/assets/DEL-TEST-1",
        payload: { reason: "test" }
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/addition/i);
    });

    it("is blocked when the asset has been disposed", async () => {
      await authedInject(app, {
        method: "PATCH",
        url: "/api/assets/DEL-TEST-1/disposal",
        payload: { dateOfDisposal: "2026-06-01", saleValue: 100 }
      });
      const res = await authedInject(app, {
        method: "DELETE",
        url: "/api/assets/DEL-TEST-1",
        payload: { reason: "test" }
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/disposed/i);
    });

    it("is blocked when the asset is the parent of another asset, and names the child", async () => {
      await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, farId: "DEL-TEST-CHILD" } });
      await authedInject(app, {
        method: "POST",
        url: "/api/assets/merge",
        payload: { parentFarId: "DEL-TEST-1", childFarIds: ["DEL-TEST-CHILD"] }
      });
      const res = await authedInject(app, {
        method: "DELETE",
        url: "/api/assets/DEL-TEST-1",
        payload: { reason: "test" }
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toContain("DEL-TEST-CHILD");
    });

    it("writes an audit log entry with actor, reason, and a details snapshot", async () => {
      await authedInject(app, { method: "DELETE", url: "/api/assets/DEL-TEST-1", payload: { reason: "created by mistake" } });

      const db = await getPool();
      const { rows } = await db.query(`SELECT * FROM asset_delete_audit_log WHERE far_id = 'DEL-TEST-1'`);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.action).toBe("capitalization_delete");
      expect(rows[0]!.reason).toBe("created by mistake");
      expect(rows[0]!.actor_user_id).not.toBeNull();
      expect(rows[0]!.details.assetDescription).toBe("Delete Test Asset");
    });

    it("a deleted FAR ID can't be reused via Capitalization — clear message, not a plain duplicate", async () => {
      await authedInject(app, { method: "DELETE", url: "/api/assets/DEL-TEST-1", payload: { reason: "test" } });
      const res = await authedInject(app, { method: "POST", url: "/api/assets", payload: NEW_ASSET });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/deleted/i);
    });

    it("a deleted FAR ID can't be silently revived via Bulk Upload — rejected as an Error row, not upserted", async () => {
      await authedInject(app, { method: "DELETE", url: "/api/assets/DEL-TEST-1", payload: { reason: "test" } });

      const csv = [
        "farId,subClassification,assetDescription,status,dateAcquired,location,usefulLifeC1Years,usefulLifeC2Years,c1OpeningCost,c2OpeningCost",
        "DEL-TEST-1,Test-Sub,Revived?,Active,2020-01-01,Center-Test,5,5,1000,1000"
      ].join("\n");
      const res = await authedInject(app, { method: "POST", url: "/api/assets/bulk-upload", ...csvPayload(csv) });
      expect(res.statusCode).toBe(200);
      const result = res.json();
      expect(result.processed).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toMatch(/deleted/i);

      const db = await getPool();
      const { rows } = await db.query(`SELECT deleted_at FROM assets WHERE far_id = 'DEL-TEST-1'`);
      expect(rows[0]!.deleted_at).not.toBeNull(); // still deleted — never resurrected
    });
  });

  describe("Addition undo: POST /api/assets/:farId/addition/undo", () => {
    beforeEach(async () => {
      await authedInject(app, { method: "POST", url: "/api/assets", payload: NEW_ASSET });
      await authedInject(app, {
        method: "PATCH",
        url: "/api/assets/DEL-TEST-1/addition",
        payload: { additionsC1: 3000, additionsC2: 500, dateOfAddition: "2026-06-01" }
      });
    });

    it("clears the addition fields back to zero/blank", async () => {
      const res = await authedInject(app, {
        method: "POST",
        url: "/api/assets/DEL-TEST-1/addition/undo",
        payload: { reason: "recorded on the wrong asset" }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ farId: "DEL-TEST-1", additionUndone: true });

      const db = await getPool();
      const { rows } = await db.query(
        `SELECT additions_c1, additions_c2, date_of_addition FROM assets WHERE far_id = 'DEL-TEST-1'`
      );
      expect(Number(rows[0]!.additions_c1)).toBe(0);
      expect(Number(rows[0]!.additions_c2)).toBe(0);
      expect(rows[0]!.date_of_addition).toBeNull();
    });

    it("is now allowed to have a NEW addition recorded after the undo (the one-per-asset limit reset)", async () => {
      await authedInject(app, {
        method: "POST",
        url: "/api/assets/DEL-TEST-1/addition/undo",
        payload: { reason: "test" }
      });
      const res = await authedInject(app, {
        method: "PATCH",
        url: "/api/assets/DEL-TEST-1/addition",
        payload: { additionsC1: 1000, additionsC2: 0, dateOfAddition: "2026-07-01" }
      });
      expect(res.statusCode).toBe(200);
    });

    it("is blocked (409) when there's no addition to undo", async () => {
      await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, farId: "DEL-TEST-NOADD" } });
      const res = await authedInject(app, {
        method: "POST",
        url: "/api/assets/DEL-TEST-NOADD/addition/undo",
        payload: { reason: "test" }
      });
      expect(res.statusCode).toBe(409);
    });

    it("is blocked (409) once the asset has since been disposed — the disposal's Deletions figure already depends on the addition", async () => {
      await authedInject(app, {
        method: "PATCH",
        url: "/api/assets/DEL-TEST-1/disposal",
        payload: { dateOfDisposal: "2026-07-01", saleValue: 500 }
      });
      const res = await authedInject(app, {
        method: "POST",
        url: "/api/assets/DEL-TEST-1/addition/undo",
        payload: { reason: "test" }
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/disposed/i);
    });

    it("writes an audit log entry snapshotting the old addition values", async () => {
      await authedInject(app, {
        method: "POST",
        url: "/api/assets/DEL-TEST-1/addition/undo",
        payload: { reason: "wrong asset" }
      });
      const db = await getPool();
      const { rows } = await db.query(
        `SELECT * FROM asset_delete_audit_log WHERE far_id = 'DEL-TEST-1' AND action = 'addition_undo'`
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.reason).toBe("wrong asset");
      expect(Number(rows[0]!.details.additionsC1)).toBe(3000);
      expect(Number(rows[0]!.details.additionsC2)).toBe(500);
      expect(rows[0]!.details.dateOfAddition).toBe("2026-06-01");
    });
  });

  describe("Disposal undo: POST /api/assets/:farId/disposal/undo", () => {
    beforeEach(async () => {
      await authedInject(app, { method: "POST", url: "/api/assets", payload: NEW_ASSET });
      await authedInject(app, {
        method: "PATCH",
        url: "/api/assets/DEL-TEST-1/disposal",
        payload: { dateOfDisposal: "2026-06-01", saleValue: 750 }
      });
    });

    it("reverses the disposal — status restored to Active, disposal fields cleared, asset reappears in the Register", async () => {
      const res = await authedInject(app, {
        method: "POST",
        url: "/api/assets/DEL-TEST-1/disposal/undo",
        payload: { reason: "disposed by mistake" }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ farId: "DEL-TEST-1", disposalUndone: true, childrenUndone: [] });

      const db = await getPool();
      const { rows } = await db.query(
        `SELECT status, date_of_disposal, deletions_c1, deletions_c2, sale_value FROM assets WHERE far_id = 'DEL-TEST-1'`
      );
      expect(rows[0]!.status).toBe("Active");
      expect(rows[0]!.date_of_disposal).toBeNull();
      expect(Number(rows[0]!.deletions_c1)).toBe(0);
      expect(Number(rows[0]!.deletions_c2)).toBe(0);
      expect(Number(rows[0]!.sale_value)).toBe(0);

      const list = await authedInject(app, { method: "GET", url: "/api/assets?asAt=2026-08-17&status=Active" });
      expect(list.json().items.some((i: { asset: { farId: string } }) => i.asset.farId === "DEL-TEST-1")).toBe(true);
    });

    it("can be disposed again after the undo", async () => {
      await authedInject(app, {
        method: "POST",
        url: "/api/assets/DEL-TEST-1/disposal/undo",
        payload: { reason: "test" }
      });
      const res = await authedInject(app, {
        method: "PATCH",
        url: "/api/assets/DEL-TEST-1/disposal",
        payload: { dateOfDisposal: "2026-07-15", saleValue: 900 }
      });
      expect(res.statusCode).toBe(200);
    });

    it("is blocked (409) when the asset has not been disposed", async () => {
      await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, farId: "DEL-TEST-ACTIVE" } });
      const res = await authedInject(app, {
        method: "POST",
        url: "/api/assets/DEL-TEST-ACTIVE/disposal/undo",
        payload: { reason: "test" }
      });
      expect(res.statusCode).toBe(409);
    });

    it("cascades: undoing a parent's disposal also un-disposes the child it cascaded to", async () => {
      const db = await getPool();
      // A fresh parent+child pair, disposed together (disposeWithChildren's cascade).
      await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, farId: "DEL-CASCADE-P" } });
      await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, farId: "DEL-CASCADE-C" } });
      await authedInject(app, {
        method: "POST",
        url: "/api/assets/merge",
        payload: { parentFarId: "DEL-CASCADE-P", childFarIds: ["DEL-CASCADE-C"] }
      });
      await authedInject(app, {
        method: "PATCH",
        url: "/api/assets/DEL-CASCADE-P/disposal",
        payload: { dateOfDisposal: "2026-06-01", saleValue: 0 }
      });
      const { rows: beforeChild } = await db.query(
        `SELECT date_of_disposal, disposed_via_parent_far_id FROM assets WHERE far_id = 'DEL-CASCADE-C'`
      );
      expect(beforeChild[0]!.date_of_disposal).not.toBeNull();
      expect(beforeChild[0]!.disposed_via_parent_far_id).toBe("DEL-CASCADE-P");

      const res = await authedInject(app, {
        method: "POST",
        url: "/api/assets/DEL-CASCADE-P/disposal/undo",
        payload: { reason: "disposed by mistake" }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().childrenUndone).toEqual(["DEL-CASCADE-C"]);

      const { rows: afterChild } = await db.query(
        `SELECT status, date_of_disposal, disposed_via_parent_far_id FROM assets WHERE far_id = 'DEL-CASCADE-C'`
      );
      expect(afterChild[0]!.status).toBe("Active");
      expect(afterChild[0]!.date_of_disposal).toBeNull();
      expect(afterChild[0]!.disposed_via_parent_far_id).toBeNull();
    });

    it("a child disposed independently (not via this cascade) is untouched by the parent's disposal undo", async () => {
      const db = await getPool();
      await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, farId: "DEL-INDEP-P" } });
      await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, farId: "DEL-INDEP-C" } });
      // Child disposed on its OWN, before any merge — independent of any parent cascade.
      await authedInject(app, {
        method: "PATCH",
        url: "/api/assets/DEL-INDEP-C/disposal",
        payload: { dateOfDisposal: "2026-05-01", saleValue: 200 }
      });
      await authedInject(app, {
        method: "POST",
        url: "/api/assets/merge",
        payload: { parentFarId: "DEL-INDEP-P", childFarIds: ["DEL-INDEP-C"] }
      });
      await authedInject(app, {
        method: "PATCH",
        url: "/api/assets/DEL-INDEP-P/disposal",
        payload: { dateOfDisposal: "2026-06-01", saleValue: 0 }
      });

      await authedInject(app, {
        method: "POST",
        url: "/api/assets/DEL-INDEP-P/disposal/undo",
        payload: { reason: "test" }
      });

      const { rows } = await db.query(`SELECT status, date_of_disposal FROM assets WHERE far_id = 'DEL-INDEP-C'`);
      expect(rows[0]!.status).toBe("Disposed");
      expect(rows[0]!.date_of_disposal).not.toBeNull();
    });

    it("is blocked (409) undoing a cascaded child's disposal directly — must undo the parent's instead", async () => {
      await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, farId: "DEL-DIRECT-P" } });
      await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, farId: "DEL-DIRECT-C" } });
      await authedInject(app, {
        method: "POST",
        url: "/api/assets/merge",
        payload: { parentFarId: "DEL-DIRECT-P", childFarIds: ["DEL-DIRECT-C"] }
      });
      await authedInject(app, {
        method: "PATCH",
        url: "/api/assets/DEL-DIRECT-P/disposal",
        payload: { dateOfDisposal: "2026-06-01", saleValue: 0 }
      });

      const res = await authedInject(app, {
        method: "POST",
        url: "/api/assets/DEL-DIRECT-C/disposal/undo",
        payload: { reason: "test" }
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toContain("DEL-DIRECT-P");
    });

    it("writes an audit log entry snapshotting the old disposal values", async () => {
      await authedInject(app, {
        method: "POST",
        url: "/api/assets/DEL-TEST-1/disposal/undo",
        payload: { reason: "disposed by mistake" }
      });
      const db = await getPool();
      const { rows } = await db.query(
        `SELECT * FROM asset_delete_audit_log WHERE far_id = 'DEL-TEST-1' AND action = 'disposal_undo'`
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.reason).toBe("disposed by mistake");
      expect(rows[0]!.details.dateOfDisposal).toBe("2026-06-01");
      expect(Number(rows[0]!.details.saleValue)).toBe(750);
      expect(rows[0]!.details.statusBefore).toBe("Disposed");
    });
  });

  describe("Transfer delete: DELETE /api/transfers/:id", () => {
    async function transferIdFor(farId: string, transactionDate: string): Promise<number> {
      const db = await getPool();
      const { rows } = await db.query<{ id: string }>(
        `SELECT id FROM transfers WHERE far_id = $1 AND transaction_date = $2`,
        [farId, transactionDate]
      );
      return Number(rows[0]!.id);
    }

    beforeEach(async () => {
      await authedInject(app, { method: "POST", url: "/api/assets", payload: NEW_ASSET });
    });

    it("deletes a transfer — it disappears from the log", async () => {
      await authedInject(app, {
        method: "POST",
        url: "/api/transfers",
        payload: { farIds: ["DEL-TEST-1"], toLocation: "Center-Other", transactionDate: "2026-06-01" }
      });
      const id = await transferIdFor("DEL-TEST-1", "2026-06-01");

      const res = await authedInject(app, {
        method: "DELETE",
        url: `/api/transfers/${id}`,
        payload: { reason: "recorded in error" }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ id, deleted: true, cascadedChildren: [] });

      const log = await authedInject(app, { method: "GET", url: "/api/transfers" });
      expect(log.json().items.some((i: { id: number }) => i.id === id)).toBe(false);
    });

    it("recalculates the Current Location cache: deleting the ONLY transfer falls back to the asset's original capitalized location", async () => {
      await authedInject(app, {
        method: "POST",
        url: "/api/transfers",
        payload: { farIds: ["DEL-TEST-1"], toLocation: "Center-Other", transactionDate: "2026-06-01" }
      });
      const detail1 = await authedInject(app, { method: "GET", url: "/api/assets/DEL-TEST-1" });
      expect(detail1.json().result.effectiveLocation).toBe("Center-Other");

      const id = await transferIdFor("DEL-TEST-1", "2026-06-01");
      await authedInject(app, { method: "DELETE", url: `/api/transfers/${id}`, payload: { reason: "test" } });

      const detail2 = await authedInject(app, { method: "GET", url: "/api/assets/DEL-TEST-1" });
      expect(detail2.json().result.effectiveLocation).toBe("Center-Test"); // back to capitalized location

      const db = await getPool();
      const { rows } = await db.query(
        `SELECT revised_location, last_date_of_transaction FROM assets WHERE far_id = 'DEL-TEST-1'`
      );
      expect(rows[0]!.revised_location).toBeNull();
      expect(rows[0]!.last_date_of_transaction).toBeNull();
    });

    it("recalculates the Current Location cache: deleting the LATEST of several transfers falls back to the next-latest remaining one", async () => {
      await authedInject(app, {
        method: "POST",
        url: "/api/transfers",
        payload: { farIds: ["DEL-TEST-1"], toLocation: "Center-Other", transactionDate: "2026-05-01" }
      });
      await authedInject(app, {
        method: "POST",
        url: "/api/transfers",
        payload: { farIds: ["DEL-TEST-1"], toLocation: "Center-Test", transactionDate: "2026-06-01" }
      });
      const latestId = await transferIdFor("DEL-TEST-1", "2026-06-01");

      await authedInject(app, { method: "DELETE", url: `/api/transfers/${latestId}`, payload: { reason: "test" } });

      const db = await getPool();
      const { rows } = await db.query(
        `SELECT revised_location, last_date_of_transaction FROM assets WHERE far_id = 'DEL-TEST-1'`
      );
      expect(rows[0]!.revised_location).toBe("Center-Other");
      expect(String(rows[0]!.last_date_of_transaction)).toContain("2026-05-01");
    });

    it("deleting a NON-latest transfer leaves the Current Location cache untouched (it was already correct)", async () => {
      await authedInject(app, {
        method: "POST",
        url: "/api/transfers",
        payload: { farIds: ["DEL-TEST-1"], toLocation: "Center-Other", transactionDate: "2026-05-01" }
      });
      await authedInject(app, {
        method: "POST",
        url: "/api/transfers",
        payload: { farIds: ["DEL-TEST-1"], toLocation: "Center-Test", transactionDate: "2026-06-01" }
      });
      const olderId = await transferIdFor("DEL-TEST-1", "2026-05-01");

      await authedInject(app, { method: "DELETE", url: `/api/transfers/${olderId}`, payload: { reason: "test" } });

      const db = await getPool();
      const { rows } = await db.query(`SELECT revised_location FROM assets WHERE far_id = 'DEL-TEST-1'`);
      expect(rows[0]!.revised_location).toBe("Center-Test"); // unchanged — still the real latest
    });

    it("is blocked (409) deleting a cascaded child's transfer directly — must delete the parent's instead", async () => {
      await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, farId: "DEL-TCASCADE-C" } });
      await authedInject(app, {
        method: "POST",
        url: "/api/assets/merge",
        payload: { parentFarId: "DEL-TEST-1", childFarIds: ["DEL-TCASCADE-C"] }
      });
      await authedInject(app, {
        method: "POST",
        url: "/api/transfers",
        payload: { farIds: ["DEL-TEST-1"], toLocation: "Center-Other", transactionDate: "2026-06-01" }
      });
      const childTransferId = await transferIdFor("DEL-TCASCADE-C", "2026-06-01");

      const res = await authedInject(app, {
        method: "DELETE",
        url: `/api/transfers/${childTransferId}`,
        payload: { reason: "test" }
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toContain("DEL-TEST-1");
    });

    it("deleting the parent's transfer cascades to delete the paired child transfer too, and recalculates both caches", async () => {
      await authedInject(app, { method: "POST", url: "/api/assets", payload: { ...NEW_ASSET, farId: "DEL-TCASCADE2-C" } });
      await authedInject(app, {
        method: "POST",
        url: "/api/assets/merge",
        payload: { parentFarId: "DEL-TEST-1", childFarIds: ["DEL-TCASCADE2-C"] }
      });
      await authedInject(app, {
        method: "POST",
        url: "/api/transfers",
        payload: { farIds: ["DEL-TEST-1"], toLocation: "Center-Other", transactionDate: "2026-06-01" }
      });
      const parentTransferId = await transferIdFor("DEL-TEST-1", "2026-06-01");

      const res = await authedInject(app, {
        method: "DELETE",
        url: `/api/transfers/${parentTransferId}`,
        payload: { reason: "test" }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().cascadedChildren).toEqual(["DEL-TCASCADE2-C"]);

      const db = await getPool();
      const { rows: parentRow } = await db.query(`SELECT revised_location FROM assets WHERE far_id = 'DEL-TEST-1'`);
      const { rows: childRow } = await db.query(`SELECT revised_location FROM assets WHERE far_id = 'DEL-TCASCADE2-C'`);
      expect(parentRow[0]!.revised_location).toBeNull();
      expect(childRow[0]!.revised_location).toBeNull();

      const log = await authedInject(app, { method: "GET", url: "/api/transfers" });
      expect(log.json().items.some((i: { farId: string }) => i.farId === "DEL-TCASCADE2-C")).toBe(false);
    });

    it("404s for a transfer id that doesn't exist", async () => {
      const res = await authedInject(app, { method: "DELETE", url: "/api/transfers/999999", payload: { reason: "test" } });
      expect(res.statusCode).toBe(404);
    });

    it("404s deleting an already-deleted transfer", async () => {
      await authedInject(app, {
        method: "POST",
        url: "/api/transfers",
        payload: { farIds: ["DEL-TEST-1"], toLocation: "Center-Other", transactionDate: "2026-06-01" }
      });
      const id = await transferIdFor("DEL-TEST-1", "2026-06-01");
      await authedInject(app, { method: "DELETE", url: `/api/transfers/${id}`, payload: { reason: "first" } });
      const second = await authedInject(app, { method: "DELETE", url: `/api/transfers/${id}`, payload: { reason: "second" } });
      expect(second.statusCode).toBe(404);
    });

    it("writes an audit log entry with the transfer id and a details snapshot", async () => {
      await authedInject(app, {
        method: "POST",
        url: "/api/transfers",
        payload: { farIds: ["DEL-TEST-1"], toLocation: "Center-Other", transactionDate: "2026-06-01" }
      });
      const id = await transferIdFor("DEL-TEST-1", "2026-06-01");
      await authedInject(app, { method: "DELETE", url: `/api/transfers/${id}`, payload: { reason: "recorded in error" } });

      const db = await getPool();
      const { rows } = await db.query(`SELECT * FROM asset_delete_audit_log WHERE action = 'transfer_delete' AND far_id = 'DEL-TEST-1'`);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]!.transfer_id)).toBe(id);
      expect(rows[0]!.reason).toBe("recorded in error");
      expect(rows[0]!.details.location).toBe("Center-Other");
    });
  });
});
