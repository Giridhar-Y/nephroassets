import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { getPool } from "../db/pool.js";
import { requirePermission } from "../auth/middleware.js";
import { blockingToggleMessage, findBlockingC2Assets } from "./componentTwoGuard.js";
import { logMasterActivity } from "./masterActivityLog.js";
import { isValidPermission, replaceRolePermissions, type Module, type Permission } from "../auth/permissions.js";

const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === UNIQUE_VIOLATION;
}

/** Only the fields `patch` actually sets AND that differ from `existing`'s current
 *  value — skips no-op fields (e.g. resubmitting the same code) so the Activity Log's
 *  old -> new diff never shows a field that didn't actually change. `existing` must
 *  already be keyed the same way as `patch` (camelCase, matching the patch schema) —
 *  callers with snake_case DB columns map them first. Returned alongside each
 *  `update*ById` function's own result, for routes/masters.ts's PATCH handlers to fold
 *  into `logMasterActivity`'s `details.previous`. */
function diffPrevious(existing: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const previous: Record<string, unknown> = {};
  for (const [key, newValue] of Object.entries(patch)) {
    if (newValue === undefined) continue;
    const oldValue = existing[key];
    if (oldValue !== newValue) previous[key] = oldValue;
  }
  return previous;
}

/** Thrown by the write functions below instead of touching `reply` directly, so the same
 *  functions serve both the HTTP handlers (which map status/message straight to the
 *  response) and the Masters bulk-upload route (routes/bulkMasters.ts, which maps it to a
 *  per-row Error instead of failing the whole request). */
export class MasterError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// --- Centers -----------------------------------------------------------------------

export interface CenterRow {
  id: number;
  code: string;
  description: string;
  active: boolean;
  usageCount: number;
}

export async function fetchCentersWithUsage(db: pg.Pool): Promise<CenterRow[]> {
  const { rows } = await db.query(
    `SELECT c.id, c.code, c.description, c.active,
            (SELECT COUNT(*) FROM assets a WHERE COALESCE(a.revised_location, a.location) = c.code) AS usage_count
     FROM centers c ORDER BY c.code`
  );
  return rows.map((r) => ({ id: r.id, code: r.code, description: r.description, active: r.active, usageCount: Number(r.usage_count) }));
}

export async function createCenter(
  db: pg.Pool,
  data: { code: string; description?: string; active?: boolean }
): Promise<{ id: number; code: string; description: string; active: boolean }> {
  try {
    const { rows } = await db.query(
      `INSERT INTO centers (code, description, active) VALUES ($1, $2, $3) RETURNING id, code, description, active`,
      [data.code, data.description ?? "", data.active ?? true]
    );
    return rows[0];
  } catch (err) {
    if (isUniqueViolation(err)) throw new MasterError(409, `A center with code "${data.code}" already exists.`);
    throw err;
  }
}

