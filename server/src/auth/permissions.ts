import type pg from "pg";
import type { Role } from "./middleware.js";

// The move from fixed viewer/editor/admin roles to per-user, per-module access
// control. This registry (module -> valid actions) is the one and only definition of
// what's grantable — a plain TS const, not a DB table, since it only changes when a
// developer ships new code, never at runtime. `user_permissions` (schema.sql) is the
// actual per-user grant store, read by every route's `requirePermission` preHandler
// (auth/middleware.ts) — `role` itself grants nothing once a user exists; it's a
// creation-time template only (see ROLE_TEMPLATES below).
//
// Module boundaries follow the sidebar/mental model, not backend file layout — e.g.
// Register's `edit` action is `PATCH /api/assets/:farId`, which lives in assets.ts
// alongside Capitalization's own code, because that's where the Edit button is in the
// UI, not because of which route file happens to define it.
export const PERMISSION_REGISTRY = {
  register: ["view", "edit", "export"],
  assetHistory: ["view"],
  transfers: ["view", "create", "delete"],
  capitalization: ["view", "create", "delete"],
  additions: ["view", "create", "undo"],
  disposals: ["view", "create", "undo"],
  // One action per distinct Bulk Upload endpoint, not one blanket toggle — someone can
  // be trusted to bulk-transfer without also being trusted to bulk-dispose.
  bulkUpload: ["capitalization", "transfers", "disposals", "merge"],
  reports: ["view", "export"],
  activityLog: ["view", "export"],
  masters: ["view", "edit"],
  // FY-structural (AS_AT/FY start-end) and Depreciation Formula (DAYS_FY) collapse into
  // one `edit` action — the code already bundles all four settings endpoints under one
  // requireAdmin gate today, so splitting them here would add rows without a real need.
  settings: ["view", "edit"],
  // `managePermissions` is the "Super Admin" tier this whole project introduces — not a
  // new role, just a specific action within Admin that not every Admin necessarily
  // holds, separate from ordinary user CRUD.
  admin: ["view", "create", "edit", "resetPassword", "managePermissions"]
} as const;

export type Module = keyof typeof PERMISSION_REGISTRY;
export type ActionFor<M extends Module> = (typeof PERMISSION_REGISTRY)[M][number];
export interface Permission {
  module: Module;
  action: string;
}

function grants<M extends Module>(module: M, ...actions: Array<ActionFor<M>>): Permission[] {
  return actions.map((action) => ({ module, action }));
}

// Seed data ONLY — what the three built-in roles' templates are the very first time
// they're created (seedBuiltInRoles below). Once a role row exists, its
// role_permissions ARE the template; a Super Admin can freely edit it via the Roles
// master (routes/masters.ts), built-in or custom, and this object is never consulted
// again for that role. `capitalization`/`additions`/`disposals`/`assetHistory`'s own
// `view` actions have no distinct server endpoint — their pages all read through the
// same `GET /api/assets`/`GET /api/assets/:farId` that `register:view` already gates
// (see requirePermission's call sites in assets.ts) — so they're granted here purely to
// drive client-side nav visibility, not a second server-enforced boundary over the same
// data. `transfers:view` is different: `GET /api/transfers` is its own distinct,
// genuinely gated endpoint.
const BUILT_IN_ROLE_TEMPLATES: Record<"viewer" | "editor" | "admin", Permission[]> = {
  viewer: [
    ...grants("register", "view", "export"),
    ...grants("assetHistory", "view"),
    ...grants("reports", "view", "export"),
    ...grants("masters", "view"),
    ...grants("settings", "view")
  ],
  editor: [
    ...grants("register", "view", "edit", "export"),
    ...grants("assetHistory", "view"),
    ...grants("transfers", "view", "create"),
    ...grants("capitalization", "view", "create"),
    ...grants("additions", "view", "create"),
    ...grants("disposals", "view", "create"),
    ...grants("bulkUpload", "capitalization", "transfers", "disposals", "merge"),
    ...grants("reports", "view", "export"),
    ...grants("activityLog", "view", "export"),
    ...grants("masters", "view", "edit"),
    ...grants("settings", "view")
  ],
  admin: [
    ...grants("register", "view", "edit", "export"),
    ...grants("assetHistory", "view"),
    ...grants("transfers", "view", "create", "delete"),
    ...grants("capitalization", "view", "create", "delete"),
    ...grants("additions", "view", "create", "undo"),
    ...grants("disposals", "view", "create", "undo"),
    ...grants("bulkUpload", "capitalization", "transfers", "disposals", "merge"),
    ...grants("reports", "view", "export"),
    ...grants("activityLog", "view", "export"),
    ...grants("masters", "view", "edit"),
    ...grants("settings", "view", "edit"),
    ...grants("admin", "view", "create", "edit", "resetPassword", "managePermissions")
  ]
};

