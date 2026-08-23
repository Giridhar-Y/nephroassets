import type { FastifyReply, FastifyRequest } from "fastify";
import { getPool } from "../db/pool.js";
import { SESSION_COOKIE_NAME, verifySession } from "./session.js";

export interface AuthedUser {
  id: number;
  username: string;
  email: string;
  isAdmin: boolean;
  mustChangePassword: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    user: AuthedUser | null;
  }
}

/** Paths the global auth gate (registered in app.ts) never blocks:
 *  - "/api/health" — an uptime/monitoring endpoint has to be reachable without a
 *    session, that's the entire point of one.
 *  - "/api/auth/login" — nothing to check a session against yet.
 *  - "/api/auth/logout" — must stay reachable *without* a valid session too, not just
 *    with one: someone whose cookie already expired, was cleared, or was disabled by an
 *    admin should still be able to hit "Sign Out" and land cleanly on the login page,
 *    not get a 401 error from the button that's supposed to get them out. The handler
 *    itself needs no session (it just clears a cookie), so making it fully public is
 *    safe — there's nothing here for an unauthenticated caller to learn or change.
 *  Everything else under /api requires a valid session; ALLOWED_WHILE_MUST_CHANGE_PASSWORD
 *  (below) further restricts what a not-yet-changed-password session can reach. */
const PUBLIC_PATHS = new Set(["/api/health", "/api/auth/login", "/api/auth/logout"]);

/** Endpoints a `mustChangePassword` session may still reach — just enough to change the
 *  password and to check who they are (/me). /logout doesn't need to be listed here too
 *  — it's in PUBLIC_PATHS above, reachable regardless of mustChangePassword. Every other
 *  /api route 403s until the password is changed, so a temporary password can't be used
 *  to browse real data first. */
const ALLOWED_WHILE_MUST_CHANGE_PASSWORD = new Set(["/api/auth/me", "/api/auth/change-password"]);

/** Resolves the session cookie into a live user row (fresh DB read, not just trusting
 *  the JWT's claims) — so a disabled/deleted user or a role change takes effect on their
 *  very next request, not whenever their token happens to expire. Returns null for any
 *  failure mode (no cookie, invalid/expired token, user no longer exists or disabled) —
 *  callers don't need to distinguish why, just that there's no valid session. */
export async function resolveUser(req: FastifyRequest): Promise<AuthedUser | null> {
  const token = req.cookies[SESSION_COOKIE_NAME];
  if (!token) return null;
  const payload = verifySession(token);
  if (!payload) return null;

  const db = await getPool();
  // id comes back as BIGSERIAL/BIGINT, which node-postgres returns as a *string* (to
  // avoid precision loss past Number.MAX_SAFE_INTEGER) — Number(...) it explicitly, or
  // every downstream `=== ` comparison against a real number (idParamSchema's
  // z.coerce.number(), the JWT's numeric `sub` claim) silently fails.
  const { rows } = await db.query<{
    id: string;
    username: string;
    email: string;
    is_admin: boolean;
    status: string;
    must_change_password: boolean;
  }>(`SELECT id, username, email, is_admin, status, must_change_password FROM users WHERE id = $1`, [payload.sub]);
  const row = rows[0];
  if (!row || row.status !== "active") return null;

  return {
    id: Number(row.id),
    username: row.username,
    email: row.email,
    isAdmin: row.is_admin,
    mustChangePassword: row.must_change_password
  };
}

/** Registered once, globally, in app.ts — not per-route. Every /api/* request needs a
 *  valid session except the small PUBLIC_PATHS allowlist; a mustChangePassword session
 *  is further restricted to ALLOWED_WHILE_MUST_CHANGE_PASSWORD. Static file serving
 *  (the built client) is untouched — it lives outside /api entirely. */
export async function authGateHook(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.url.startsWith("/api/")) return;
  const path = req.url.split("?")[0]!;
  if (PUBLIC_PATHS.has(path)) return;

  const user = await resolveUser(req);
  if (!user) {
    reply.code(401).send({ error: "Not signed in.", code: "UNAUTHENTICATED" });
    return;
  }
  req.user = user;

  if (user.mustChangePassword && !ALLOWED_WHILE_MUST_CHANGE_PASSWORD.has(path)) {
    reply.code(403).send({ error: "You must set a new password before continuing.", code: "MUST_CHANGE_PASSWORD" });
  }
}

/** Route-level preHandler for admin-only endpoints — layered on top of the global auth
 *  gate above, which has already populated `req.user` by the time this runs. */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.user?.isAdmin) {
    reply.code(403).send({ error: "Admin access required.", code: "FORBIDDEN" });
  }
}