// Renaming `code` cascades to every assets/transfers row currently holding the old
// code, in the same transaction — otherwise the master list and those denormalized
// string columns would immediately disagree, exactly the problem this feature exists
// to prevent. Deactivating (active: false) never touches existing rows.
export async function updateCenterById(
  db: pg.Pool,
  id: number,
  patch: { code?: string; description?: string; active?: boolean }
): Promise<{
  id: number;
  code: string;
  description: string;
  active: boolean;
  assetsUpdated: number;
  transfersUpdated: number;
  previous: Record<string, unknown>;
}> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows: existingRows } = await client.query(`SELECT code, description, active FROM centers WHERE id = $1 FOR UPDATE`, [
      id
    ]);
    const existing = existingRows[0];
    if (!existing) throw new MasterError(404, "No center found with that id.");
    const previous = diffPrevious(existing, patch);

    let assetsUpdated = 0;
    let transfersUpdated = 0;
    const renaming = patch.code !== undefined && patch.code !== existing.code;
    if (renaming) {
      const { rows: a1 } = await client.query(`UPDATE assets SET location = $1 WHERE location = $2 RETURNING far_id`, [
        patch.code,
        existing.code
      ]);
      const { rows: a2 } = await client.query(
        `UPDATE assets SET revised_location = $1 WHERE revised_location = $2 RETURNING far_id`,
        [patch.code, existing.code]
      );
      const { rows: t1 } = await client.query(`UPDATE transfers SET location = $1 WHERE location = $2 RETURNING id`, [
        patch.code,
        existing.code
      ]);
      assetsUpdated = new Set([...a1, ...a2].map((r) => r.far_id)).size;
      transfersUpdated = t1.length;
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    if (patch.code !== undefined) {
      values.push(patch.code);
      sets.push(`code = $${values.length}`);
    }
    if (patch.description !== undefined) {
      values.push(patch.description);
      sets.push(`description = $${values.length}`);
    }
    if (patch.active !== undefined) {
      values.push(patch.active);
      sets.push(`active = $${values.length}`);
    }
    if (sets.length === 0) throw new MasterError(400, "Nothing to update.");
    values.push(id);
    const { rows } = await client.query(
      `UPDATE centers SET ${sets.join(", ")} WHERE id = $${values.length} RETURNING id, code, description, active`,
      values
    );
    await client.query("COMMIT");
    return { ...rows[0], assetsUpdated, transfersUpdated, previous };
  } catch (err) {
    await client.query("ROLLBACK");
    if (isUniqueViolation(err)) throw new MasterError(409, `A center with code "${patch.code}" already exists.`);
    throw err;
  } finally {
    client.release();
  }
}

// --- Sub Classifications -------------------------------------------------------------

export interface SubClassificationRow {
  id: number;
  name: string;
  defaultUsefulLifeC1Years: number | null;
  defaultUsefulLifeC2Years: number | null;
  hasComponent2: boolean;
  active: boolean;
  usageCount: number;
}

export async function fetchSubClassificationsWithUsage(db: pg.Pool): Promise<SubClassificationRow[]> {
  const { rows } = await db.query(
    `SELECT sc.id, sc.name, sc.default_useful_life_c1_years, sc.default_useful_life_c2_years, sc.has_component2, sc.active,
            (SELECT COUNT(*) FROM assets a WHERE a.sub_classification = sc.name) AS usage_count
     FROM sub_classifications sc ORDER BY sc.name`
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    defaultUsefulLifeC1Years: r.default_useful_life_c1_years === null ? null : Number(r.default_useful_life_c1_years),
    defaultUsefulLifeC2Years: r.default_useful_life_c2_years === null ? null : Number(r.default_useful_life_c2_years),
    hasComponent2: r.has_component2,
    active: r.active,
    usageCount: Number(r.usage_count)
  }));
}

export async function createSubClassification(
  db: pg.Pool,
  data: {
    name: string;
    defaultUsefulLifeC1Years?: number | null;
    defaultUsefulLifeC2Years?: number | null;
    hasComponent2?: boolean;
    active?: boolean;
  }
) {
  try {
    const { rows } = await db.query(
      `INSERT INTO sub_classifications (name, default_useful_life_c1_years, default_useful_life_c2_years, has_component2, active)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, default_useful_life_c1_years, default_useful_life_c2_years, has_component2, active`,
      [data.name, data.defaultUsefulLifeC1Years ?? null, data.defaultUsefulLifeC2Years ?? null, data.hasComponent2 ?? true, data.active ?? true]
    );
    const r = rows[0];
    return {
      id: r.id,
      name: r.name,
      defaultUsefulLifeC1Years: r.default_useful_life_c1_years === null ? null : Number(r.default_useful_life_c1_years),
      defaultUsefulLifeC2Years: r.default_useful_life_c2_years === null ? null : Number(r.default_useful_life_c2_years),
      hasComponent2: r.has_component2,
      active: r.active
    };
  } catch (err) {
    if (isUniqueViolation(err)) throw new MasterError(409, `A sub classification named "${data.name}" already exists.`);
    throw err;
  }
}