/** A role's current permission template, by name (case-insensitive, matching the
 *  active-master-lookup convention every other Master uses) — the one place
 *  seedPermissionsFromRole and the "Reset to [role] template" endpoint both read from.
 *  Empty array for an unknown role name (callers that need "role must exist" should
 *  check that separately, e.g. against the active roles list — see routes/masters.ts's
 *  fetchRolesWithUsage). */
export async function fetchRoleTemplate(db: Pick<pg.Pool | pg.PoolClient, "query">, roleName: string): Promise<Permission[]> {
  const { rows } = await db.query<{ module: Module; action: string }>(
    `SELECT rp.module, rp.action FROM role_permissions rp
     JOIN roles r ON r.id = rp.role_id
     WHERE LOWER(r.name) = LOWER($1)
     ORDER BY rp.module, rp.action`,
    [roleName]
  );
  return rows;
}

/** Seeds one user's permission set from their role's CURRENT template (roles/
 *  role_permissions — see fetchRoleTemplate) — used both by the one-time backfill below
 *  (for pre-existing users) and by adminUsers.ts's createUser (for brand-new ones), so
 *  both paths agree on exactly what a fresh grant set looks like. `grantedBy` is null
 *  for the automatic backfill, the acting admin's id for a create-time seed. */
export async function seedPermissionsFromRole(
  db: Pick<pg.Pool | pg.PoolClient, "query">,
  userId: number,
  role: Role,
  grantedBy: number | null
): Promise<void> {
  for (const { module, action } of await fetchRoleTemplate(db, role)) {
    await db.query(
      `INSERT INTO user_permissions (user_id, module, action, granted_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, module, action) DO NOTHING`,
      [userId, module, action, grantedBy]
    );
  }
}

/** One-time bootstrap of the three built-in roles (Viewer/Editor/Admin), each seeded
 *  from BUILT_IN_ROLE_TEMPLATES above — safe to call on every boot (see pool.ts's
 *  applySchema()). Only seeds a role's template at the moment its ROW is first created:
 *  if the role already exists (including on every boot after the first, or a database
 *  migrating in from before this table existed), its template is left completely
 *  alone — a Super Admin may have since edited it via the Roles master, and this must
 *  never silently undo that, the same "only fill the gap, never touch what's already
 *  there" posture backfillUserPermissions below already has for users. */
export async function seedBuiltInRoles(db: Pick<pg.Pool | pg.PoolClient, "query">): Promise<void> {
  for (const [name, template] of Object.entries(BUILT_IN_ROLE_TEMPLATES)) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO roles (name, system_managed) VALUES ($1, TRUE)
       ON CONFLICT (LOWER(name)) DO NOTHING RETURNING id`,
      [name]
    );
    if (rows.length === 0) continue;
    const roleId = Number(rows[0]!.id);
    for (const { module, action } of template) {
      await db.query(
        `INSERT INTO role_permissions (role_id, module, action) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [roleId, module, action]
      );
    }
  }
}

/** Replaces a role's entire permission template in one transaction (delete-all +
 *  insert-all) — same replace-all contract as replaceUserPermissions below, and the
 *  same reasoning: matches the Roles master UI's one Save of the full desired grant
 *  set, not incremental toggles. Returns the added/removed diff for the caller's
 *  master_activity_log entry (routes/masters.ts) — this function itself doesn't log
 *  anything, same convention every other write function in this codebase follows. */
