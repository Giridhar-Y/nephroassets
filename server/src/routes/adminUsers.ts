import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { getPool } from "../db/pool.js";
import { hashPassword } from "../auth/password.js";
import { requirePermission, type Role } from "../auth/middleware.js";
import { allPermissions, fetchUserPermissions, isValidPermission, replaceUserPermissions, seedPermissionsFromRole } from "../auth/permissions.js";
import type { Permission } from "../auth/permissions.js";

const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === UNIQUE_VIOLATION;
}

/** Same role as routes/masters.ts's MasterError — a typed error the route handlers
 *  translate straight into a status + message. */
export class UserError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface AdminUserRow {
  id: number;
  username: string;
  email: string;
  role: Role;
  status: string;
  mustChangePassword: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

function mapUserRow(r: {
  id: string; // BIGSERIAL — node-postgres returns it as a string, not a number
  username: string;
  email: string;
  role: Role;
  status: string;
  must_change_password: boolean;
  created_at: Date | string;
  last_login_at: Date | string | null;
}): AdminUserRow {
  return {
    id: Number(r.id),
    username: r.username,
    email: r.email,
    role: r.role,
    status: r.status,
    mustChangePassword: r.must_change_password,
    createdAt: new Date(r.created_at).toISOString(),
    lastLoginAt: r.last_login_at ? new Date(r.last_login_at).toISOString() : null
  };
}

async function logAudit(
  db: Pick<pg.Pool | pg.PoolClient, "query">,
  actorUserId: number,
  action: string,
  targetUserId: number,
  details: Record<string, unknown>
): Promise<void> {
  await db.query(`INSERT INTO user_audit_log (actor_user_id, action, target_user_id, details) VALUES ($1, $2, $3, $4)`, [
    actorUserId,
    action,
    targetUserId,
    JSON.stringify(details)
  ]);
}

// Random, URL-safe, no admin-chosen value to leak or reuse — the admin relays this to
// the user out of band; must_change_password forces it to be replaced on first use.
function generateTempPassword(): string {
  return randomBytes(12).toString("base64url");
}

export async function fetchUsers(db: pg.Pool): Promise<AdminUserRow[]> {
  const { rows } = await db.query(
    `SELECT id, username, email, role, status, must_change_password, created_at, last_login_at
     FROM users ORDER BY username`
  );
  return rows.map(mapUserRow);
}

export async function createUser(
  db: pg.Pool,
  actorUserId: number,
  data: { username: string; email: string; password: string; role: Role }
): Promise<AdminUserRow> {
  const passwordHash = await hashPassword(data.password);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO users (username, email, password_hash, role, must_change_password)
       VALUES ($1, $2, $3, $4, TRUE)
       RETURNING id, username, email, role, status, must_change_password, created_at, last_login_at`,
      [data.username, data.email, passwordHash, data.role]
    );
    const user = mapUserRow(rows[0]);
    // Same-transaction as the INSERT above — a new user should never exist even
    // momentarily without the permission set their role implies (Phase 1 of the
    // per-user permissions move, see auth/permissions.ts).
    await seedPermissionsFromRole(client, user.id, data.role, actorUserId);
    await logAudit(client, actorUserId, "create", user.id, { username: user.username, email: user.email, role: user.role });
    await client.query("COMMIT");
    return user;
  } catch (err) {
    await client.query("ROLLBACK");
    if (isUniqueViolation(err)) throw new UserError(409, `A user with that username or email already exists.`);
    throw err;
  } finally {
    client.release();
  }
}

export async function updateUser(
  db: pg.Pool,
  actorUserId: number,
  targetId: number,
  patch: { email?: string; role?: Role; status?: "active" | "disabled" }
): Promise<AdminUserRow> {
  const { rows: existingRows } = await db.query(`SELECT email, role, status FROM users WHERE id = $1`, [targetId]);
  const existing = existingRows[0];
  if (!existing) throw new UserError(404, "No user found with that id.");
  if (targetId === actorUserId && existing.role === "admin" && patch.role !== undefined && patch.role !== "admin") {
    throw new UserError(400, "You can't remove your own admin access.");
  }
  if (targetId === actorUserId && patch.status === "disabled") {
    throw new UserError(400, "You can't disable your own account.");
  }

  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.email !== undefined) {
    values.push(patch.email);
    sets.push(`email = $${values.length}`);
  }
  if (patch.role !== undefined) {
    values.push(patch.role);
    sets.push(`role = $${values.length}`);
  }
  if (patch.status !== undefined) {
    values.push(patch.status);
    sets.push(`status = $${values.length}`);
  }
  if (sets.length === 0) throw new UserError(400, "Nothing to update.");
  values.push(targetId);

  let rows;
  try {
    ({ rows } = await db.query(
      `UPDATE users SET ${sets.join(", ")} WHERE id = $${values.length}
       RETURNING id, username, email, role, status, must_change_password, created_at, last_login_at`,
      values
    ));
  } catch (err) {
    if (isUniqueViolation(err)) throw new UserError(409, `A user with that email already exists.`);
    throw err;
  }

  // Logged as separate, precisely-named actions (rather than one generic "update") so
  // the audit trail reads the way the spec asks for it: create/disable/reset/role-change.
  if (patch.role !== undefined && patch.role !== existing.role) {
    await logAudit(db, actorUserId, "role_change", targetId, { from: existing.role, to: patch.role });
  }
  if (patch.status !== undefined && patch.status !== existing.status) {
    await logAudit(db, actorUserId, patch.status === "disabled" ? "disable" : "enable", targetId, {
      from: existing.status,
      to: patch.status
    });
  }
  if (patch.email !== undefined && patch.email !== existing.email) {
    await logAudit(db, actorUserId, "email_change", targetId, { from: existing.email, to: patch.email });
  }

  return mapUserRow(rows[0]);
}

export async function resetPassword(
  db: pg.Pool,
  actorUserId: number,
  targetId: number
): Promise<{ user: AdminUserRow; tempPassword: string }> {
  const tempPassword = generateTempPassword();
  const passwordHash = await hashPassword(tempPassword);
  const { rows } = await db.query(
    `UPDATE users SET password_hash = $1, must_change_password = TRUE WHERE id = $2
     RETURNING id, username, email, role, status, must_change_password, created_at, last_login_at`,
    [passwordHash, targetId]
  );
  if (!rows[0]) throw new UserError(404, "No user found with that id.");
  await logAudit(db, actorUserId, "reset_password", targetId, {});
  return { user: mapUserRow(rows[0]), tempPassword };
}

const permissionKey = (p: { module: string; action: string }): string => `${p.module}:${p.action}`;

/** Self-lockout guard for the permissions-matrix save below — mirrors updateUser's own
 *  "you can't remove your own admin access" check, extended to the two grants that
 *  would leave nobody (including the acting Super Admin themselves) able to fix
 *  permissions again: losing `admin:managePermissions` means this exact panel becomes
 *  unreachable for them, and losing `admin:view` means the Admin page itself won't load.
 *  Only checked when the target is the actor themselves — granting/revoking someone
 *  else's access, however drastic, is a normal Super Admin action. */
function assertNotSelfLockout(actorUserId: number, targetId: number, grants: Permission[]): void {
  if (targetId !== actorUserId) return;
  const keys = new Set(grants.map(permissionKey));
  if (!keys.has("admin:managePermissions") || !keys.has("admin:view")) {
    throw new UserError(400, "You can't remove your own permission-management access.");
  }
}

export async function replacePermissions(
  db: pg.Pool,
  actorUserId: number,
  targetId: number,
  rawGrants: Array<{ module: string; action: string }>
): Promise<Permission[]> {
  const { rows } = await db.query(`SELECT id FROM users WHERE id = $1`, [targetId]);
  if (!rows[0]) throw new UserError(404, "No user found with that id.");
  const grants: Permission[] = [];
  for (const { module, action } of rawGrants) {
    if (!isValidPermission(module, action)) {
      throw new UserError(400, `"${module}:${action}" is not a real permission.`);
    }
    grants.push({ module, action });
  }
  assertNotSelfLockout(actorUserId, targetId, grants);

  const { added, removed } = await replaceUserPermissions(db, targetId, actorUserId, grants);
  if (added.length > 0 || removed.length > 0) {
    await logAudit(db, actorUserId, "permissions_change", targetId, {
      added: added.map(permissionKey),
      removed: removed.map(permissionKey)
    });
  }
  return grants;
}

// --- HTTP routes ---------------------------------------------------------------------

const roleSchema = z.enum(["viewer", "editor", "admin"]);
const createUserSchema = z.object({
  username: z.string().min(3),
  email: z.string().email(),
  password: z.string().min(8),
  role: roleSchema.optional().default("viewer")
});
const patchUserSchema = z.object({
  email: z.string().email().optional(),
  role: roleSchema.optional(),
  status: z.enum(["active", "disabled"]).optional()
});
const idParamSchema = z.object({ id: z.coerce.number().int().positive() });
const permissionsSchema = z.object({
  grants: z.array(z.object({ module: z.string(), action: z.string() }))
});

function handleUserError(err: unknown, reply: { code: (n: number) => void }): { error: string } {
  if (err instanceof UserError) {
    reply.code(err.status);
    return { error: err.message };
  }
  throw err;
}

export default async function adminUsersRoutes(app: FastifyInstance) {
  app.get("/api/admin/users", { preHandler: requirePermission("admin", "view") }, async () => fetchUsers(await getPool()));

  app.post("/api/admin/users", { preHandler: requirePermission("admin", "create") }, async (req, reply) => {
    const parsed = createUserSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid user.", details: parsed.error.flatten() };
    }
    try {
      return await createUser(await getPool(), req.user!.id, parsed.data);
    } catch (err) {
      return handleUserError(err, reply);
    }
  });

  app.patch("/api/admin/users/:id", { preHandler: requirePermission("admin", "edit") }, async (req, reply) => {
    const paramsParsed = idParamSchema.safeParse(req.params);
    const bodyParsed = patchUserSchema.safeParse(req.body);
    if (!paramsParsed.success || !bodyParsed.success) {
      reply.code(400);
      return { error: "Invalid request.", details: bodyParsed.error?.flatten() };
    }
    try {
      return await updateUser(await getPool(), req.user!.id, paramsParsed.data.id, bodyParsed.data);
    } catch (err) {
      return handleUserError(err, reply);
    }
  });

  app.post(
    "/api/admin/users/:id/reset-password",
    { preHandler: requirePermission("admin", "resetPassword") },
    async (req, reply) => {
      const paramsParsed = idParamSchema.safeParse(req.params);
      if (!paramsParsed.success) {
        reply.code(400);
        return { error: "Invalid user id." };
      }
      try {
        return await resetPassword(await getPool(), req.user!.id, paramsParsed.data.id);
      } catch (err) {
        return handleUserError(err, reply);
      }
    }
  );

  // Permissions-matrix UI (Admin page's per-user "Permissions" panel) — both routes
  // gated by managePermissions specifically, not just admin:view/edit, since not every
  // Admin necessarily holds it (see auth/permissions.ts's own comment on that action).
  app.get(
    "/api/admin/users/:id/permissions",
    { preHandler: requirePermission("admin", "managePermissions") },
    async (req, reply) => {
      const paramsParsed = idParamSchema.safeParse(req.params);
      if (!paramsParsed.success) {
        reply.code(400);
        return { error: "Invalid user id." };
      }
      const db = await getPool();
      const { rows } = await db.query(`SELECT id FROM users WHERE id = $1`, [paramsParsed.data.id]);
      if (!rows[0]) {
        reply.code(404);
        return { error: "No user found with that id." };
      }
      return { grants: await fetchUserPermissions(db, paramsParsed.data.id), registry: allPermissions() };
    }
  );

  app.put(
    "/api/admin/users/:id/permissions",
    { preHandler: requirePermission("admin", "managePermissions") },
    async (req, reply) => {
      const paramsParsed = idParamSchema.safeParse(req.params);
      const bodyParsed = permissionsSchema.safeParse(req.body);
      if (!paramsParsed.success || !bodyParsed.success) {
        reply.code(400);
        return { error: "Invalid request.", details: bodyParsed.error?.flatten() };
      }
      try {
        const grants = await replacePermissions(
          await getPool(),
          req.user!.id,
          paramsParsed.data.id,
          bodyParsed.data.grants
        );
        return { grants };
      } catch (err) {
        return handleUserError(err, reply);
      }
    }
  );
}