export async function updateSubClassificationById(
  db: pg.Pool,
  id: number,
  patch: {
    name?: string;
    defaultUsefulLifeC1Years?: number | null;
    defaultUsefulLifeC2Years?: number | null;
    hasComponent2?: boolean;
    active?: boolean;
  }
) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows: existingRows } = await client.query(
      `SELECT name, default_useful_life_c1_years, default_useful_life_c2_years, has_component2, active
       FROM sub_classifications WHERE id = $1 FOR UPDATE`,
      [id]
    );
    const existing = existingRows[0];
    if (!existing) throw new MasterError(404, "No sub classification found with that id.");
    const previous = diffPrevious(
      {
        name: existing.name,
        defaultUsefulLifeC1Years: existing.default_useful_life_c1_years === null ? null : Number(existing.default_useful_life_c1_years),
        defaultUsefulLifeC2Years: existing.default_useful_life_c2_years === null ? null : Number(existing.default_useful_life_c2_years),
        hasComponent2: existing.has_component2,
        active: existing.active
      },
      patch
    );

    // Blocking rule: can't turn Component 2 off while any asset under this
    // classification (by its CURRENT name — the rename above, if any, hasn't been
    // applied yet at this point) still has real C2 data. Checked inside the same
    // FOR UPDATE transaction as the read above, so a concurrent asset edit can't slip a
    // new C2 figure in between this check and the write below.
    if (patch.hasComponent2 === false && existing.has_component2 === true) {
      const blocking = await findBlockingC2Assets(client, existing.name);
      if (blocking.count > 0) {
        throw new MasterError(409, blockingToggleMessage(existing.name, blocking.count, blocking.sampleFarIds));
      }
    }

    let assetsUpdated = 0;
    if (patch.name !== undefined && patch.name !== existing.name) {
      const { rows } = await client.query(
        `UPDATE assets SET sub_classification = $1 WHERE sub_classification = $2 RETURNING far_id`,
        [patch.name, existing.name]
      );
      assetsUpdated = rows.length;
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    if (patch.name !== undefined) {
      values.push(patch.name);
      sets.push(`name = $${values.length}`);
    }
    if (patch.defaultUsefulLifeC1Years !== undefined) {
      values.push(patch.defaultUsefulLifeC1Years);
      sets.push(`default_useful_life_c1_years = $${values.length}`);
    }
    if (patch.defaultUsefulLifeC2Years !== undefined) {
      values.push(patch.defaultUsefulLifeC2Years);
      sets.push(`default_useful_life_c2_years = $${values.length}`);
    }
    if (patch.hasComponent2 !== undefined) {
      values.push(patch.hasComponent2);
      sets.push(`has_component2 = $${values.length}`);
    }
    if (patch.active !== undefined) {
      values.push(patch.active);
      sets.push(`active = $${values.length}`);
    }
    if (sets.length === 0) throw new MasterError(400, "Nothing to update.");
    values.push(id);
    const { rows } = await client.query(
      `UPDATE sub_classifications SET ${sets.join(", ")} WHERE id = $${values.length}
       RETURNING id, name, default_useful_life_c1_years, default_useful_life_c2_years, has_component2, active`,
      values
    );
    await client.query("COMMIT");
    const r = rows[0];
    return {
      id: r.id,
      name: r.name,
      defaultUsefulLifeC1Years: r.default_useful_life_c1_years === null ? null : Number(r.default_useful_life_c1_years),
      defaultUsefulLifeC2Years: r.default_useful_life_c2_years === null ? null : Number(r.default_useful_life_c2_years),
      hasComponent2: r.has_component2,
      active: r.active,
      assetsUpdated,
      previous
    };
  } catch (err) {
    await client.query("ROLLBACK");
    if (isUniqueViolation(err)) throw new MasterError(409, `A sub classification named "${patch.name}" already exists.`);
    throw err;
  } finally {
    client.release();
  }
}

