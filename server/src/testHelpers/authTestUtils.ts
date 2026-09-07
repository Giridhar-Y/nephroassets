import type { FastifyInstance, InjectOptions } from "fastify";
import { getPool } from "../db/pool.js";
import { SESSION_COOKIE_NAME, signSession } from "../auth/session.js";
import { hashPassword } from "../auth/password.js";
import type { Role } from "../auth/middleware.js";
import { seedBuiltInRoles, seedPermissionsFromRole } from "../auth/permissions.js";
import { replaceUserCenterAccess, resolveCenters } from "../auth/centerScope.js";

const TEST_ADMIN_USERNAME = "test-harness-admin";
const TEST_ADMIN_ID_PLACEHOLDER = -1; // overwritten by ensureTestAdminUser's real id

let cachedAuthHeader: string | null = null;

/** Upserts a single fixed admin user in the test database and returns a `Cookie` header
 *  value for it, cached for the process's lifetime — every pre-existing FAR-module test
 *  file (none of which are testing auth itself) uses this via `authedInject` below so
 *  they keep passing under the global auth gate without each one needing its own
 *  understanding of login. Auth-specific tests (auth.test.ts, adminUsers.test.ts)
 *  exercise the real login flow directly instead of using this shortcut. */
export async function getSharedAuthHeader(): Promise<string> {
  if (cachedAuthHeader) return cachedAuthHeader;
  const db = await getPool();
  // The test database bootstraps from schema.sql alone (see db/testPostgres.ts) — it
  // never goes through pool.ts's applySchema()/seedBuiltInRoles() migration path, so
  // Viewer/Editor/Admin's rows+templates wouldn't otherwise exist here at all. Cheap
  // and idempotent (see seedBuiltInRoles's own comment) — safe to call on every test
  // file's first use of this shared helper.
  await seedBuiltInRoles(db);
  const passwordHash = await hashPassword("test-harness-password-unused");
  // id is BIGSERIAL — comes back as a string, not a number (see auth/middleware.ts).
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (username, email, password_hash, role, must_change_password)
     VALUES ($1, $2, $3, 'admin', FALSE)
     ON CONFLICT (LOWER(username)) DO UPDATE SET status = 'active', role = 'admin', must_change_password = FALSE
     RETURNING id`,
    [TEST_ADMIN_USERNAME, "test-harness@example.invalid", passwordHash]
  );
  const id = rows[0] ? Number(rows[0].id) : TEST_ADMIN_ID_PLACEHOLDER;
  // Enforcement reads user_permissions, not `role` — every existing test file built
  // around "this cookie is a full admin" needs this row seeded once. ON CONFLICT DO
  // NOTHING inside seedPermissionsFromRole makes re-running this across every test file
  // that calls getSharedAuthHeader() (the row itself persists for the whole suite run,
  // see vitest.config.ts's fileParallelism:false) a safe no-op after the first.
  await seedPermissionsFromRole(db, id, "admin", null);
  const token = signSession({ sub: id, username: TEST_ADMIN_USERNAME });
  cachedAuthHeader = `${SESSION_COOKIE_NAME}=${token}`;
  return cachedAuthHeader;
}

/** Drop-in replacement for `app.inject(...)` that attaches the shared test admin's
 *  session cookie, so every existing FAR-module route test keeps working under the
 *  global auth gate without individually knowing how to log in. Merges rather than
 *  overwrites `headers`, so a test can still override/add its own if it needs to. */
export async function authedInject(app: FastifyInstance, opts: InjectOptions) {
  const cookie = await getSharedAuthHeader();
  return app.inject({ ...opts, headers: { cookie, ...opts.headers } });
}

/** For tests that need to assert the *unauthenticated* response (401) or want a session
 *  cookie for a specific, non-shared user — builds one without touching the DB. */
export function authHeaderFor(userId: number, username: string): string {
  return `${SESSION_COOKIE_NAME}=${signSession({ sub: userId, username })}`;
}

/** Inserts a real user row for auth/admin tests that need one with specific properties
 *  (a plain non-admin user, a disabled one, etc.) rather than the shared fixture admin
 *  above. */
export async function createTestUser(overrides: {
  username: string;
  email?: string;
  password?: string;
  role?: Role;
  status?: "active" | "disabled";
  mustChangePassword?: boolean;
  /** Center-scoped access (Center Manager/Cluster Manager tests) — center codes that
   *  must already exist in the `centers` table (the caller's own beforeAll/beforeEach
   *  seeds those, same as it already must for any other center-referencing fixture).
   *  Omitted or empty means unscoped, same as every user gets by default. */
  centerAccess?: string[];
}): Promise<{ id: number; username: string; password: string }> {
  const db = await getPool();
  // Same reasoning as getSharedAuthHeader's own call — a test file that only ever calls
  // createTestUser (never getSharedAuthHeader) still needs Viewer/Editor/Admin to exist.
  await seedBuiltInRoles(db);
  const password = overrides.password ?? "correct-horse-battery-staple";
  const passwordHash = await hashPassword(password);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (username, email, password_hash, role, status, must_change_password)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      overrides.username,
      overrides.email ?? `${overrides.username}@example.invalid`,
      passwordHash,
      overrides.role ?? "editor",
      overrides.status ?? "active",
      overrides.mustChangePassword ?? false
    ]
  );
  const id = Number(rows[0]!.id);
  // Same reasoning as getSharedAuthHeader above — enforcement reads user_permissions,
  // not this row's `role` column, so a test creating "an editor" or "a viewer" needs
  // that role's template actually seeded to behave like one.
  await seedPermissionsFromRole(db, id, overrides.role ?? "editor", null);
  if (overrides.centerAccess && overrides.centerAccess.length > 0) {
    const { resolved, unknown } = await resolveCenters(db, overrides.centerAccess);
    if (unknown.length > 0) {
      throw new Error(`createTestUser: unrecognized center(s) ${unknown.join(", ")} — seed them before granting access.`);
    }
    await replaceUserCenterAccess(db, id, id, resolved);
  }
  return { id, username: overrides.username, password };
}
