import { getPool } from "../db/pool.js";

// Removes what db/seed.ts's seed() and seedMasters() generate when SEED_ON_BOOT isn't
// explicitly "false" — see those functions for how each is created. Neither tags its
// rows with an is_demo/source column (both do plain INSERTs, same shape as real data),
// so this identifies them the only reliable way available in each case — see each
// phase below for its own reasoning.
//
// Two phases, both dry-run by default (CONFIRM=yes to actually delete either):
//   1. Assets (+ their transfers) — seed()'s own direct output. Pattern: far_id
//      matching FAR-###### exactly.
//   2. Centers — seedMasters()'s indirect output: it runs unconditionally on every
//      boot (not gated by SEED_ON_BOOT itself) and derives centers/sub_classifications/
//      statuses from whatever's in assets/transfers at the time, but only once ever
//      (no-ops the instant centers has any row) — so if seed() ran even once, these
//      demo-derived centers are permanent until removed by hand; nothing ever
//      regenerates or cleans them up on its own, even after the demo assets themselves
//      are deleted. Pattern: code matching Center-### exactly (seed()'s own CENTERS
//      constant).
//
// Sub Classifications and Statuses are deliberately NOT auto-deleted anywhere in this
// script — see the report-only section at the end for why.
//
// Both deletable phases additionally exclude — never delete — anything showing signs
// of real use since seeding (see each phase for its own specific checks). Idempotent:
// re-running after a real cleanup finds nothing left to do.
//
// Usage:
//   npx tsx src/scripts/cleanupDemoSeedData.ts                # dry run (default)
//   CONFIRM=yes npx tsx src/scripts/cleanupDemoSeedData.ts     # actually deletes

const db = await getPool();
const CONFIRM = process.env.CONFIRM === "yes";

// ============================================================================
// Phase 1: demo assets (+ their transfers)
// ============================================================================

const DEMO_FAR_ID_PATTERN = "^FAR-[0-9]{6}$";

