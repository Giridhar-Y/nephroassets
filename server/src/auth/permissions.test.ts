import { describe, expect, it, beforeEach } from "vitest";
import { getPool } from "../db/pool.js";
import { PERMISSION_REGISTRY, fetchRoleTemplate, seedBuiltInRoles, seedPermissionsFromRole, backfillUserPermissions } from "./permissions.js";
import { createTestUser } from "../testHelpers/authTestUtils.js";
import type { Role } from "./middleware.js";
import type { Permission } from "./permissions.js";

const ROLES: Role[] = ["viewer", "editor", "admin"];

async function templatesByRole(): Promise<Map<Role, Permission[]>> {
  const db = await getPool();
  await seedBuiltInRoles(db);
  const entries = await Promise.all(ROLES.map(async (role) => [role, await fetchRoleTemplate(db, role)] as const));
  return new Map(entries);
}

// Registry self-consistency — catches a typo'd (module, action) pair in a built-in
// role's seed template that would otherwise only surface as a silently-missing grant.
// Reads the actual roles/role_permissions rows, not the BUILT_IN_ROLE_TEMPLATES seed
// object directly — these are the real, live templates seedPermissionsFromRole and
// "Reset to [role] template" both read from (see auth/permissions.ts's own comment on
// why a Super Admin editing a built-in role's template is expected, not a bug).
describe("Built-in role templates (Viewer/Editor/Admin)", () => {
  it("only references (module, action) pairs that exist in PERMISSION_REGISTRY", async () => {
    const templates = await templatesByRole();
    for (const role of ROLES) {
      for (const { module, action } of templates.get(role)!) {
        const validActions: readonly string[] = PERMISSION_REGISTRY[module as keyof typeof PERMISSION_REGISTRY];
        expect(validActions).toContain(action);
      }
    }
  });

  it("has no duplicate (module, action) pairs within one role's template", async () => {
    const templates = await templatesByRole();
    for (const role of ROLES) {
      const keys = templates.get(role)!.map((p) => `${p.module}:${p.action}`);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it("admin's template is a superset of editor's, which is a superset of viewer's — matches today's tiered access", async () => {
    const templates = await templatesByRole();
    const key = (p: { module: string; action: string }) => `${p.module}:${p.action}`;
    const viewerKeys = new Set(templates.get("viewer")!.map(key));
    const editorKeys = new Set(templates.get("editor")!.map(key));
    const adminKeys = new Set(templates.get("admin")!.map(key));
    for (const k of viewerKeys) expect(editorKeys.has(k)).toBe(true);
    for (const k of editorKeys) expect(adminKeys.has(k)).toBe(true);
  });

  it("only admin's template grants admin:managePermissions", async () => {
    const templates = await templatesByRole();
    expect(templates.get("viewer")!.some((p) => p.module === "admin")).toBe(false);
    expect(templates.get("editor")!.some((p) => p.module === "admin")).toBe(false);
    expect(templates.get("admin")).toContainEqual({ module: "admin", action: "managePermissions" });
  });
});

describe("seedBuiltInRoles", () => {
  it("is idempotent and never overwrites a since-edited built-in role's template", async () => {
    const db = await getPool();
    await seedBuiltInRoles(db);
    const { rows: roleRows } = await db.query<{ id: string }>(`SELECT id FROM roles WHERE LOWER(name) = 'viewer'`);
    const roleId = roleRows[0]!.id;
    // This file shares one Postgres instance sequentially with every other test file
    // (vitest.config.ts's fileParallelism:false) — every OTHER file's createTestUser/
    // getSharedAuthHeader calls rely on Viewer's real template, so this test must leave
    // it exactly as it found it, not just assert against its own mutation.
    const original = (await db.query(`SELECT module, action FROM role_permissions WHERE role_id = $1`, [roleId])).rows;

    try {
      // Simulate a Super Admin having edited Viewer's template via the Roles master.
      await db.query(`DELETE FROM role_permissions WHERE role_id = $1`, [roleId]);
      await db.query(`INSERT INTO role_permissions (role_id, module, action) VALUES ($1, 'reports', 'view')`, [roleId]);

      await seedBuiltInRoles(db);

      const { rows } = await db.query(`SELECT module, action FROM role_permissions WHERE role_id = $1`, [roleId]);
      expect(rows).toEqual([{ module: "reports", action: "view" }]);
    } finally {
      await db.query(`DELETE FROM role_permissions WHERE role_id = $1`, [roleId]);
      for (const { module, action } of original) {
        await db.query(`INSERT INTO role_permissions (role_id, module, action) VALUES ($1, $2, $3)`, [roleId, module, action]);
      }
    }
  });
});

describe("seedPermissionsFromRole / backfillUserPermissions", () => {
  // Every test below uses its own distinct usernames, so there's no need to blanket
  // `DELETE FROM users`/`user_permissions`/`user_audit_log` between tests — and, since
  // this suite shares one Postgres instance sequentially across every test file (see
  // vitest.config.ts's fileParallelism:false), blanket-deleting `user_permissions`
  // specifically is actively harmful: it wipes the shared test-harness admin's grants
  // too (authTestUtils.ts's getSharedAuthHeader() only seeds them once, on its first
  // call across the whole suite run), and unlike before Phase 2's enforcement cutover,
  // that table now has real behavioral significance for every other test file that
  // authenticates as that shared admin. Learned this the hard way — see this file's own
  // git history for the very blanket delete that broke ~126 unrelated tests.

  it.each(ROLES)("seeds exactly that role's template for a %s", async (role) => {
    const user = await createTestUser({ username: `perm-${role}`, role });
    const db = await getPool();
    await seedPermissionsFromRole(db, user.id, role, null);

    const { rows } = await db.query<{ module: string; action: string }>(
      `SELECT module, action FROM user_permissions WHERE user_id = $1`,
      [user.id]
    );
    const got = new Set(rows.map((r) => `${r.module}:${r.action}`));
    const template = await fetchRoleTemplate(db, role);
    const want = new Set(template.map((p) => `${p.module}:${p.action}`));
    expect(got).toEqual(want);
  });

  it("is idempotent — calling it twice for the same user doesn't error or duplicate rows", async () => {
    const user = await createTestUser({ username: "perm-idempotent", role: "editor" });
    const db = await getPool();
    await seedPermissionsFromRole(db, user.id, "editor", null);
    await seedPermissionsFromRole(db, user.id, "editor", null);

    const { rows } = await db.query(`SELECT * FROM user_permissions WHERE user_id = $1`, [user.id]);
    const template = await fetchRoleTemplate(db, "editor");
    expect(rows).toHaveLength(template.length);
  });

  it("backfills every user who predates this table (zero permission rows) from their role", async () => {
    // Simulates real pre-migration data: users that exist with a role but no
    // user_permissions rows yet, exactly like every existing production user before
    // this feature shipped. createTestUser itself now auto-seeds on create (so every
    // OTHER test in this suite behaves like a real app user) — undo that here, scoped
    // to just these three ids, to get back to the "predates this table" state this test
    // actually wants to exercise.
    const viewer = await createTestUser({ username: "legacy-viewer", role: "viewer" });
    const editor = await createTestUser({ username: "legacy-editor", role: "editor" });
    const admin = await createTestUser({ username: "legacy-admin", role: "admin" });

    const db = await getPool();
    await db.query(`DELETE FROM user_permissions WHERE user_id = ANY($1)`, [[viewer.id, editor.id, admin.id]]);
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
      const template = await fetchRoleTemplate(db, role);
      const want = new Set(template.map((p) => `${p.module}:${p.action}`));
      expect(got).toEqual(want);
    }
  });

  it("never touches a user who already has permission rows, even a customized set", async () => {
    const user = await createTestUser({ username: "customized-user", role: "viewer" });
    const db = await getPool();
    // Replace createTestUser's own auto-seeded viewer template with a hand-customized
    // grant that doesn't match any role template at all — this test wants a user whose
    // ONLY permission is that custom one, not "viewer's template plus one extra."
    await db.query(`DELETE FROM user_permissions WHERE user_id = $1`, [user.id]);
    await db.query(`INSERT INTO user_permissions (user_id, module, action) VALUES ($1, 'admin', 'managePermissions')`, [
      user.id
    ]);

    await backfillUserPermissions(db);

    const { rows } = await db.query(`SELECT module, action FROM user_permissions WHERE user_id = $1`, [user.id]);
    expect(rows).toEqual([{ module: "admin", action: "managePermissions" }]);
  });
});
