import { describe, expect, it, beforeEach } from "vitest";
import { getPool } from "../db/pool.js";
import { PERMISSION_REGISTRY, ROLE_TEMPLATES, seedPermissionsFromRole, backfillUserPermissions } from "./permissions.js";
import { createTestUser } from "../testHelpers/authTestUtils.js";
import type { Role } from "./middleware.js";

const ROLES: Role[] = ["viewer", "editor", "admin"];

// Registry self-consistency — catches a typo'd (module, action) pair in ROLE_TEMPLATES
// that would otherwise only surface as a silently-missing grant.
describe("ROLE_TEMPLATES", () => {
  it("only references (module, action) pairs that exist in PERMISSION_REGISTRY", () => {
    for (const role of ROLES) {
      for (const { module, action } of ROLE_TEMPLATES[role]) {
        const validActions: readonly string[] = PERMISSION_REGISTRY[module];
        expect(validActions).toContain(action);
      }
    }
  });

  it("has no duplicate (module, action) pairs within one role's template", () => {
    for (const role of ROLES) {
      const keys = ROLE_TEMPLATES[role].map((p) => `${p.module}:${p.action}`);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it("admin's template is a superset of editor's, which is a superset of viewer's — matches today's tiered access", () => {
    const key = (p: { module: string; action: string }) => `${p.module}:${p.action}`;
    const viewerKeys = new Set(ROLE_TEMPLATES.viewer.map(key));
    const editorKeys = new Set(ROLE_TEMPLATES.editor.map(key));
    const adminKeys = new Set(ROLE_TEMPLATES.admin.map(key));
    for (const k of viewerKeys) expect(editorKeys.has(k)).toBe(true);
    for (const k of editorKeys) expect(adminKeys.has(k)).toBe(true);
  });

  it("only admin's template grants admin:managePermissions", () => {
    expect(ROLE_TEMPLATES.viewer.some((p) => p.module === "admin")).toBe(false);
    expect(ROLE_TEMPLATES.editor.some((p) => p.module === "admin")).toBe(false);
    expect(ROLE_TEMPLATES.admin).toContainEqual({ module: "admin", action: "managePermissions" });
  });
});

describe("seedPermissionsFromRole / backfillUserPermissions", () => {
  // Every test below uses its own distinct usernames, so there's no need to (and,
  // since this suite shares one Postgres instance sequentially across every test file
  // — see vitest.config.ts's fileParallelism:false — no safety in trying to) blanket
  // `DELETE FROM users`: other tables (e.g. master_activity_log.actor_user_id) reference
  // users without ON DELETE CASCADE, and a shared test-harness user from an earlier file
  // may already have rows there. user_permissions/user_audit_log have no such incoming
  // references, so clearing those is safe.
  beforeEach(async () => {
    const db = await getPool();
    await db.query(`DELETE FROM user_permissions`);
    await db.query(`DELETE FROM user_audit_log`);
  });

  it.each(ROLES)("seeds exactly that role's template for a %s", async (role) => {
    const user = await createTestUser({ username: `perm-${role}`, role });
    const db = await getPool();
    await seedPermissionsFromRole(db, user.id, role, null);

    const { rows } = await db.query<{ module: string; action: string }>(
      `SELECT module, action FROM user_permissions WHERE user_id = $1`,
      [user.id]
    );
    const got = new Set(rows.map((r) => `${r.module}:${r.action}`));
    const want = new Set(ROLE_TEMPLATES[role].map((p) => `${p.module}:${p.action}`));
    expect(got).toEqual(want);
  });

  it("is idempotent — calling it twice for the same user doesn't error or duplicate rows", async () => {
    const user = await createTestUser({ username: "perm-idempotent", role: "editor" });
    const db = await getPool();
    await seedPermissionsFromRole(db, user.id, "editor", null);
    await seedPermissionsFromRole(db, user.id, "editor", null);

    const { rows } = await db.query(`SELECT * FROM user_permissions WHERE user_id = $1`, [user.id]);
    expect(rows).toHaveLength(ROLE_TEMPLATES.editor.length);
  });

  it("backfills every user who predates this table (zero permission rows) from their role", async () => {
    // Simulates real pre-migration data: users that exist with a role but no
    // user_permissions rows yet, exactly like every existing production user before
    // this feature shipped.
    const viewer = await createTestUser({ username: "legacy-viewer", role: "viewer" });
    const editor = await createTestUser({ username: "legacy-editor", role: "editor" });
    const admin = await createTestUser({ username: "legacy-admin", role: "admin" });

    const db = await getPool();
    await backfillUserPermissions(db);

    for (const [user, role] of [
      [viewer, "viewer"],
      [editor, "editor"],
      [admin, "admin"]
    ] as const) {
      const { rows } = await db.query<{ module: string; action: string }>(
        `SELECT module, action FROM user_permissions WHERE user_id = $1`,
        [user.id]
      );
      const got = new Set(rows.map((r) => `${r.module}:${r.action}`));
      const want = new Set(ROLE_TEMPLATES[role].map((p) => `${p.module}:${p.action}`));
      expect(got).toEqual(want);
    }
  });

  it("never touches a user who already has permission rows, even a customized set", async () => {
    const user = await createTestUser({ username: "customized-user", role: "viewer" });
    const db = await getPool();
    // A hand-customized grant that doesn't match any role template at all.
    await db.query(`INSERT INTO user_permissions (user_id, module, action) VALUES ($1, 'admin', 'managePermissions')`, [
      user.id
    ]);

    await backfillUserPermissions(db);

    const { rows } = await db.query(`SELECT module, action FROM user_permissions WHERE user_id = $1`, [user.id]);
    expect(rows).toEqual([{ module: "admin", action: "managePermissions" }]);
  });
});
