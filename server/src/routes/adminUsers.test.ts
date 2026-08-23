import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import adminUsersRoutes from "./adminUsers.js";
import authRoutes from "./auth.js";
import { getPool } from "../db/pool.js";
import { authGateHook } from "../auth/middleware.js";
import { authHeaderFor, createTestUser } from "../testHelpers/authTestUtils.js";

describe("Admin: user management", () => {
  let app: FastifyInstance;
  let adminId: number;
  let adminCookie: string;
  let nonAdminCookie: string;

  beforeAll(async () => {
    app = Fastify();
    app.decorateRequest("user", null);
    app.addHook("preHandler", authGateHook);
    await app.register(cookie);
    await app.register(authRoutes);
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
    await db.query(`DELETE FROM users`);
    const admin = await createTestUser({ username: "admin-user", role: "admin" });
    adminId = admin.id;
    adminCookie = authHeaderFor(admin.id, admin.username);
    const nonAdmin = await createTestUser({ username: "regular-user", role: "editor" });
    nonAdminCookie = authHeaderFor(nonAdmin.id, nonAdmin.username);
  });

  it("401s an unauthenticated request", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/users" });
    expect(res.statusCode).toBe(401);
  });

  it("403s a non-admin user", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/users", headers: { cookie: nonAdminCookie } });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("FORBIDDEN");
  });

  it("lists users for an admin", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/users", headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);
    const usernames = res.json().map((u: { username: string }) => u.username);
    expect(usernames).toEqual(expect.arrayContaining(["admin-user", "regular-user"]));
  });

  it("creates a user with a temporary password that forces a change on first login, and logs it", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: { cookie: adminCookie },
      payload: { username: "new-hire", email: "new-hire@example.com", password: "temp-password-123", role: "editor" }
    });
    expect(res.statusCode).toBe(200);
    const created = res.json();
    expect(created.mustChangePassword).toBe(true);
    expect(created.role).toBe("editor");

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "new-hire", password: "temp-password-123" }
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().user.mustChangePassword).toBe(true);

    const db = await getPool();
    const { rows } = await db.query(
      `SELECT action, actor_user_id, target_user_id FROM user_audit_log WHERE action = 'create'`
    );
    expect(rows).toHaveLength(1);
    // actor_user_id/target_user_id are BIGINT — node-postgres returns them as strings.
    expect(Number(rows[0].actor_user_id)).toBe(adminId);
    expect(Number(rows[0].target_user_id)).toBe(created.id);
  });

  it("defaults a new user to the viewer role when none is specified", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: { cookie: adminCookie },
      payload: { username: "no-role-given", email: "no-role-given@example.com", password: "temp-password-123" }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().role).toBe("viewer");
  });

  it("rejects creating a user as a non-admin", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: { cookie: nonAdminCookie },
      payload: { username: "sneaky", email: "sneaky@example.com", password: "temp-password-123" }
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects a duplicate username", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: { cookie: adminCookie },
      payload: { username: "admin-user", email: "someone-else@example.com", password: "temp-password-123" }
    });
    expect(res.statusCode).toBe(409);
  });

  it("disables a user, logs it, and the disabled user is rejected on their very next request", async () => {
    const target = await createTestUser({ username: "to-disable", password: "correct-password-123" });
    const targetCookie = authHeaderFor(target.id, target.username);

    // Confirm the session works before disabling.
    const before = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: targetCookie } });
    expect(before.statusCode).toBe(200);

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${target.id}`,
      headers: { cookie: adminCookie },
      payload: { status: "disabled" }
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().status).toBe("disabled");

    // Same still-unexpired token, but requireAuth reads status fresh from the DB every
    // request — immediate revocation, not "whenever the token expires."
    const after = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: targetCookie } });
    expect(after.statusCode).toBe(401);

    const db = await getPool();
    const { rows } = await db.query(`SELECT action FROM user_audit_log WHERE action = 'disable' AND target_user_id = $1`, [
      target.id
    ]);
    expect(rows).toHaveLength(1);
  });

  it("re-enables a disabled user and logs it as 'enable'", async () => {
    const target = await createTestUser({ username: "to-reenable", status: "disabled" });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${target.id}`,
      headers: { cookie: adminCookie },
      payload: { status: "active" }
    });
    expect(res.statusCode).toBe(200);
    const db = await getPool();
    const { rows } = await db.query(`SELECT action FROM user_audit_log WHERE action = 'enable' AND target_user_id = $1`, [
      target.id
    ]);
    expect(rows).toHaveLength(1);
  });

  it("changes a user's role and logs it as 'role_change'", async () => {
    const target = await createTestUser({ username: "future-admin", role: "editor" });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${target.id}`,
      headers: { cookie: adminCookie },
      payload: { role: "admin" }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().role).toBe("admin");
    const db = await getPool();
    const { rows } = await db.query(
      `SELECT action, details FROM user_audit_log WHERE action = 'role_change' AND target_user_id = $1`,
      [target.id]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].details).toEqual({ from: "editor", to: "admin" });
  });

  it("an admin can't demote themselves away from admin, in any direction, or disable themselves", async () => {
    const toEditor = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${adminId}`,
      headers: { cookie: adminCookie },
      payload: { role: "editor" }
    });
    expect(toEditor.statusCode).toBe(400);

    const toViewer = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${adminId}`,
      headers: { cookie: adminCookie },
      payload: { role: "viewer" }
    });
    expect(toViewer.statusCode).toBe(400);

    const disableSelf = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${adminId}`,
      headers: { cookie: adminCookie },
      payload: { status: "disabled" }
    });
    expect(disableSelf.statusCode).toBe(400);
  });

  it("resets a password: returns a one-time temp password, forces a change, and logs it", async () => {
    const target = await createTestUser({ username: "needs-reset", password: "old-password-123" });
    const res = await app.inject({
      method: "POST",
      url: `/api/admin/users/${target.id}/reset-password`,
      headers: { cookie: adminCookie }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.tempPassword).toBe("string");
    expect(body.tempPassword.length).toBeGreaterThan(8);
    expect(body.user.mustChangePassword).toBe(true);

    // Old password no longer works; the new temp one does, and forces a change.
    const oldLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "needs-reset", password: "old-password-123" }
    });
    expect(oldLogin.statusCode).toBe(401);

    const newLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "needs-reset", password: body.tempPassword }
    });
    expect(newLogin.statusCode).toBe(200);
    expect(newLogin.json().user.mustChangePassword).toBe(true);

    const db = await getPool();
    const { rows } = await db.query(
      `SELECT action FROM user_audit_log WHERE action = 'reset_password' AND target_user_id = $1`,
      [target.id]
    );
    expect(rows).toHaveLength(1);
  });

  it("rejects reset-password from a non-admin", async () => {
    const target = await createTestUser({ username: "safe-user" });
    const res = await app.inject({
      method: "POST",
      url: `/api/admin/users/${target.id}/reset-password`,
      headers: { cookie: nonAdminCookie }
    });
    expect(res.statusCode).toBe(403);
  });
});