// --- Statuses --------------------------------------------------------------------

export interface StatusRow {
  id: number;
  name: string;
  active: boolean;
  systemManaged: boolean;
  usageCount: number;
}

export async function fetchStatusesWithUsage(db: pg.Pool): Promise<StatusRow[]> {
  const { rows } = await db.query(
    `SELECT s.id, s.name, s.active, s.system_managed,
            (SELECT COUNT(*) FROM assets a WHERE a.status = s.name) AS usage_count
     FROM statuses s ORDER BY s.name`
  );
  return rows.map((r) => ({ id: r.id, name: r.name, active: r.active, systemManaged: r.system_managed, usageCount: Number(r.usage_count) }));
}

export async function createStatus(db: pg.Pool, data: { name: string; active?: boolean }) {
  try {
    // system_managed is never settable via the API — only seedMasters() ever creates
    // one (Disposed), so there's no path for a user to fake that flag on their own entry.
    const { rows } = await db.query(
      `INSERT INTO statuses (name, active) VALUES ($1, $2) RETURNING id, name, active, system_managed`,
      [data.name, data.active ?? true]
    );
    return { ...rows[0], systemManaged: rows[0].system_managed };
  } catch (err) {
    if (isUniqueViolation(err)) throw new MasterError(409, `A status named "${data.name}" already exists.`);
    throw err;
  }
}

export async function updateStatusById(db: pg.Pool, id: number, patch: { name?: string; active?: boolean }) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows: existingRows } = await client.query(
      `SELECT name, active, system_managed FROM statuses WHERE id = $1 FOR UPDATE`,
      [id]
    );
    const existing = existingRows[0];
    if (!existing) throw new MasterError(404, "No status found with that id.");
    if (existing.system_managed) throw new MasterError(409, `"${existing.name}" is a system-managed status and cannot be edited.`);
    const previous = diffPrevious({ name: existing.name, active: existing.active }, patch);

    let assetsUpdated = 0;
    if (patch.name !== undefined && patch.name !== existing.name) {
      const { rows } = await client.query(`UPDATE assets SET status = $1 WHERE status = $2 RETURNING far_id`, [
        patch.name,
        existing.name
      ]);
      assetsUpdated = rows.length;
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    if (patch.name !== undefined) {
      values.push(patch.name);
      sets.push(`name = $${values.length}`);
    }
    if (patch.active !== undefined) {
      values.push(patch.active);
      sets.push(`active = $${values.length}`);
    }
    if (sets.length === 0) throw new MasterError(400, "Nothing to update.");
    values.push(id);
    const { rows } = await client.query(
      `UPDATE statuses SET ${sets.join(", ")} WHERE id = $${values.length} RETURNING id, name, active, system_managed`,
      values
    );
    await client.query("COMMIT");
    return { ...rows[0], systemManaged: rows[0].system_managed, assetsUpdated, previous };
  } catch (err) {
    await client.query("ROLLBACK");
    if (isUniqueViolation(err)) throw new MasterError(409, `A status named "${patch.name}" already exists.`);
    throw err;
  } finally {
    client.release();
  }
}

// --- Roles -------------------------------------------------------------------------
// A manageable Master (like Centers/Sub Classifications/Statuses above) rather than a
// hardcoded viewer/editor/admin enum — see schema.sql's roles/role_permissions comment
// and auth/permissions.ts's seedBuiltInRoles for the three built-in rows. A role is a
// NAME plus a permission template (role_permissions); creating/editing one never
// touches any user — it only changes what a FUTURE user gets, at creation time or an
// explicit "Reset to [role] template" (routes/adminUsers.ts). Deliberately no bulk
// upload, unlike the three Masters above — a handful of roles doesn't need one.

