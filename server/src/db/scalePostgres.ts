import path from "node:path";
import { readFileSync } from "node:fs";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";

// A third, dedicated Postgres instance for the 2,50,000-row load test — separate port
// and data directory from both the dev server's (devPostgres.ts) and the fast unit-test
// suite's (testPostgres.ts), so this heavy, slow-to-seed run never collides with either.
const DATA_DIR = path.resolve(import.meta.dirname, "../../.pgdata-scale");
const PORT = 55434;
const USER = "postgres";
const PASSWORD = "postgres";
const DB_NAME = "nephroassets_scale";

export const SCALE_DATABASE_URL = `postgres://${USER}:${PASSWORD}@localhost:${PORT}/${DB_NAME}`;

let instance: EmbeddedPostgres | undefined;

export async function startScalePostgres(): Promise<void> {
  instance = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    port: PORT,
    user: USER,
    password: PASSWORD,
    persistent: false,
    // Larger shared_buffers than the default dev/test instances — this run aggregates
    // across 2,50,000+ rows and benefits from more page cache.
    postgresFlags: ["-c", "shared_buffers=512MB"]
  });
  await instance.initialise();
  await instance.start();
  await instance.createDatabase(DB_NAME);

  const pool = new pg.Pool({ connectionString: SCALE_DATABASE_URL });
  const sql = readFileSync(path.resolve(import.meta.dirname, "schema.sql"), "utf-8");
  await pool.query(sql);
  // far_component_result / far_calc_component live in their own file — see
  // calcFunction.sql's header comment and pool.ts's applySchema() for why.
  const calcSql = readFileSync(path.resolve(import.meta.dirname, "calcFunction.sql"), "utf-8");
  await pool.query(calcSql);
  await pool.end();
}

export async function stopScalePostgres(): Promise<void> {
  await instance?.stop();
}
