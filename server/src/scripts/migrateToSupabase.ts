import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";

// One-off data migration: copies schema + all rows from one Postgres database to
// another over the network, using `pg` directly — no pg_dump/psql binary required,
// useful when the machine running this can't install them (e.g. no admin rights).
// Usage:
//   SOURCE_DATABASE_URL=... DEST_DATABASE_URL=... npx tsx src/scripts/migrateToSupabase.ts
// Run from the server/ directory so the relative schema.sql path below resolves.

pg.types.setTypeParser(1082, (value: string) => value); // dates as plain "YYYY-MM-DD", matching pool.ts

function makePool(url: string): pg.Pool {
  const isLocal = ["localhost", "127.0.0.1"].includes(new URL(url).hostname);
  return new pg.Pool({ connectionString: url, ssl: isLocal ? undefined : { rejectUnauthorized: false } });
}

/** Copies every row of `table` from source to dest, in batches, preserving column
 *  values as-is (works for any table shape — no hardcoded column list). */
async function copyTable(source: pg.Pool, dest: pg.Pool, table: string, batchSize = 500): Promise<number> {
  const { rows } = await source.query(`SELECT * FROM ${table}`);
  if (rows.length === 0) return 0;

  const columns = Object.keys(rows[0]);
  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    const params: unknown[] = [];
    const tuples = batch.map((row, rowIdx) => {
      const placeholders = columns.map((col, colIdx) => {
        params.push(row[col]);
        return `$${rowIdx * columns.length + colIdx + 1}`;
      });
      return `(${placeholders.join(",")})`;
    });
    await dest.query(
      `INSERT INTO ${table} (${columns.join(",")}) VALUES ${tuples.join(",")} ON CONFLICT DO NOTHING`,
      params
    );
    console.log(`  ${table}: ${Math.min(start + batchSize, rows.length)}/${rows.length}`);
  }
  return rows.length;
}

async function main() {
  const sourceUrl = process.env.SOURCE_DATABASE_URL;
  const destUrl = process.env.DEST_DATABASE_URL;
  if (!sourceUrl || !destUrl) {
    console.error("Set SOURCE_DATABASE_URL and DEST_DATABASE_URL environment variables first.");
    process.exit(1);
  }

  const source = makePool(sourceUrl);
  const dest = makePool(destUrl);

  console.log("Applying schema to destination...");
  const schemaSql = readFileSync(path.resolve(import.meta.dirname, "../db/schema.sql"), "utf-8");
  const { rows: existing } = await dest.query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'assets') AS exists`
  );
  if (!existing[0]?.exists) {
    await dest.query(schemaSql);
    console.log("  schema created.");
  } else {
    console.log("  schema already exists, skipping (tables will just get more rows inserted).");
  }
  // far_component_result / far_calc_component live in their own file and are applied
  // unconditionally, unlike the rest of schema.sql above — see calcFunction.sql's header
  // comment and pool.ts's applySchema() for why (this mirrors that same two-step
  // sequence for a one-off migration run).
  const calcSql = readFileSync(path.resolve(import.meta.dirname, "../db/calcFunction.sql"), "utf-8");
  await dest.query(calcSql);
  console.log("  calc function applied.");

  console.log("Copying settings...");
  await copyTable(source, dest, "settings");

  console.log("Copying assets...");
  const assetCount = await copyTable(source, dest, "assets");

  console.log("Copying transfers...");
  const transferCount = await copyTable(source, dest, "transfers");
  // transfers.id is a BIGSERIAL — explicit inserts don't advance the sequence, so the
  // next real insert would collide with a migrated id without this.
  await dest.query(`SELECT setval('transfers_id_seq', COALESCE((SELECT MAX(id) FROM transfers), 1))`);

  console.log(`\nDone: ${assetCount} assets, ${transferCount} transfers.`);
  await source.end();
  await dest.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
