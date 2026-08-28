import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import cookie from "@fastify/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import assetsRoutes from "./assets.js";
import transfersRoutes from "./transfers.js";
import bulkUploadRoutes from "./bulkUpload.js";
import bulkTransfersRoutes from "./bulkTransfers.js";
import bulkDisposalsRoutes from "./bulkDisposals.js";
import bulkMergeRoutes from "./bulkMerge.js";
import adminUsersRoutes from "./adminUsers.js";
import { emptyMultipartPayload } from "./bulkTestHelpers.js";
import { getPool } from "../db/pool.js";
import { authGateHook } from "../auth/middleware.js";
import { authHeaderFor, createTestUser } from "../testHelpers/authTestUtils.js";

// Authorization matrix for the viewer/editor/admin role system: every FAR-module write
// route (Capitalization, Disposals, Transfers, Bulk Upload) plus the Transfers read view
// require editor+; Admin/user management requires admin. Business-logic correctness for
// each of these routes is already covered by their own *.test.ts files — this file only
// asserts who's let in.
describe("Role-based authorization", () => {
  let app: FastifyInstance;
  let viewerCookie: string;
  let editorCookie: string;
  let adminCookie: string;

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
    await app.register(bulkMergeRoutes);
    await app.register(adminUsersRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const db = await getPool();
    await db.query(`DELETE FROM user_audit_log`);
    await db.query(`DELETE FROM login_attempts`);
    await db.query(`DELETE FROM transfers`);
    await db.query(`DELETE FROM assets`);
    await db.query(`DELETE FROM users`);
    await db.query(`DELETE FROM centers`);
    await db.query(`DELETE FROM sub_classifications`);
    await db.query(`DELETE FROM statuses`);
    await db.query(`INSERT INTO centers (code) VALUES ('Center-Test')`);
    await db.query(`INSERT INTO sub_classifications (name) VALUES ('Test-Sub')`);
    await db.query(`INSERT INTO statuses (name, system_managed) VALUES ('Active', FALSE), ('Disposed', TRUE)`);
    await db.query(
      `INSERT INTO settings (id, as_at, fy_start, fy_end, days_in_fy) VALUES (TRUE, '2026-08-17', '2026-04-01', '2027-03-31', 365)
       ON CONFLICT (id) DO UPDATE SET as_at = '2026-08-17', fy_start = '2026-04-01', fy_end = '2027-03-31', days_in_fy = 365`
    );

    const viewer = await createTestUser({ username: "role-viewer", role: "viewer" });
    viewerCookie = authHeaderFor(viewer.id, viewer.username);
    const editor = await createTestUser({ username: "role-editor", role: "editor" });
    editorCookie = authHeaderFor(editor.id, editor.username);
    const admin = await createTestUser({ username: "role-admin", role: "admin" });
    adminCookie = authHeaderFor(admin.id, admin.username);
  });

  const NEW_ASSET = {
    farId: "ROLE-TEST-1",
    subClassification: "Test-Sub",
    assetDescription: "Role Test Asset",
    status: "Active",
    dateAcquired: "2026-01-01",
    location: "Center-Test",
    usefulLifeC1Years: 5,
    usefulLifeC2Years: 5,
    c1OpeningCost: 10000,
    c2OpeningCost: 10000
  };

  describe("Viewer: read-only", () => {
    it("can read the Register and Asset History", async () => {
      const list = await app.inject({ method: "GET", url: "/api/assets", headers: { cookie: viewerCookie } });
      expect(list.statusCode).toBe(200);

      const detail = await app.inject({
        method: "GET",
        url: "/api/assets/DOES-NOT-EXIST",
        headers: { cookie: viewerCookie }
      });
      // 404 (route reached, asset just doesn't exist) — not 403.
      expect(detail.statusCode).toBe(404);
    });

    it.each([
      ["POST", "/api/assets", NEW_ASSET],
      ["PATCH", "/api/assets/ROLE-TEST-1/disposal", { dateOfDisposal: "2026-08-01", saleValue: 0 }],
      ["POST", "/api/assets/ROLE-TEST-1/disposal/preview", { dateOfDisposal: "2026-08-01", saleValue: 0 }],
      ["POST", "/api/transfers", { farIds: ["ROLE-TEST-1"], toLocation: "Center-Test", transactionDate: "2026-08-01" }]
    ] as const)("is blocked (403) from %s %s", async (method, url, payload) => {
      const res = await app.inject({ method, url, headers: { cookie: viewerCookie }, payload });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe("FORBIDDEN");
    });

    it("is blocked (403) from the Transfers history view too, not just its write side", async () => {
      const res = await app.inject({ method: "GET", url: "/api/transfers", headers: { cookie: viewerCookie } });
      expect(res.statusCode).toBe(403);
    });

    it.each([
      ["/api/assets/bulk-upload"],
      ["/api/transfers/bulk-upload"],
      ["/api/assets/bulk-dispose"],
      ["/api/assets/bulk-merge"]
    ] as const)("is blocked (403) from Bulk Upload: %s", async (url) => {
      const { payload, headers } = emptyMultipartPayload();
      const res = await app.inject({ method: "POST", url, headers: { cookie: viewerCookie, ...headers }, payload });
      expect(res.statusCode).toBe(403);
    });

    it("is blocked (403) from Admin", async () => {
      const res = await app.inject({ method: "GET", url: "/api/admin/users", headers: { cookie: viewerCookie } });
      expect(res.statusCode).toBe(403);
    });
  });

  describe("Editor: full FAR-module access, no Admin", () => {
    it("can capitalize a new asset", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/assets",
        headers: { cookie: editorCookie },
        payload: NEW_ASSET
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ farId: "ROLE-TEST-1", created: true });
    });

    it("can dispose and preview-dispose an asset", async () => {
      await app.inject({ method: "POST", url: "/api/assets", headers: { cookie: editorCookie }, payload: NEW_ASSET });

      const preview = await app.inject({
        method: "POST",
        url: "/api/assets/ROLE-TEST-1/disposal/preview",
        headers: { cookie: editorCookie },
        payload: { dateOfDisposal: "2026-08-01", saleValue: 500 }
      });
      expect(preview.statusCode).toBe(200);

      const dispose = await app.inject({
        method: "PATCH",
        url: "/api/assets/ROLE-TEST-1/disposal",
        headers: { cookie: editorCookie },
        payload: { dateOfDisposal: "2026-08-01", saleValue: 500 }
      });
      expect(dispose.statusCode).toBe(200);
    });

    it("can read and create transfers", async () => {
      await app.inject({ method: "POST", url: "/api/assets", headers: { cookie: editorCookie }, payload: NEW_ASSET });

      const create = await app.inject({
        method: "POST",
        url: "/api/transfers",
        headers: { cookie: editorCookie },
        payload: { farIds: ["ROLE-TEST-1"], toLocation: "Center-Test", transactionDate: "2026-08-01" }
      });
      expect(create.statusCode).toBe(200);

      const history = await app.inject({ method: "GET", url: "/api/transfers", headers: { cookie: editorCookie } });
      expect(history.statusCode).toBe(200);
    });

    it.each([
      ["/api/assets/bulk-upload"],
      ["/api/transfers/bulk-upload"],
      ["/api/assets/bulk-dispose"],
      ["/api/assets/bulk-merge"]
    ] as const)("reaches the Bulk Upload handler (not blocked by role): %s", async (url) => {
      const { payload, headers } = emptyMultipartPayload();
      const res = await app.inject({ method: "POST", url, headers: { cookie: editorCookie, ...headers }, payload });
      // Not 403 — an empty upload reaches the handler and fails on "no file", which
      // proves the role gate let it through without needing a full valid file fixture
      // (that behavior is already covered by each route's own bulk*.test.ts).
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("No file was uploaded.");
    });

    it("is blocked (403) from Admin", async () => {
      const list = await app.inject({ method: "GET", url: "/api/admin/users", headers: { cookie: editorCookie } });
      expect(list.statusCode).toBe(403);

      const create = await app.inject({
        method: "POST",
        url: "/api/admin/users",
        headers: { cookie: editorCookie },
        payload: { username: "sneaky-editor", email: "sneaky-editor@example.com", password: "whatever-123" }
      });
      expect(create.statusCode).toBe(403);
    });
  });

  describe("Admin: full access, including user management", () => {
    it("can capitalize, dispose, and transfer", async () => {
      const create = await app.inject({
        method: "POST",
        url: "/api/assets",
        headers: { cookie: adminCookie },
        payload: NEW_ASSET
      });
      expect(create.statusCode).toBe(200);

      const transfer = await app.inject({
        method: "POST",
        url: "/api/transfers",
        headers: { cookie: adminCookie },
        payload: { farIds: ["ROLE-TEST-1"], toLocation: "Center-Test", transactionDate: "2026-08-01" }
      });
      expect(transfer.statusCode).toBe(200);

      const dispose = await app.inject({
        method: "PATCH",
        url: "/api/assets/ROLE-TEST-1/disposal",
        headers: { cookie: adminCookie },
        payload: { dateOfDisposal: "2026-08-02", saleValue: 500 }
      });
      expect(dispose.statusCode).toBe(200);
    });

    it("can manage users", async () => {
      const res = await app.inject({ method: "GET", url: "/api/admin/users", headers: { cookie: adminCookie } });
      expect(res.statusCode).toBe(200);
      const usernames = res.json().map((u: { username: string }) => u.username);
      expect(usernames).toEqual(expect.arrayContaining(["role-viewer", "role-editor", "role-admin"]));
    });
  });
});
