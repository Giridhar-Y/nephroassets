import { existsSync } from "node:fs";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";

// Local dev/test Postgres cluster, run as a plain user process (no service install,
// no admin rights required). Production should point DATABASE_URL at a real managed
// Postgres instance instead; this module is only used when DATABASE_URL is unset.
const DATA_DIR = path.resolve(import.meta.dirname, "../../.pgdata");
const PORT = 55432;
const USER = "postgres";
const PASSWORD = "postgres";
const DB_NAME = "nephroassets";

export const DEV_DATABASE_URL = `postgres://${USER}:${PASSWORD}@localhost:${PORT}/${DB_NAME}`;

let instance: EmbeddedPostgres | undefined;

export async function ensureDevPostgres(): Promise<string> {
  const alreadyInitialised = existsSync(DATA_DIR);

  instance = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    port: PORT,
    user: USER,
    password: PASSWORD,
    persistent: true
  });

  if (!alreadyInitialised) {
    await instance.initialise();
  }
  await instance.start();

  try {
    await instance.createDatabase(DB_NAME);
  } catch {
    // database already exists — fine, this is idempotent startup
  }

  return DEV_DATABASE_URL;
}

export async function stopDevPostgres(): Promise<void> {
  await instance?.stop();
}
