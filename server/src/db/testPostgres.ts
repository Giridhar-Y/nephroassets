import path from "node:path";
import { readFileSync } from "node:fs";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";

// Dedicated Postgres instance for the test suite: different port and data directory
// than the dev server's (server/src/db/devPostgres.ts), so `npm test` works whether or
// not `npm run dev` happens to be running at the same time. Ephemeral (persistent:
// false) so every test run starts from a clean, freshly-migrated database.
const DATA_DIR = path.resolve(import.meta.dirname, "../../.pgdata-test");
const PORT = 55433;
const USER = "postgres";
const PASSWORD = "postgres";
const DB_NAME = "nephroassets_test";

export const TEST_DATABASE_URL = `postgres://${USER}:${PASSWORD}@localhost:${PORT}/${DB_NAME}`;

let instance: EmbeddedPostgres | undefined;

export async function startTestPostgres(): Promise<void> {
  instance = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    port: PORT,
    user: USER,
    password: PASSWORD,
    persistent: false
  });
  await instance.initialise();
  await instance.start();
  await instance.createDatabase(DB_NAME);

  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  const sql = readFileSync(path.resolve(import.meta.dirname, "schema.sql"), "utf-8");
  await pool.query(sql);
  // far_component_result / far_calc_component live in their own file, applied separately
  // from the rest of schema.sql — see calcFunction.sql's header comment and pool.ts's
  // applySchema() for why. This test bootstrap doesn't go through applySchema(), so it
  // needs the same two-file sequence explicitly.
  const calcSql = readFileSync(path.resolve(import.meta.dirname, "calcFunction.sql"), "utf-8");
  await pool.query(calcSql);
  await pool.end();
}

export async function stopTestPostgres(): Promise<void> {
  await instance?.stop();
}
