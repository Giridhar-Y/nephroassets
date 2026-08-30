import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPool } from "../db/pool.js";
import { mapSettingsRow, type SettingsRow } from "../db/mappers.js";
import { requirePermission } from "../auth/middleware.js";

const updateSettingsSchema = z.object({
  asAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fyStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fyEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  daysInFy: z.number().int().min(1).max(366)
});

// Shared by the PATCH and preview routes below — same 1-366 range updateSettingsSchema
// already enforces for the plain PUT /api/settings.
const daysInFySchema = z.object({ daysInFy: z.coerce.number().int().min(1).max(366) });

export default async function settingsRoutes(app: FastifyInstance) {
  app.get("/api/settings", { preHandler: requirePermission("settings", "view") }, async (_req, reply) => {
    const db = await getPool();
    const { rows } = await db.query<SettingsRow>(
      `SELECT as_at, fy_start, fy_end, days_in_fy FROM settings WHERE id = TRUE`
    );
    if (!rows[0]) {
      reply.code(404);
      return { error: "Settings have not been configured yet." };
    }
    return mapSettingsRow(rows[0]);
  });

  // Full-form save (FY Start/End, plus AS_AT/DaysInFy round-tripped unchanged by the
  // plain Settings page form) — admin-only, since FY Start/End are structural settings
  // that recompute every period's figures. AS_AT itself has its own lightweight,
  // non-admin route below (PATCH .../as-at) for the header's daily "Figures as of" picker,
  // which every role uses constantly — this route is NOT that picker's endpoint.
  app.put("/api/settings", { preHandler: requirePermission("settings", "edit") }, async (req, reply) => {
    const parsed = updateSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid settings payload.", details: parsed.error.flatten() };
    }
    const { asAt, fyStart, fyEnd, daysInFy } = parsed.data;
    if (fyEnd <= fyStart) {
      reply.code(400);
      return { error: "Financial Year End must be after Financial Year Start." };
    }
    if (asAt < fyStart || asAt > fyEnd) {
      reply.code(400);
      return { error: "AS_AT must fall within the financial year (between FY Start and FY End)." };
    }

    const db = await getPool();
    await db.query(
      `INSERT INTO settings (id, as_at, fy_start, fy_end, days_in_fy) VALUES (TRUE, $1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET as_at = $1, fy_start = $2, fy_end = $3, days_in_fy = $4`,
      [asAt, fyStart, fyEnd, daysInFy]
    );
    return { asAt, fyStart, fyEnd, daysInFy };
  });

  // Lightweight AS_AT-only change — the header's "Figures as of" picker (every role,
  // used constantly), split out from the now-admin-only PUT above so gating FY Start/End
  // doesn't also lock non-admins out of the app's single most-used control.
  app.patch("/api/settings/as-at", async (req, reply) => {
    const parsed = z.object({ asAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid AS_AT.", details: parsed.error.flatten() };
    }
    const db = await getPool();
    const { rows } = await db.query<SettingsRow>(
      `SELECT as_at, fy_start, fy_end, days_in_fy FROM settings WHERE id = TRUE`
    );
    if (!rows[0]) {
      reply.code(409);
      return { error: "Financial year settings have not been configured yet." };
    }
    const { fy_start: fyStart, fy_end: fyEnd } = rows[0];
    if (parsed.data.asAt < fyStart || parsed.data.asAt > fyEnd) {
      reply.code(400);
      return { error: "AS_AT must fall within the financial year (between FY Start and FY End)." };
    }
    await db.query(`UPDATE settings SET as_at = $1 WHERE id = TRUE`, [parsed.data.asAt]);
    return mapSettingsRow({ ...rows[0], as_at: parsed.data.asAt });
  });

  // Depreciation Formula Settings — DAYS_FY is the one hardcoded engine input that's a
  // genuine admin policy knob (see engine.ts's splitTranche: every other candidate — SLM
  // as the only method, the depreciation cap, display-only rounding — isn't). Split out
  // from the plain PUT above so it gets its own admin gate, confirm-step preview, and
  // audit trail; the plain form no longer edits this field (client/SettingsPage.tsx).
  app.patch("/api/settings/days-in-fy", { preHandler: requirePermission("settings", "edit") }, async (req, reply) => {
    const parsed = daysInFySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid Days in Financial Year.", details: parsed.error.flatten() };
    }
    const db = await getPool();
    const { rows } = await db.query<SettingsRow>(
      `SELECT as_at, fy_start, fy_end, days_in_fy FROM settings WHERE id = TRUE`
    );
    if (!rows[0]) {
      reply.code(409);
      return { error: "Financial year settings have not been configured yet." };
    }
    const oldValue = rows[0].days_in_fy;
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(`UPDATE settings SET days_in_fy = $1 WHERE id = TRUE`, [parsed.data.daysInFy]);
      await client.query(
        `INSERT INTO settings_audit_log (actor_user_id, field, old_value, new_value) VALUES ($1, 'daysInFy', $2, $3)`,
        [req.user!.id, String(oldValue), String(parsed.data.daysInFy)]
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    return mapSettingsRow({ ...rows[0], days_in_fy: parsed.data.daysInFy });
  });

  // Preview: how many assets' current-period depreciation would change, and by roughly
  // how much, if DAYS_FY were the proposed value instead — computed against every asset
  // in Register's own universe (date_acquired <= AS_AT), reusing far_calc_component the
  // same way reports.ts's aggregate reports already do at 250k-row scale, so this never
  // pulls per-row data into application code. Read-only — writes nothing.
  app.get("/api/settings/days-in-fy/preview", { preHandler: requirePermission("settings", "edit") }, async (req, reply) => {
    const parsed = daysInFySchema.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid Days in Financial Year.", details: parsed.error.flatten() };
    }
    const db = await getPool();
    const { rows: settingsRows } = await db.query<SettingsRow>(
      `SELECT as_at, fy_start, fy_end, days_in_fy FROM settings WHERE id = TRUE`
    );
    const fySettings = settingsRows[0];
    if (!fySettings) {
      reply.code(409);
      return { error: "Financial year settings have not been configured yet." };
    }
    const { rows } = await db.query<{
      total_assets: string;
      assets_changed: string;
      current_total: string;
      projected_total: string;
    }>(
      `WITH calc AS (
         SELECT
           far_calc_component(c1_opening_cost, additions_c1, date_of_addition, useful_life_c1_years,
             date_of_disposal, deletions_c1, sale_value, acc_dep_c1_opening, $1::date, $2::date, $5::date, $3::integer, date_acquired) AS old_c1,
           far_calc_component(c2_opening_cost, additions_c2, date_of_addition, useful_life_c2_years,
             date_of_disposal, deletions_c2, sale_value, acc_dep_c2_opening, $1::date, $2::date, $5::date, $3::integer, date_acquired) AS old_c2,
           far_calc_component(c1_opening_cost, additions_c1, date_of_addition, useful_life_c1_years,
             date_of_disposal, deletions_c1, sale_value, acc_dep_c1_opening, $1::date, $2::date, $5::date, $4::integer, date_acquired) AS new_c1,
           far_calc_component(c2_opening_cost, additions_c2, date_of_addition, useful_life_c2_years,
             date_of_disposal, deletions_c2, sale_value, acc_dep_c2_opening, $1::date, $2::date, $5::date, $4::integer, date_acquired) AS new_c2
         FROM assets
         WHERE date_acquired <= $1 AND deleted_at IS NULL
       )
       SELECT
         COUNT(*) AS total_assets,
         COUNT(*) FILTER (
           WHERE ROUND((new_c1).period_depreciation + (new_c2).period_depreciation, 2)
              <> ROUND((old_c1).period_depreciation + (old_c2).period_depreciation, 2)
         ) AS assets_changed,
         COALESCE(SUM((old_c1).period_depreciation + (old_c2).period_depreciation), 0) AS current_total,
         COALESCE(SUM((new_c1).period_depreciation + (new_c2).period_depreciation), 0) AS projected_total
       FROM calc`,
      [fySettings.as_at, fySettings.fy_start, fySettings.days_in_fy, parsed.data.daysInFy, fySettings.fy_end]
    );
    const r = rows[0]!;
    const currentTotal = Number(r.current_total);
    const projectedTotal = Number(r.projected_total);
    return {
      totalAssets: Number(r.total_assets),
      assetsChanged: Number(r.assets_changed),
      currentTotalPeriodDep: currentTotal,
      projectedTotalPeriodDep: projectedTotal,
      delta: projectedTotal - currentTotal
    };
  });

  app.get("/api/settings/audit-log", { preHandler: requirePermission("settings", "edit") }, async (_req, reply) => {
    const db = await getPool();
    const { rows } = await db.query<{
      id: string;
      field: string;
      old_value: string | null;
      new_value: string | null;
      created_at: string;
      username: string | null;
    }>(
      `SELECT sal.id, sal.field, sal.old_value, sal.new_value, sal.created_at, u.username
       FROM settings_audit_log sal
       LEFT JOIN users u ON u.id = sal.actor_user_id
       ORDER BY sal.created_at DESC
       LIMIT 50`
    );
    return {
      items: rows.map((r) => ({
        id: Number(r.id),
        field: r.field,
        oldValue: r.old_value,
        newValue: r.new_value,
        changedAt: new Date(r.created_at).toISOString(),
        username: r.username
      }))
    };
  });
}