async function cleanupAssets(): Promise<void> {
  console.log("=== Assets ===");
  const { rows: candidateRows } = await db.query<{ far_id: string }>(
    `SELECT far_id FROM assets WHERE far_id ~ $1 ORDER BY far_id`,
    [DEMO_FAR_ID_PATTERN]
  );

  if (candidateRows.length === 0) {
    console.log("No demo-pattern assets found (far_id matching FAR-######) — nothing to do.\n");
    return;
  }

  // That pattern is a strong signal, not a database-level guarantee — a real asset
  // COULD coincidentally have a FAR ID in this exact shape (FAR ID format restrictions
  // were deliberately removed, see far_id_format_restriction_removed), so this
  // additionally excludes — never deletes — any matching row that shows ANY sign of
  // having been touched through the real app since seeding: an activity/delete-audit
  // log entry, a bulk-action log mention, a soft-delete, or a parent/child
  // relationship. seed() never creates any of those for the rows it inserts (it writes
  // directly to assets/transfers, bypassing every route that would create one), so
  // their presence is exactly the signal that a real user interacted with that row
  // after it was seeded.
  const { rows: touchedRows } = await db.query<{ far_id: string; reason: string }>(
    `SELECT a.far_id, reason FROM assets a
     CROSS JOIN LATERAL (
       SELECT string_agg(r, ', ') AS reason FROM (
         SELECT 'has asset_activity_log entries' AS r WHERE EXISTS (
           SELECT 1 FROM asset_activity_log l WHERE l.far_id = a.far_id)
         UNION ALL
         SELECT 'has asset_delete_audit_log entries' WHERE EXISTS (
           SELECT 1 FROM asset_delete_audit_log l WHERE l.far_id = a.far_id)
         UNION ALL
         SELECT 'mentioned in a bulk action log' WHERE EXISTS (
           SELECT 1 FROM asset_bulk_action_log l WHERE l.details::text LIKE '%' || a.far_id || '%')
         UNION ALL
         SELECT 'already soft-deleted' WHERE a.deleted_at IS NOT NULL
         UNION ALL
         SELECT 'has a parent_far_id set' WHERE a.parent_far_id IS NOT NULL
         UNION ALL
         SELECT 'has disposed_via_parent_far_id set' WHERE a.disposed_via_parent_far_id IS NOT NULL
         UNION ALL
         SELECT 'is itself a parent/disposal-source of another asset' WHERE EXISTS (
           SELECT 1 FROM assets c WHERE c.parent_far_id = a.far_id OR c.disposed_via_parent_far_id = a.far_id)
       ) reasons
     ) t
     WHERE a.far_id ~ $1 AND t.reason IS NOT NULL
     ORDER BY a.far_id`,
    [DEMO_FAR_ID_PATTERN]
  );
  const touchedIds = new Set(touchedRows.map((r) => r.far_id));
  const safeToDelete = candidateRows.map((r) => r.far_id).filter((id) => !touchedIds.has(id));

  const { rows: transferRows } = await db.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM transfers WHERE far_id = ANY($1)`,
    [safeToDelete]
  );

  console.log(`Demo-pattern assets found: ${candidateRows.length} (${candidateRows[0]!.far_id} .. ${candidateRows[candidateRows.length - 1]!.far_id})`);
  console.log(`Excluded — show signs of real use, will NOT be touched: ${touchedRows.length}`);
  for (const r of touchedRows) console.log(`  ${r.far_id}: ${r.reason}`);
  console.log(`Safe to delete: ${safeToDelete.length} assets, ${transferRows[0]!.c} associated transfer rows`);

  if (!CONFIRM) {
    console.log("Dry run only — nothing deleted.\n");
    return;
  }
  if (safeToDelete.length === 0) {
    console.log("Nothing safe to delete (everything matching was excluded above).\n");
    return;
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // transfers.far_id has no ON DELETE CASCADE (see schema.sql) — must go first, or
    // the assets DELETE fails on any row with transfer history.
    await client.query(`DELETE FROM transfers WHERE far_id = ANY($1)`, [safeToDelete]);
    const { rowCount } = await client.query(`DELETE FROM assets WHERE far_id = ANY($1)`, [safeToDelete]);
    await client.query("COMMIT");
    console.log(`Deleted ${rowCount} assets and their transfer history.\n`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ============================================================================
// Phase 2: centers seedMasters() derived from the demo assets
// ============================================================================

const DEMO_CENTER_CODE_PATTERN = "^Center-[0-9]{3}$";

async function cleanupCenters(): Promise<void> {
  console.log("=== Centers ===");
  const { rows: candidateRows } = await db.query<{ id: string; code: string }>(
    `SELECT id, code FROM centers WHERE code ~ $1 ORDER BY code`,
    [DEMO_CENTER_CODE_PATTERN]
  );

  if (candidateRows.length === 0) {
    console.log("No demo-pattern centers found (code matching Center-###) — nothing to do.\n");
    return;
  }

  // Same pattern-not-guarantee caveat as assets above (no real center is likely to be
  // named exactly "Center-005", but it's not impossible if someone genuinely liked that
  // convention) — excludes any matching center showing a sign of real use:
  //   - a non-demo asset (or transfer) actually located there
  //   - a real user_center_access grant against it
  //   - a non-empty description (seedMasters() never sets one — a blank string is its
  //     own DEFAULT, see schema.sql — so any non-empty value was typed by a real admin
  //     via the Masters UI)
  //   - inactive (seedMasters() always creates centers active=true; deactivating one is
  //     itself a deliberate Masters-UI action)
  //   - mentioned in master_activity_log (any create/update through the real UI)
  const { rows: touchedRows } = await db.query<{ code: string; reason: string }>(
    `SELECT c.code, reason FROM centers c
     CROSS JOIN LATERAL (
       SELECT string_agg(r, ', ') AS reason FROM (
         SELECT 'a non-demo asset is located there' AS r WHERE EXISTS (
           SELECT 1 FROM assets a
           WHERE (a.location = c.code OR a.revised_location = c.code) AND a.far_id !~ $2)
         UNION ALL
         SELECT 'a non-demo transfer references it' WHERE EXISTS (
           SELECT 1 FROM transfers t WHERE t.location = c.code AND t.far_id !~ $2)
         UNION ALL
         SELECT 'has a real user_center_access grant' WHERE EXISTS (
           SELECT 1 FROM user_center_access uca WHERE uca.center_id = c.id)
         UNION ALL
         SELECT 'has a non-empty description (admin-edited)' WHERE c.description <> ''
         UNION ALL
         SELECT 'is inactive (admin-deactivated)' WHERE c.active = FALSE
         UNION ALL
         SELECT 'mentioned in master_activity_log' WHERE EXISTS (
           SELECT 1 FROM master_activity_log l WHERE l.details::text LIKE '%' || c.code || '%')
       ) reasons
     ) t
     WHERE c.code ~ $1 AND t.reason IS NOT NULL
     ORDER BY c.code`,
    [DEMO_CENTER_CODE_PATTERN, DEMO_FAR_ID_PATTERN]
  );
  const touchedCodes = new Set(touchedRows.map((r) => r.code));
  const safeToDelete = candidateRows.filter((r) => !touchedCodes.has(r.code));

  console.log(`Demo-pattern centers found: ${candidateRows.length} (${candidateRows[0]!.code} .. ${candidateRows[candidateRows.length - 1]!.code})`);
  console.log(`Excluded — show signs of real use, will NOT be touched: ${touchedRows.length}`);
  for (const r of touchedRows) console.log(`  ${r.code}: ${r.reason}`);
  console.log(`Safe to delete: ${safeToDelete.length} centers`);

  if (!CONFIRM) {
    console.log("Dry run only — nothing deleted.\n");
    return;
  }
  if (safeToDelete.length === 0) {
    console.log("Nothing safe to delete (everything matching was excluded above).\n");
    return;
  }

  const { rowCount } = await db.query(`DELETE FROM centers WHERE id = ANY($1)`, [safeToDelete.map((r) => r.id)]);
  console.log(`Deleted ${rowCount} centers.\n`);
}

// ============================================================================
// Report only: Sub Classifications and Statuses — never auto-deleted
// ============================================================================
//
// Unlike Centers ("Center-001".."Center-025", a naming pattern no real deployment
// would plausibly reuse), seed()'s SUB_CLASSIFICATIONS ("Dialysis Machines", "RO
// Plants", "Medical Equipment", ...) and STATUSES ("Active", "Disposed", "Under
// Repair") are exactly the kind of generic, plausible names a real dialysis-asset
// deployment might deliberately choose too — there's no reliable way to tell "this is
// demo flavor" from "this is the real baseline someone typed in on purpose" from the
// data alone. Worse, "Disposed" specifically is not optional at all: schema.sql marks
// it system_managed and several routes (transfers.ts, bulkDisposals.ts, the disposal
// PATCH endpoint) hardcode that literal string — deleting or renaming it would break
// the disposal flow outright, seeded or not. This is a decision for a human, not a
// pattern match, so this script only reports what exists and leaves it alone.
async function reportAmbiguousMasters(): Promise<void> {
  console.log("=== Sub Classifications & Statuses (report only — not deleted by this script) ===");
  const { rows: subs } = await db.query<{ name: string; active: boolean }>(
    `SELECT name, active FROM sub_classifications ORDER BY name`
  );
  const { rows: statuses } = await db.query<{ name: string; active: boolean; system_managed: boolean }>(
    `SELECT name, active, system_managed FROM statuses ORDER BY name`
  );
  console.log(`Sub Classifications (${subs.length}): ${subs.map((s) => s.name).join(", ") || "(none)"}`);
  console.log(`Statuses (${statuses.length}): ${statuses.map((s) => `${s.name}${s.system_managed ? " [system_managed — never delete]" : ""}`).join(", ") || "(none)"}`);
  console.log("Decide via the Masters screen (Deactivate, or Rename if you want different real categories) — this script won't touch these.\n");
}

await cleanupAssets();
await cleanupCenters();
await reportAmbiguousMasters();
process.exit(0);
