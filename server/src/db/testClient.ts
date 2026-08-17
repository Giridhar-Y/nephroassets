import pg from "pg";
import { TEST_DATABASE_URL } from "./testPostgres.js";

pg.types.setTypeParser(1082, (value: string) => value);

let pool: pg.Pool | undefined;

/** A plain client connection to the test Postgres instance started by
 *  testGlobalSetup.ts. Does not start or manage the server itself. */
export function getTestPool(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: TEST_DATABASE_URL });
  return pool;
}
