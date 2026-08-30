import type pg from "pg";
import type { Role } from "./middleware.js";

// Phase 1 of the move from fixed viewer/editor/admin roles to per-user, per-module
// access control. This registry (module -> valid actions) is the one and only
// definition of what's grantable — a plain TS const, not a DB table, since it only
// changes when a developer ships new code, never at runtime. `user_permissions`
// (schema.sql) is the actual per-user grant store; nothing in this file is read by any
// requireX preHandler yet — every route still enforces via `role` exactly as before.
// This phase only backfills/dual-writes user_permissions so it can be verified against
// real production data before a future phase cuts enforcement over to it.
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
  activityLog: ["view"],
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

// Exactly replicates what each role can do TODAY (every requireEditor/requireAdmin gate,
// every client-side nav-visibility restriction) — this is what existing users get
// backfilled to, and what a new user gets seeded with at creation. A "view" action with
// no distinct server endpoint of its own (Capitalization/Additions/Disposals/Bulk
// Upload's own "view" tabs all just reuse the already-viewer-open GET /api/assets) is
// granted here purely to match today's nav-visibility gate — whether that becomes a real
// server-side check is a decision for the phase that actually wires enforcement up, not
// this one.
export const ROLE_TEMPLATES: Record<Role, Permission[]> = {
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
    ...grants("activityLog", "view"),
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
    ...grants("activityLog", "view"),
    ...grants("masters", "view", "edit"),
    ...grants("settings", "view", "edit"),
    ...grants("admin", "view", "create", "edit", "resetPassword", "managePermissions")
  ]
};

/** Seeds one user's permission set from their role's template — used both by the
 *  one-time backfill below (for pre-existing users) and by adminUsers.ts's createUser
 *  (for brand-new ones), so both paths agree on exactly what a fresh grant set looks
 *  like. `grantedBy` is null for the automatic backfill, the acting admin's id for a
 *  create-time seed. */
export async function seedPermissionsFromRole(
  db: Pick<pg.Pool | pg.PoolClient, "query">,
  userId: number,
  role: Role,
  grantedBy: number | null
): Promise<void> {
  for (const { module, action } of ROLE_TEMPLATES[role]) {
    await db.query(
      `INSERT INTO user_permissions (user_id, module, action, granted_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, module, action) DO NOTHING`,
      [userId, module, action, grantedBy]
    );
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