export interface RoleRow {
  id: number;
  name: string;
  active: boolean;
  systemManaged: boolean;
  usageCount: number;
  grants: Permission[];
}

export async function fetchRolesWithUsage(db: pg.Pool): Promise<RoleRow[]> {
  const { rows } = await db.query(
    `SELECT r.id, r.name, r.active, r.system_managed,
            (SELECT COUNT(*) FROM users u WHERE LOWER(u.role) = LOWER(r.name)) AS usage_count
     FROM roles r ORDER BY r.name`
  );
  const { rows: grantRows } = await db.query<{ role_id: string; module: Module; action: string }>(
    `SELECT role_id, module, action FROM role_permissions ORDER BY role_id, module, action`
  );
  const grantsByRole = new Map<string, Permission[]>();
  for (const g of grantRows) {
    const list = grantsByRole.get(g.role_id);
    const grant = { module: g.module, action: g.action };
    if (list) list.push(grant);
    else grantsByRole.set(g.role_id, [grant]);
  }
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    active: r.active,
    systemManaged: r.system_managed,
    usageCount: Number(r.usage_count),
    grants: grantsByRole.get(String(r.id)) ?? []
  }));
}

export async function createRole(
  db: pg.Pool,
  data: { name: string; grants: Array<{ module: string; action: string }> }
): Promise<RoleRow> {
  const grants: Permission[] = [];
  for (const g of data.grants) {
    if (!isValidPermission(g.module, g.action)) throw new MasterError(400, `"${g.module}:${g.action}" is not a real permission.`);
    grants.push({ module: g.module, action: g.action });
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`INSERT INTO roles (name) VALUES ($1) RETURNING id, name, active, system_managed`, [
      data.name
    ]);
    const role = rows[0];
    for (const { module, action } of grants) {
      await client.query(`INSERT INTO role_permissions (role_id, module, action) VALUES ($1, $2, $3)`, [role.id, module, action]);
    }
    await client.query("COMMIT");
    return { id: role.id, name: role.name, active: role.active, systemManaged: role.system_managed, usageCount: 0, grants };
  } catch (err) {
    await client.query("ROLLBACK");
    if (isUniqueViolation(err)) throw new MasterError(409, `A role named "${data.name}" already exists.`);
    throw err;
  } finally {
    client.release();
  }
}

// Renaming cascades to every user currently holding the old role name (same
// transaction, same reasoning as updateCenterById's cascade to assets/transfers) so
// users.role and the Roles master never disagree. system_managed (Viewer/Editor/Admin)
// blocks BOTH rename and deactivate here — same convention as updateStatusById — but
// NOT its permission template, which stays editable regardless; see
// replaceRolePermissionsById below.
export async function updateRoleById(
  db: pg.Pool,
  id: number,
  patch: { name?: string; active?: boolean }
): Promise<{
  id: number;
  name: string;
  active: boolean;
  systemManaged: boolean;
  usersUpdated: number;
  previous: Record<string, unknown>;
}> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows: existingRows } = await client.query(
      `SELECT name, active, system_managed FROM roles WHERE id = $1 FOR UPDATE`,
      [id]
    );
    const existing = existingRows[0];
    if (!existing) throw new MasterError(404, "No role found with that id.");
    if (existing.system_managed) {
      throw new MasterError(409, `"${existing.name}" is a built-in role and cannot be renamed or deactivated.`);
    }
    const previous = diffPrevious({ name: existing.name, active: existing.active }, patch);

    let usersUpdated = 0;
    if (patch.name !== undefined && patch.name !== existing.name) {
      const { rows } = await client.query(`UPDATE users SET role = $1 WHERE role = $2 RETURNING id`, [patch.name, existing.name]);
      usersUpdated = rows.length;
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    if (patch.name !== undefined) {
      values.push(patch.name);
      sets.push(`name = $${values.length}`);
    }
    if (patch.active !== undefined) {
      values.push(patch.active);
      sets.push(`active = $${values.length}`);
    }
    if (sets.length === 0) throw new MasterError(400, "Nothing to update.");
    values.push(id);
    const { rows } = await client.query(
      `UPDATE roles SET ${sets.join(", ")} WHERE id = $${values.length} RETURNING id, name, active, system_managed`,
      values
    );
    await client.query("COMMIT");
    const r = rows[0];
    return { id: r.id, name: r.name, active: r.active, systemManaged: r.system_managed, usersUpdated, previous };
  } catch (err) {
    await client.query("ROLLBACK");
    if (isUniqueViolation(err)) throw new MasterError(409, `A role named "${patch.name}" already exists.`);
    throw err;
  } finally {
    client.release();
  }
}

