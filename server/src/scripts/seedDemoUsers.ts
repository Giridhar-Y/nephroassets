import { randomBytes } from "node:crypto";
import { applySchema, getPool } from "../db/pool.js";
import { hashPassword } from "../auth/password.js";

// Seeds a demo viewer and a demo editor account, alongside the existing admin account
// (seedAdmin.ts) — for showing a client the three role tiers. Passwords are generated
// fresh on every run and printed once to stdout, never hardcoded here: a checked-in
// password in a seed script sits in git history forever and never rotates. Idempotent:
// safe to re-run, upserts by username and issues a *new* temp password each time (each
// account is left with must_change_password = TRUE, same as any admin-created user).
//
// Usage (from the server/ directory): npx tsx src/scripts/seedDemoUsers.ts
// Point DATABASE_URL at the target database first if it's not the local dev instance.

function generateTempPassword(): string {
  return randomBytes(12).toString("base64url");
}

await applySchema();
const db = await getPool();

const demoUsers = [
  { username: "demo-viewer", email: "demo-viewer@example.com", role: "viewer" },
  { username: "demo-editor", email: "demo-editor@example.com", role: "editor" }
] as const;

for (const u of demoUsers) {
  const password = generateTempPassword();
  const passwordHash = await hashPassword(password);
  await db.query(
    `INSERT INTO users (username, email, password_hash, role, must_change_password)
     VALUES ($1, $2, $3, $4, TRUE)
     ON CONFLICT (LOWER(username))
     DO UPDATE SET email = $2, password_hash = $3, role = $4, status = 'active', must_change_password = TRUE`,
    [u.username, u.email, passwordHash, u.role]
  );
  console.log(`${u.role.padEnd(6)} — username: ${u.username}   temp password: ${password}`);
}

process.exit(0);
