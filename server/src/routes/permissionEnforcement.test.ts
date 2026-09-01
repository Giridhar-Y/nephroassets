import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import assetsRoutes from "./assets.js";
import assetsExportRoutes from "./assetsExport.js";
import transfersRoutes from "./transfers.js";
import bulkUploadRoutes from "./bulkUpload.js";
import bulkDisposalsRoutes from "./bulkDisposals.js";
import bulkTransfersRoutes from "./bulkTransfers.js";
import bulkMergeRoutes from "./bulkMerge.js";
import reportsRoutes from "./reports.js";
import activityLogRoutes from "./activityLog.js";
import mastersRoutes from "./masters.js";
import bulkMastersRoutes from "./bulkMasters.js";
import settingsRoutes from "./settings.js";
import adminUsersRoutes from "./adminUsers.js";
import { getPool } from "../db/pool.js";
import { authGateHook } from "../auth/middleware.js";
import { authHeaderFor, createTestUser } from "../testHelpers/authTestUtils.js";
import { emptyMultipartPayload } from "./bulkTestHelpers.js";
import type { Module } from "../auth/permissions.js";

interface RouteCase {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  url: string;
  multipart?: boolean;
  payload?: Record<string, unknown>;
}

// Every server-enforced (module, action) pair from the Phase 2 mapping table, and every
// route it gates. Deliberately excludes capitalization/additions/disposals/assetHistory's
// own `view` actions (approved as client-nav-visibility-only — see this phase's own
// investigation: those pages all read through the same GET /api/assets that
// register:view already gates, so there's no second server boundary to test) and
// PATCH /api/settings/as-at (deliberately ungated, every authenticated role uses it).
//
// Path params point at ids/FAR IDs that don't exist and bodies are empty/minimal —
// irrelevant to what's being proven here: requirePermission's preHandler runs before
// any handler-level validation or business logic, so an authorized-but-otherwise-invalid
// request still proves the gate passed by landing on anything other than 401/403 (a 400,
// 404, or 409 from the handler's own checks). This mirrors roles.test.ts's own
// established "reaches the handler" pattern for the same reason.
const GATED: Record<string, RouteCase[]> = {
  "register:view": [{ method: "GET", url: "/api/assets" }, { method: "GET", url: "/api/assets/DOES-NOT-EXIST" }],
  "register:export": [{ method: "GET", url: "/api/assets/export" }],
  "register:edit": [
    { method: "PATCH", url: "/api/assets/DOES-NOT-EXIST" },
    { method: "POST", url: "/api/assets/merge", payload: { parentFarId: "DOES-NOT-EXIST", childFarIds: ["ALSO-NOT"] } }
  ],
  "capitalization:create": [{ method: "POST", url: "/api/assets" }],
  "capitalization:delete": [{ method: "DELETE", url: "/api/assets/DOES-NOT-EXIST" }],
  "additions:create": [{ method: "PATCH", url: "/api/assets/DOES-NOT-EXIST/addition" }],
  "additions:undo": [{ method: "POST", url: "/api/assets/DOES-NOT-EXIST/addition/undo", payload: { reason: "test" } }],
  "disposals:create": [
    { method: "POST", url: "/api/assets/DOES-NOT-EXIST/disposal/preview" },
    { method: "PATCH", url: "/api/assets/DOES-NOT-EXIST/disposal" }
  ],
  "disposals:undo": [{ method: "POST", url: "/api/assets/DOES-NOT-EXIST/disposal/undo", payload: { reason: "test" } }],
  "transfers:view": [{ method: "GET", url: "/api/transfers" }],
  "transfers:create": [{ method: "POST", url: "/api/transfers" }],
  "transfers:delete": [{ method: "DELETE", url: "/api/transfers/999999", payload: { reason: "test" } }],
  "bulkUpload:capitalization": [{ method: "POST", url: "/api/assets/bulk-upload", multipart: true }],
  "bulkUpload:transfers": [{ method: "POST", url: "/api/transfers/bulk-upload", multipart: true }],
  "bulkUpload:disposals": [{ method: "POST", url: "/api/assets/bulk-dispose", multipart: true }],
  "bulkUpload:merge": [{ method: "POST", url: "/api/assets/bulk-merge", multipart: true }],
  "reports:view": [
    { method: "GET", url: "/api/reports/location-summary" },
    { method: "GET", url: "/api/reports/audit-reconciliation" },
    { method: "GET", url: "/api/reports/depreciation-posting" },
    { method: "GET", url: "/api/reports/transfer-depreciation/movement" },
    { method: "GET", url: "/api/reports/transfer-depreciation/location-wise" },
    { method: "GET", url: "/api/reports/dashboard-summary" }
  ],
  "reports:export": [
    { method: "GET", url: "/api/reports/audit-reconciliation/export" },
    { method: "GET", url: "/api/reports/transfer-depreciation/export" }
  ],
  "activityLog:view": [{ method: "GET", url: "/api/audit-log/activity" }],
  "masters:view": [
    { method: "GET", url: "/api/masters/centers" },
    { method: "GET", url: "/api/masters/sub-classifications" },
    { method: "GET", url: "/api/masters/statuses" }
  ],
  "masters:edit": [
    { method: "POST", url: "/api/masters/centers", payload: { code: "" } },
    { method: "PATCH", url: "/api/masters/centers/999999" },
    { method: "POST", url: "/api/masters/sub-classifications", payload: { name: "" } },
    { method: "PATCH", url: "/api/masters/sub-classifications/999999" },
    { method: "POST", url: "/api/masters/statuses", payload: { name: "" } },
    { method: "PATCH", url: "/api/masters/statuses/999999" },
    { method: "POST", url: "/api/masters/centers/bulk-upload", multipart: true },
    { method: "POST", url: "/api/masters/sub-classifications/bulk-upload", multipart: true },
    { method: "POST", url: "/api/masters/statuses/bulk-upload", multipart: true }
  ],
  "settings:view": [{ method: "GET", url: "/api/settings" }],
  "settings:edit": [
    { method: "PUT", url: "/api/settings" },
    { method: "PATCH", url: "/api/settings/days-in-fy" },
    { method: "GET", url: "/api/settings/days-in-fy/preview?daysInFy=365" },
    { method: "GET", url: "/api/settings/audit-log" }
  ],
  "admin:view": [{ method: "GET", url: "/api/admin/users" }],
  "admin:create": [{ method: "POST", url: "/api/admin/users" }],
  "admin:edit": [{ method: "PATCH", url: "/api/admin/users/999999" }],
  "admin:resetPassword": [{ method: "POST", url: "/api/admin/users/999999/reset-password" }],
  "admin:managePermissions": [
    { method: "GET", url: "/api/admin/users/999999/permissions" },
    { method: "PUT", url: "/api/admin/users/999999/permissions", payload: { grants: [] } }
  ]
};