/** Edits a role's own permission template — the checkbox-matrix "Save" — works for ANY
 *  role, built-in or custom (see updateRoleById's comment for why system_managed
 *  doesn't block this one). Never touches an existing user's actual grants, only what a
 *  future user (created with, or reset to, this role) would get. */
export async function replaceRolePermissionsById(
  db: pg.Pool,
  id: number,
  rawGrants: Array<{ module: string; action: string }>
): Promise<{ grants: Permission[]; added: Permission[]; removed: Permission[] }> {
  const { rows } = await db.query(`SELECT id FROM roles WHERE id = $1`, [id]);
  if (!rows[0]) throw new MasterError(404, "No role found with that id.");
  const grants: Permission[] = [];
  for (const { module, action } of rawGrants) {
    if (!isValidPermission(module, action)) throw new MasterError(400, `"${module}:${action}" is not a real permission.`);
    grants.push({ module, action });
  }
  const { added, removed } = await replaceRolePermissions(db, id, grants);
  return { grants, added, removed };
}

// --- HTTP routes ---------------------------------------------------------------------

const createCenterSchema = z.object({ code: z.string().min(1), description: z.string().optional().default("") });
const patchCenterSchema = z.object({ code: z.string().min(1).optional(), description: z.string().optional(), active: z.boolean().optional() });

const createSubClassSchema = z.object({
  name: z.string().min(1),
  defaultUsefulLifeC1Years: z.coerce.number().min(0).nullable().optional(),
  defaultUsefulLifeC2Years: z.coerce.number().min(0).nullable().optional(),
  hasComponent2: z.boolean().optional()
});
const patchSubClassSchema = z.object({
  name: z.string().min(1).optional(),
  defaultUsefulLifeC1Years: z.coerce.number().min(0).nullable().optional(),
  defaultUsefulLifeC2Years: z.coerce.number().min(0).nullable().optional(),
  hasComponent2: z.boolean().optional(),
  active: z.boolean().optional()
});

const createStatusSchema = z.object({ name: z.string().min(1) });
const patchStatusSchema = z.object({ name: z.string().min(1).optional(), active: z.boolean().optional() });

const grantSchema = z.object({ module: z.string(), action: z.string() });
const createRoleSchema = z.object({ name: z.string().min(1), grants: z.array(grantSchema).default([]) });
const patchRoleSchema = z.object({ name: z.string().min(1).optional(), active: z.boolean().optional() });
const rolePermissionsSchema = z.object({ grants: z.array(grantSchema) });

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

function handleMasterError(err: unknown, reply: { code: (n: number) => void }): { error: string } {
  if (err instanceof MasterError) {
    reply.code(err.status);
    return { error: err.message };
  }
  throw err;
}

