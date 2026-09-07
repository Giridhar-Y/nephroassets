import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPool } from "../db/pool.js";
import { sessionCookieOptions, SESSION_COOKIE_NAME, signSession } from "../auth/session.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { isIpLockedOut, isLockedOut, LOCKOUT_WINDOW_MINUTES, recordLoginAttempt } from "../auth/rateLimit.js";
import type { Role } from "../auth/middleware.js";
import { fetchCenterScope } from "../auth/centerScope.js";

const loginSchema = z.object({ username: z.string().min(1), password: z.string().min(1) });
const changePasswordSchema = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(8) });

// Has no corresponding real user — bcrypt.compare against this pays the same hashing
// cost as a real lookup, so a nonexistent username doesn't respond measurably faster
// than a real one. Not a secret; it's never anyone's actual password hash.
const DUMMY_HASH_FOR_TIMING_PARITY = "$2b$12$94tdGxkaFLTLs59nGVCceOsMy.n3m9p5kZryMMlf792m968ePkV.m";

export default async function authRoutes(app: FastifyInstance) {
  app.post("/api/auth/login", async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Username and password are required." };
    }
    const { username, password } = parsed.data;
    const db = await getPool();

    // Same response either way — which limit tripped isn't something the caller needs
    // (or should be able to distinguish) from the outside.
    if ((await isLockedOut(db, username)) || (await isIpLockedOut(db, req.ip))) {
      reply.code(429);
      return { error: `Too many failed attempts. Try again in ${LOCKOUT_WINDOW_MINUTES} minutes.` };
    }

    // id is BIGSERIAL — node-postgres returns it as a string, not a number (see the
    // matching comment in auth/middleware.ts's resolveUser).
    const { rows } = await db.query<{
      id: string;
      username: string;
      email: string;
      password_hash: string;
      role: Role;
      must_change_password: boolean;
      status: string;
    }>(
      `SELECT id, username, email, password_hash, role, must_change_password, status FROM users WHERE LOWER(username) = LOWER($1)`,
      [username]
    );
    const row = rows[0];

    // Same bcrypt.compare cost whether or not the account exists, against a fixed dummy
    // hash — otherwise a real account (which pays the hash-compare cost) responds
    // measurably slower than a fake one (which returns immediately), a timing side
    // channel that would let an attacker enumerate valid usernames.
    const passwordOk = row
      ? await verifyPassword(password, row.password_hash)
      : await verifyPassword(password, DUMMY_HASH_FOR_TIMING_PARITY);
    const ok = Boolean(row) && row!.status === "active" && passwordOk;

    await recordLoginAttempt(db, username, req.ip, ok);

    if (!ok) {
      reply.code(401);
      return { error: "Invalid username or password." };
    }

    await db.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [row!.id]);
    const token = signSession({ sub: Number(row!.id), username: row!.username });
    reply.setCookie(SESSION_COOKIE_NAME, token, sessionCookieOptions());

    // Built directly from the row just read, not via resolveUser(req) — that reads the
    // session cookie off the *incoming* request, which is this login request itself and
    // so never carries the cookie we just decided to set on the way out.
    const { rows: permRows } = await db.query<{ module: string; action: string }>(
      `SELECT module, action FROM user_permissions WHERE user_id = $1`,
      [row!.id]
    );
    const centerScope = await fetchCenterScope(db, Number(row!.id));
    return {
      user: {
        id: Number(row!.id),
        username: row!.username,
        email: row!.email,
        role: row!.role,
        mustChangePassword: row!.must_change_password,
        permissions: permRows.map((p) => `${p.module}:${p.action}`),
        centerAccess: centerScope === null ? null : Array.from(centerScope)
      }
    };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
    return { ok: true };
  });

  // Also serves as the client's "am I signed in" check on load — the global auth gate
  // (app.ts) already 401s this route itself when there's no valid session, so reaching
  // the handler at all means req.user is populated.
  app.get("/api/auth/me", async (req) => {
    // req.user.permissions is a Set — JSON.stringify on a Set serializes to "{}", not an
    // array, so it has to be spread out explicitly here rather than returned as-is.
    // centerScope is already either null or a Set; Array.from(null) would throw, so it's
    // only converted when non-null (naming it centerAccess on the wire — "scope" is the
    // server-internal enforcement concept, "access" is what this actually grants).
    const { centerScope, ...user } = req.user!;
    return { user: { ...user, permissions: Array.from(req.user!.permissions), centerAccess: centerScope === null ? null : Array.from(centerScope) } };
  });

  app.post("/api/auth/change-password", async (req, reply) => {
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "New password must be at least 8 characters." };
    }
    const db = await getPool();
    const { rows } = await db.query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [
      req.user!.id
    ]);
    const currentOk = await verifyPassword(parsed.data.currentPassword, rows[0]!.password_hash);
    if (!currentOk) {
      reply.code(401);
      return { error: "Current password is incorrect." };
    }
    const newHash = await hashPassword(parsed.data.newPassword);
    await db.query(`UPDATE users SET password_hash = $1, must_change_password = FALSE WHERE id = $2`, [
      newHash,
      req.user!.id
    ]);
    return { ok: true };
  });
}