export async function replaceRolePermissions(db: pg.Pool, roleId: number, grants: Permission[]): Promise<{ added: Permission[]; removed: Permission[] }> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows: existingRows } = await client.query<{ module: Module; action: string }>(
      `SELECT module, action FROM role_permissions WHERE role_id = $1`,
      [roleId]
    );
    const existingKeys = new Set(existingRows.map((r) => `${r.module}:${r.action}`));
    const incomingKeys = new Set(grants.map((g) => `${g.module}:${g.action}`));
    const added = grants.filter((g) => !existingKeys.has(`${g.module}:${g.action}`));
    const removed = existingRows.filter((r) => !incomingKeys.has(`${r.module}:${r.action}`));

    await client.query(`DELETE FROM role_permissions WHERE role_id = $1`, [roleId]);
    for (const { module, action } of grants) {
      await client.query(`INSERT INTO role_permissions (role_id, module, action) VALUES ($1, $2, $3)`, [roleId, module, action]);
    }
    await client.query("COMMIT");
    return { added, removed };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** True if (module, action) is a real, grantable pair — the one runtime check against
 *  PERMISSION_REGISTRY, used to validate a permissions-matrix save before it ever
 *  reaches the database. */
export function isValidPermission(module: string, action: string): module is Module {
  const actions: readonly string[] | undefined = (PERMISSION_REGISTRY as Record<string, readonly string[]>)[module];
  return actions !== undefined && actions.includes(action);
}

/** The full flat list of every grantable (module, action) pair, in registry order —
 *  what the permissions-matrix UI renders as its checkbox grid, independent of any one
 *  user's current grants. */
export function allPermissions(): Permission[] {
  return (Object.keys(PERMISSION_REGISTRY) as Module[]).flatMap((module) =>
    (PERMISSION_REGISTRY[module] as readonly string[]).map((action) => ({ module, action }))
  );
}

export async function fetchUserPermissions(db: Pick<pg.Pool | pg.PoolClient, "query">, userId: number): Promise<Permission[]> {
  const { rows } = await db.query<{ module: Module; action: string }>(
    `SELECT module, action FROM user_permissions WHERE user_id = $1 ORDER BY module, action`,
    [userId]
  );
  return rows;
}

/** Replaces a user's entire permission set in one transaction (delete-all + insert-all)
 *  — matches the permissions-matrix UI's own "one Save, full desired state" contract
 *  rather than incremental grant/revoke calls. Returns the added/removed diff purely
 *  for the audit log entry the caller writes (adminUsers.ts) — this function itself
 *  doesn't log anything, staying consistent with every other write function in this
 *  codebase (masters.ts, assets.ts) that leaves audit logging to its HTTP route. */
export async function replaceUserPermissions(
  db: pg.Pool,
  targetUserId: number,
  actorUserId: number,
  grants: Permission[]
): Promise<{ added: Permission[]; removed: Permission[] }> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows: existingRows } = await client.query<{ module: Module; action: string }>(
      `SELECT module, action FROM user_permissions WHERE user_id = $1`,
      [targetUserId]
    );
    const existingKeys = new Set(existingRows.map((r) => `${r.module}:${r.action}`));
    const incomingKeys = new Set(grants.map((g) => `${g.module}:${g.action}`));
    const added = grants.filter((g) => !existingKeys.has(`${g.module}:${g.action}`));
    const removed = existingRows.filter((r) => !incomingKeys.has(`${r.module}:${r.action}`));

    await client.query(`DELETE FROM user_permissions WHERE user_id = $1`, [targetUserId]);
    for (const { module, action } of grants) {
      await client.query(
        `INSERT INTO user_permissions (user_id, module, action, granted_by) VALUES ($1, $2, $3, $4)`,
        [targetUserId, module, action, actorUserId]
      );
    }
    await client.query("COMMIT");
    return { added, removed };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** One-time-per-user backfill: any user with zero permission rows gets their role's
 *  template applied. Guarded on "zero existing rows" so it's idempotent and safe to run
 *  on every server boot (see pool.ts's applySchema()) — it never touches a user whose
 *  permissions have since been customized, only ever fills in the gap for a user who
 *  predates this table (or, defensively, one somehow created without going through
 *  adminUsers.ts's createUser). */
export async function backfillUserPermissions(db: Pick<pg.Pool | pg.PoolClient, "query">): Promise<void> {
  const { rows } = await db.query<{ id: string; role: Role }>(
    `SELECT u.id, u.role FROM users u
     WHERE NOT EXISTS (SELECT 1 FROM user_permissions p WHERE p.user_id = u.id)`
  );
  for (const row of rows) {
    await seedPermissionsFromRole(db, Number(row.id), row.role, null);
  }
}
