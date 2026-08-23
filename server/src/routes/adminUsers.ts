import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { getPool } from "../db/pool.js";
import { hashPassword } from "../auth/password.js";
import { requireAdmin, type Role } from "../auth/middleware.js";

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
  db: pg.Pool,
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
  try {
    const { rows } = await db.query(
      `INSERT INTO users (username, email, password_hash, role, must_change_password)
       VALUES ($1, $2, $3, $4, TRUE)
       RETURNING id, username, email, role, status, must_change_password, created_at, last_login_at`,
      [data.username, data.email, passwordHash, data.role]
    );
    const user = mapUserRow(rows[0]);
    await logAudit(db, actorUserId, "create", user.id, { username: user.username, email: user.email, role: user.role });
    return user;
  } catch (err) {
    if (isUniqueViolation(err)) throw new UserError(409, `A user with that username or email already exists.`);
    throw err;
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

function handleUserError(err: unknown, reply: { code: (n: number) => void }): { error: string } {
  if (err instanceof UserError) {
    reply.code(err.status);
    return { error: err.message };
  }
  throw err;
}

export default async function adminUsersRoutes(app: FastifyInstance) {
  app.get("/api/admin/users", { preHandler: requireAdmin }, async () => fetchUsers(await getPool()));

  app.post("/api/admin/users", { preHandler: requireAdmin }, async (req, reply) => {
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

  app.patch("/api/admin/users/:id", { preHandler: requireAdmin }, async (req, reply) => {
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

  app.post("/api/admin/users/:id/reset-password", { preHandler: requireAdmin }, async (req, reply) => {
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
  });
}