export default async function mastersRoutes(app: FastifyInstance) {
  // --- Centers ---------------------------------------------------------------------

  app.get(
    "/api/masters/centers",
    { preHandler: requirePermission("masters", "view") },
    async () => fetchCentersWithUsage(await getPool())
  );

  app.post("/api/masters/centers", { preHandler: requirePermission("masters", "edit") }, async (req, reply) => {
    const parsed = createCenterSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid center.", details: parsed.error.flatten() };
    }
    const db = await getPool();
    try {
      const result = await createCenter(db, parsed.data);
      await logMasterActivity(db, {
        actorUserId: req.user!.id,
        action: "center_create",
        details: { ...parsed.data, source: "single" }
      });
      return result;
    } catch (err) {
      return handleMasterError(err, reply);
    }
  });

  app.patch("/api/masters/centers/:id", { preHandler: requirePermission("masters", "edit") }, async (req, reply) => {
    const paramsParsed = idParamSchema.safeParse(req.params);
    const bodyParsed = patchCenterSchema.safeParse(req.body);
    if (!paramsParsed.success || !bodyParsed.success) {
      reply.code(400);
      return { error: "Invalid request.", details: bodyParsed.error?.flatten() };
    }
    const db = await getPool();
    try {
      const result = await updateCenterById(db, paramsParsed.data.id, bodyParsed.data);
      await logMasterActivity(db, {
        actorUserId: req.user!.id,
        action: "center_update",
        details: {
          ...bodyParsed.data,
          assetsUpdated: result.assetsUpdated,
          transfersUpdated: result.transfersUpdated,
          previous: result.previous,
          source: "single"
        }
      });
      return result;
    } catch (err) {
      return handleMasterError(err, reply);
    }
  });

  // --- Sub Classifications -----------------------------------------------------------

  app.get(
    "/api/masters/sub-classifications",
    { preHandler: requirePermission("masters", "view") },
    async () => fetchSubClassificationsWithUsage(await getPool())
  );

  app.post(
    "/api/masters/sub-classifications",
    { preHandler: requirePermission("masters", "edit") },
    async (req, reply) => {
    const parsed = createSubClassSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid sub classification.", details: parsed.error.flatten() };
    }
    const db = await getPool();
    try {
      const result = await createSubClassification(db, parsed.data);
      await logMasterActivity(db, {
        actorUserId: req.user!.id,
        action: "sub_classification_create",
        details: { ...parsed.data, source: "single" }
      });
      return result;
    } catch (err) {
      return handleMasterError(err, reply);
    }
  });

  app.patch(
    "/api/masters/sub-classifications/:id",
    { preHandler: requirePermission("masters", "edit") },
    async (req, reply) => {
    const paramsParsed = idParamSchema.safeParse(req.params);
    const bodyParsed = patchSubClassSchema.safeParse(req.body);
    if (!paramsParsed.success || !bodyParsed.success) {
      reply.code(400);
      return { error: "Invalid request.", details: bodyParsed.error?.flatten() };
    }
    const db = await getPool();
    try {
      const result = await updateSubClassificationById(db, paramsParsed.data.id, bodyParsed.data);
      await logMasterActivity(db, {
        actorUserId: req.user!.id,
        action: "sub_classification_update",
        details: { ...bodyParsed.data, assetsUpdated: result.assetsUpdated, previous: result.previous, source: "single" }
      });
      return result;
    } catch (err) {
      return handleMasterError(err, reply);
    }
  });

  // --- Statuses ------------------------------------------------------------------

  app.get(
    "/api/masters/statuses",
    { preHandler: requirePermission("masters", "view") },
    async () => fetchStatusesWithUsage(await getPool())
  );

  app.post("/api/masters/statuses", { preHandler: requirePermission("masters", "edit") }, async (req, reply) => {
    const parsed = createStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid status.", details: parsed.error.flatten() };
    }
    const db = await getPool();
    try {
      const result = await createStatus(db, parsed.data);
      await logMasterActivity(db, {
        actorUserId: req.user!.id,
        action: "status_create",
        details: { ...parsed.data, source: "single" }
      });
      return result;
    } catch (err) {
      return handleMasterError(err, reply);
    }
  });

  app.patch("/api/masters/statuses/:id", { preHandler: requirePermission("masters", "edit") }, async (req, reply) => {
    const paramsParsed = idParamSchema.safeParse(req.params);
    const bodyParsed = patchStatusSchema.safeParse(req.body);
    if (!paramsParsed.success || !bodyParsed.success) {
      reply.code(400);
      return { error: "Invalid request.", details: bodyParsed.error?.flatten() };
    }
    const db = await getPool();
    try {
      const result = await updateStatusById(db, paramsParsed.data.id, bodyParsed.data);
      await logMasterActivity(db, {
        actorUserId: req.user!.id,
        action: "status_update",
        details: { ...bodyParsed.data, assetsUpdated: result.assetsUpdated, previous: result.previous, source: "single" }
      });
      return result;
    } catch (err) {
      return handleMasterError(err, reply);
    }
  });

  // --- Roles -------------------------------------------------------------------------
  // List/name/active follow the same masters:view/edit gate as every other Master
  // above. The two routes that shape a role's actual permission template (create, and
  // the dedicated .../permissions endpoint) are additionally gated on
  // admin:managePermissions — the same "Super Admin" tier the per-user Permissions
  // panel already requires (routes/adminUsers.ts), since defining what a role grants is
  // exactly that kind of action, not an ordinary Masters edit.

  app.get(
    "/api/masters/roles",
    { preHandler: requirePermission("masters", "view") },
    async () => fetchRolesWithUsage(await getPool())
  );

  app.post("/api/masters/roles", { preHandler: requirePermission("admin", "managePermissions") }, async (req, reply) => {
    const parsed = createRoleSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid role.", details: parsed.error.flatten() };
    }
    const db = await getPool();
    try {
      const result = await createRole(db, parsed.data);
      await logMasterActivity(db, {
        actorUserId: req.user!.id,
        action: "role_create",
        details: { name: parsed.data.name, grants: parsed.data.grants, source: "single" }
      });
      return result;
    } catch (err) {
      return handleMasterError(err, reply);
    }
  });

  app.patch("/api/masters/roles/:id", { preHandler: requirePermission("masters", "edit") }, async (req, reply) => {
    const paramsParsed = idParamSchema.safeParse(req.params);
    const bodyParsed = patchRoleSchema.safeParse(req.body);
    if (!paramsParsed.success || !bodyParsed.success) {
      reply.code(400);
      return { error: "Invalid request.", details: bodyParsed.error?.flatten() };
    }
    const db = await getPool();
    try {
      const result = await updateRoleById(db, paramsParsed.data.id, bodyParsed.data);
      await logMasterActivity(db, {
        actorUserId: req.user!.id,
        action: "role_update",
        details: { ...bodyParsed.data, usersUpdated: result.usersUpdated, previous: result.previous, source: "single" }
      });
      return result;
    } catch (err) {
      return handleMasterError(err, reply);
    }
  });

  app.put(
    "/api/masters/roles/:id/permissions",
    { preHandler: requirePermission("admin", "managePermissions") },
    async (req, reply) => {
      const paramsParsed = idParamSchema.safeParse(req.params);
      const bodyParsed = rolePermissionsSchema.safeParse(req.body);
      if (!paramsParsed.success || !bodyParsed.success) {
        reply.code(400);
        return { error: "Invalid request.", details: bodyParsed.error?.flatten() };
      }
      const db = await getPool();
      try {
        const { grants, added, removed } = await replaceRolePermissionsById(db, paramsParsed.data.id, bodyParsed.data.grants);
        if (added.length > 0 || removed.length > 0) {
          await logMasterActivity(db, {
            actorUserId: req.user!.id,
            action: "role_update",
            details: {
              roleId: paramsParsed.data.id,
              added: added.map((g) => `${g.module}:${g.action}`),
              removed: removed.map((g) => `${g.module}:${g.action}`),
              source: "single"
            }
          });
        }
        return { grants };
      } catch (err) {
        return handleMasterError(err, reply);
      }
    }
  );
}
