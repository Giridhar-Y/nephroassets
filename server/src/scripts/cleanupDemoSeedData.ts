import { getPool } from "../db/pool.js";

// Removes the synthetic demo assets db/seed.ts's seed() generates when SEED_ON_BOOT
// isn't explicitly "false" — see that file for how they're created. There's no explicit
// is_demo/source column (seed() does a plain INSERT, same shape as a real one), so this
// identifies them the only reliable way available: far_id matching seed()'s own
// generation pattern exactly (`FAR-######`, zero-padded, sequential from 1), the same
// pattern that already has a dedicated index (idx_assets_farid_pattern in schema.sql)
// for fast prefix matching.
//
// That pattern is a strong signal, not a database-level guarantee — a real asset COULD
// coincidentally have a FAR ID in this exact shape (FAR ID format restrictions were
// deliberately removed, see far_id_format_restriction_removed), so this additionally
// excludes — never deletes — any matching row that shows ANY sign of having been
// touched through the real app since seeding: an activity/delete-audit log entry, a
// bulk-action log mention, a soft-delete, or a parent/child relationship. seed() never
// creates any of those for the rows it inserts (it writes directly to assets/transfers,
// bypassing every route that would create one), so their presence is exactly the signal
// that a real user interacted with that row after it was seeded — a rule the count
// check below could never articulate as clearly as this said in code, so keep it here
// rather than "let the operator eyeball it."
//
// Dry-run by default — reports exactly what would be deleted and why any row was
// excluded, but touches nothing. Requires CONFIRM=yes to actually delete. Idempotent:
// re-running after a real cleanup (or against a database that was never seeded) finds
// zero matching rows and exits cleanly either way.
//
// Usage:
//   npx tsx src/scripts/cleanupDemoSeedData.ts                # dry run (default)
//   CONFIRM=yes npx tsx src/scripts/cleanupDemoSeedData.ts     # actually deletes

const DEMO_FAR_ID_PATTERN = "^FAR-[0-9]{6}$";

const db = await getPool();

const { rows: candidateRows } = await db.query<{ far_id: string }>(
  `SELECT far_id FROM assets WHERE far_id ~ $1 ORDER BY far_id`,
  [DEMO_FAR_ID_PATTERN]
);

if (candidateRows.length === 0) {
  console.log("No demo-pattern assets found (far_id matching FAR-######) — nothing to do.");
  process.exit(0);
}

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

if (process.env.CONFIRM !== "yes") {
  console.log("\nDry run only — nothing deleted. Re-run with CONFIRM=yes to actually delete the rows listed above.");
  process.exit(0);
}

if (safeToDelete.length === 0) {
  console.log("\nNothing safe to delete (everything matching was excluded above) — exiting.");
  process.exit(0);
}

const client = await db.connect();
try {
  await client.query("BEGIN");
  // transfers.far_id has no ON DELETE CASCADE (see schema.sql) — must go first, or the
  // assets DELETE fails on any row with transfer history.
  await client.query(`DELETE FROM transfers WHERE far_id = ANY($1)`, [safeToDelete]);
  const { rowCount } = await client.query(`DELETE FROM assets WHERE far_id = ANY($1)`, [safeToDelete]);
  await client.query("COMMIT");
  console.log(`\nDeleted ${rowCount} assets and their transfer history.`);
} catch (err) {
  await client.query("ROLLBACK");
  throw err;
} finally {
  client.release();
}
process.exit(0);