// Every route in this app that requires SOME session but isn't part of the module/action
// permission model at all — see auth/permissions.ts's own comment on why. Any
// authenticated user, regardless of permissions, must reach these.
const DELIBERATELY_UNGATED: RouteCase[] = [{ method: "PATCH", url: "/api/settings/as-at", payload: { asAt: "2020-01-01" } }];

describe("Permission enforcement — every (module, action) pair, at the API level", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    app.decorateRequest("user", null);
    app.addHook("preHandler", authGateHook);
    await app.register(cookie);
    await app.register(multipart);
    await app.register(assetsRoutes);
    await app.register(assetsExportRoutes);
    await app.register(transfersRoutes);
    await app.register(bulkUploadRoutes);
    await app.register(bulkDisposalsRoutes);
    await app.register(bulkTransfersRoutes);
    await app.register(bulkMergeRoutes);
    await app.register(reportsRoutes);
    await app.register(activityLogRoutes);
    await app.register(mastersRoutes);
    await app.register(bulkMastersRoutes);
    await app.register(settingsRoutes);
    await app.register(adminUsersRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function userWithOnly(module: Module, action: string): Promise<string> {
    const db = await getPool();
    const user = await createTestUser({ username: `perm-only-${module}-${action}-${Date.now()}`, role: "viewer" });
    await db.query(`DELETE FROM user_permissions WHERE user_id = $1`, [user.id]);
    await db.query(`INSERT INTO user_permissions (user_id, module, action) VALUES ($1, $2, $3)`, [
      user.id,
      module,
      action
    ]);
    return authHeaderFor(user.id, user.username);
  }

  async function userWithNoPermissions(): Promise<string> {
    const db = await getPool();
    const user = await createTestUser({ username: `perm-none-${Date.now()}-${Math.random()}`, role: "viewer" });
    await db.query(`DELETE FROM user_permissions WHERE user_id = $1`, [user.id]);
    return authHeaderFor(user.id, user.username);
  }

  function inject(cookieHeader: string, c: RouteCase) {
    if (c.multipart) {
      const { payload, headers } = emptyMultipartPayload();
      return app.inject({ method: c.method, url: c.url, headers: { cookie: cookieHeader, ...headers }, payload });
    }
    return app.inject({ method: c.method, url: c.url, headers: { cookie: cookieHeader }, payload: c.payload ?? {} });
  }

  for (const [key, routes] of Object.entries(GATED)) {
    const [module, action] = key.split(":") as [Module, string];

    describe(key, () => {
      it.each(routes.map((r) => [`${r.method} ${r.url}`, r] as const))(
        "a user granted exactly this permission reaches %s (not blocked by the gate)",
        async (_label, route) => {
          const granted = await userWithOnly(module, action);
          const res = await inject(granted, route);
          expect(res.statusCode).not.toBe(401);
          expect(res.statusCode).not.toBe(403);
        }
      );

      it.each(routes.map((r) => [`${r.method} ${r.url}`, r] as const))(
        "a user without this permission is blocked (403) from %s",
        async (_label, route) => {
          const bare = await userWithNoPermissions();
          const res = await inject(bare, route);
          expect(res.statusCode).toBe(403);
          expect(res.json().code).toBe("FORBIDDEN");
        }
      );
    });
  }

  describe("deliberately ungated routes", () => {
    it.each(DELIBERATELY_UNGATED.map((r) => [`${r.method} ${r.url}`, r] as const))(
      "any authenticated user, even with zero permissions, reaches %s",
      async (_label, route) => {
        const bare = await userWithNoPermissions();
        const res = await inject(bare, route);
        expect(res.statusCode).not.toBe(401);
        expect(res.statusCode).not.toBe(403);
      }
    );
  });

  // The specific, previously-real gap this phase closes: Masters writes had NO server
  // gate at all before this phase (see Phase 2's own investigation) — only the client UI
  // hid the form from viewers. Prove it's closed with a request shaped exactly like a
  // real write (not just an empty-body probe above), from a user with the OLD viewer
  // template (register/reports/masters:view/settings:view — no masters:edit at all,
  // matching a real un-upgraded viewer today).
  describe("Masters gap closure", () => {
    it.each([
      { method: "POST" as const, url: "/api/masters/centers", payload: { code: "Gap-Test-Center" } },
      { method: "PATCH" as const, url: "/api/masters/centers/1", payload: { description: "hacked" } },
      { method: "POST" as const, url: "/api/masters/sub-classifications", payload: { name: "Gap-Test-Sub" } },
      { method: "POST" as const, url: "/api/masters/statuses", payload: { name: "Gap-Test-Status" } }
    ])("a real viewer (masters:view only, no masters:edit) is blocked (403) from $method $url", async (route) => {
      const viewerCookie = await userWithOnly("masters", "view");
      const res = await inject(viewerCookie, route);
      expect(res.statusCode).toBe(403);
    });

    it("a real viewer is blocked (403) from every Masters bulk-upload route too", async () => {
      const viewerCookie = await userWithOnly("masters", "view");
      for (const url of [
        "/api/masters/centers/bulk-upload",
        "/api/masters/sub-classifications/bulk-upload",
        "/api/masters/statuses/bulk-upload"
      ]) {
        const res = await inject(viewerCookie, { method: "POST", url, multipart: true });
        expect(res.statusCode).toBe(403);
      }
    });
  });

  describe("Self-lockout guard", () => {
    it("a Super Admin can't revoke their own managePermissions grant", async () => {
      const db = await getPool();
      const admin = await createTestUser({ username: `self-lockout-${Date.now()}`, role: "admin" });
      const adminCookie = authHeaderFor(admin.id, admin.username);

      const { rows } = await db.query<{ module: string; action: string }>(
        `SELECT module, action FROM user_permissions WHERE user_id = $1 AND NOT (module = 'admin' AND action = 'managePermissions')`,
        [admin.id]
      );

      const res = await app.inject({
        method: "PUT",
        url: `/api/admin/users/${admin.id}/permissions`,
        headers: { cookie: adminCookie },
        payload: { grants: rows }
      });
      expect(res.statusCode).toBe(400);

      // Untouched — the rejected save must not have partially applied.
      const { rows: after } = await db.query(
        `SELECT 1 FROM user_permissions WHERE user_id = $1 AND module = 'admin' AND action = 'managePermissions'`,
        [admin.id]
      );
      expect(after).toHaveLength(1);
    });

    it("a Super Admin can't revoke their own admin:view grant", async () => {
      const db = await getPool();
      const admin = await createTestUser({ username: `self-lockout-view-${Date.now()}`, role: "admin" });
      const adminCookie = authHeaderFor(admin.id, admin.username);

      const { rows } = await db.query<{ module: string; action: string }>(
        `SELECT module, action FROM user_permissions WHERE user_id = $1 AND NOT (module = 'admin' AND action = 'view')`,
        [admin.id]
      );

      const res = await app.inject({
        method: "PUT",
        url: `/api/admin/users/${admin.id}/permissions`,
        headers: { cookie: adminCookie },
        payload: { grants: rows }
      });
      expect(res.statusCode).toBe(400);
    });

    it("a Super Admin CAN revoke someone else's managePermissions grant", async () => {
      const db = await getPool();
      const admin = await createTestUser({ username: `self-lockout-actor-${Date.now()}`, role: "admin" });
      const adminCookie = authHeaderFor(admin.id, admin.username);
      const target = await createTestUser({ username: `self-lockout-target-${Date.now()}`, role: "admin" });

      const { rows } = await db.query<{ module: string; action: string }>(
        `SELECT module, action FROM user_permissions WHERE user_id = $1 AND NOT (module = 'admin' AND action = 'managePermissions')`,
        [target.id]
      );

      const res = await app.inject({
        method: "PUT",
        url: `/api/admin/users/${target.id}/permissions`,
        headers: { cookie: adminCookie },
        payload: { grants: rows }
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe("PUT /api/admin/users/:id/permissions validation", () => {
    it("rejects a grant that isn't a real (module, action) pair", async () => {
      const admin = await createTestUser({ username: `perm-validate-${Date.now()}`, role: "admin" });
      const target = await createTestUser({ username: `perm-validate-target-${Date.now()}`, role: "viewer" });
      const res = await app.inject({
        method: "PUT",
        url: `/api/admin/users/${target.id}/permissions`,
        headers: { cookie: authHeaderFor(admin.id, admin.username) },
        payload: { grants: [{ module: "register", action: "not-a-real-action" }] }
      });
      expect(res.statusCode).toBe(400);
    });

    it("replaces the full grant set and reflects added/removed in the response", async () => {
      const admin = await createTestUser({ username: `perm-replace-${Date.now()}`, role: "admin" });
      const target = await createTestUser({ username: `perm-replace-target-${Date.now()}`, role: "viewer" });
      const res = await app.inject({
        method: "PUT",
        url: `/api/admin/users/${target.id}/permissions`,
        headers: { cookie: authHeaderFor(admin.id, admin.username) },
        payload: { grants: [{ module: "masters", action: "edit" }] }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().grants).toEqual([{ module: "masters", action: "edit" }]);

      const db = await getPool();
      const { rows } = await db.query(`SELECT module, action FROM user_permissions WHERE user_id = $1`, [target.id]);
      expect(rows).toEqual([{ module: "masters", action: "edit" }]);
    });
  });
});
