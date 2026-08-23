import { applySchema, getPool } from "../db/pool.js";
import { hashPassword } from "../auth/password.js";

// Creates the first admin user. Deliberately takes credentials from environment
// variables rather than a CLI prompt with echo-off masking (not worth a dependency for
// a one-time setup step) or a hardcoded default (a real password should never live in
// source control or a chat transcript). Idempotent: safe to re-run, upserts by
// username.
//
// Usage (from the server/ directory):
//   ADMIN_USERNAME=... ADMIN_EMAIL=... ADMIN_PASSWORD=... npx tsx src/scripts/seedAdmin.ts
// Point DATABASE_URL at the target database first if it's not the local dev instance.

const username = process.env.ADMIN_USERNAME;
const email = process.env.ADMIN_EMAIL;
const password = process.env.ADMIN_PASSWORD;

if (!username || !email || !password) {
  console.error("ADMIN_USERNAME, ADMIN_EMAIL, and ADMIN_PASSWORD environment variables are all required.");
  console.error("Example: ADMIN_USERNAME=admin ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=... npx tsx src/scripts/seedAdmin.ts");
  process.exit(1);
}
if (password.length < 8) {
  console.error("ADMIN_PASSWORD must be at least 8 characters.");
  process.exit(1);
}

await applySchema();

const db = await getPool();
const passwordHash = await hashPassword(password);
const { rows } = await db.query(
  `INSERT INTO users (username, email, password_hash, is_admin, must_change_password)
   VALUES ($1, $2, $3, TRUE, FALSE)
   ON CONFLICT (LOWER(username)) DO UPDATE SET email = $2, password_hash = $3, is_admin = TRUE, status = 'active'
   RETURNING id, username, email`,
  [username, email, passwordHash]
);

console.log(`Admin user ready: ${rows[0].username} <${rows[0].email}> (id ${rows[0].id})`);
process.exit(0);
