import type { FastifyInstance, InjectOptions } from "fastify";
import { getPool } from "../db/pool.js";
import { SESSION_COOKIE_NAME, signSession } from "../auth/session.js";
import { hashPassword } from "../auth/password.js";

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
  const passwordHash = await hashPassword("test-harness-password-unused");
  // id is BIGSERIAL — comes back as a string, not a number (see auth/middleware.ts).
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (username, email, password_hash, is_admin, must_change_password)
     VALUES ($1, $2, $3, TRUE, FALSE)
     ON CONFLICT (LOWER(username)) DO UPDATE SET status = 'active', is_admin = TRUE, must_change_password = FALSE
     RETURNING id`,
    [TEST_ADMIN_USERNAME, "test-harness@example.invalid", passwordHash]
  );
  const id = rows[0] ? Number(rows[0].id) : TEST_ADMIN_ID_PLACEHOLDER;
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
  isAdmin?: boolean;
  status?: "active" | "disabled";
  mustChangePassword?: boolean;
}): Promise<{ id: number; username: string; password: string }> {
  const db = await getPool();
  const password = overrides.password ?? "correct-horse-battery-staple";
  const passwordHash = await hashPassword(password);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (username, email, password_hash, is_admin, status, must_change_password)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      overrides.username,
      overrides.email ?? `${overrides.username}@example.invalid`,
      passwordHash,
      overrides.isAdmin ?? false,
      overrides.status ?? "active",
      overrides.mustChangePassword ?? false
    ]
  );
  return { id: Number(rows[0]!.id), username: overrides.username, password };
}
