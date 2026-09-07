import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import authRoutes from "./auth.js";
import assetsRoutes from "./assets.js";
import { getPool } from "../db/pool.js";
import { authGateHook } from "../auth/middleware.js";
import { createTestUser } from "../testHelpers/authTestUtils.js";
import { MAX_FAILED_ATTEMPTS, MAX_FAILED_ATTEMPTS_PER_IP } from "../auth/rateLimit.js";

function extractCookie(res: { cookies: Array<{ name: string; value: string }> }): string | undefined {
  const c = res.cookies.find((c) => c.name === "session");
  return c ? `session=${c.value}` : undefined;
}

describe("Auth: login/logout/me/change-password", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    app.decorateRequest("user", null);
    app.addHook("preHandler", authGateHook);
    await app.register(cookie);
    await app.register(authRoutes);
    await app.register(assetsRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const db = await getPool();
    await db.query(`DELETE FROM login_attempts`);
    await db.query(`DELETE FROM user_audit_log`);
    await db.query(`DELETE FROM users`);
  });

  it("logs in with correct credentials and sets a session cookie", async () => {
    await createTestUser({ username: "alice", password: "correct-password-123" });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "alice", password: "correct-password-123" }
    });
    expect(res.statusCode).toBe(200);
    expect(extractCookie(res)).toBeDefined();
    expect(res.json().user.username).toBe("alice");
  });

  it("rejects a wrong password with a generic message", async () => {
    await createTestUser({ username: "bob", password: "correct-password-123" });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "bob", password: "wrong-password" }
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("Invalid username or password.");
  });

  it("rejects a username that doesn't exist with the exact same message (no enumeration)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "no-such-user", password: "whatever" }
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("Invalid username or password.");
  });

  it("rejects login for a disabled user", async () => {
    await createTestUser({ username: "disabled-carl", password: "correct-password-123", status: "disabled" });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "disabled-carl", password: "correct-password-123" }
    });
    expect(res.statusCode).toBe(401);
  });

  it(`locks out after ${MAX_FAILED_ATTEMPTS} failed attempts, for a real username`, async () => {
    await createTestUser({ username: "dave", password: "correct-password-123" });
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "dave", password: "wrong" }
      });
      expect(res.statusCode).toBe(401);
    }
    // Even the *correct* password is now rejected — locked out, not just still guessing.
    const lockedOut = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "dave", password: "correct-password-123" }
    });
    expect(lockedOut.statusCode).toBe(429);
  });

  it(`locks out after ${MAX_FAILED_ATTEMPTS} failed attempts, for a username that doesn't exist (same behavior either way)`, async () => {
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "ghost-user", password: "whatever" }
      });
    }
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "ghost-user", password: "whatever" }
    });
    expect(res.statusCode).toBe(429);
  });

  it(`locks out an IP after ${MAX_FAILED_ATTEMPTS_PER_IP} failed attempts across many different usernames, even though no single username hit its own limit`, async () => {
    const attemptsPerUsername = 2; // stays well under MAX_FAILED_ATTEMPTS (5) per username
    const usernameCount = Math.ceil(MAX_FAILED_ATTEMPTS_PER_IP / attemptsPerUsername);
    for (let u = 0; u < usernameCount; u++) {
      for (let a = 0; a < attemptsPerUsername; a++) {
        const res = await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { username: `ip-probe-user-${u}`, password: "whatever" },
          remoteAddress: "203.0.113.7"
        });
        // Individually, every single one of these should just be a normal wrong-password
        // 401 — proving the eventual 429 comes from the IP total, not any one username
        // crossing its own (much lower) per-username threshold.
        expect(res.statusCode).toBe(401);
      }
    }

    const blocked = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "ip-probe-user-final", password: "whatever" },
      remoteAddress: "203.0.113.7"
    });
    expect(blocked.statusCode).toBe(429);

    // A different IP, same brand-new username, is unaffected — the block is scoped to
    // the offending IP, not global.
    const otherIp = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "ip-probe-user-final", password: "whatever" },
      remoteAddress: "198.51.100.42"
    });
    expect(otherIp.statusCode).toBe(401); // wrong password, not locked out
  });

  it("a successful login clears the prior failed-attempt count", async () => {
    await createTestUser({ username: "erin", password: "correct-password-123" });
    for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i++) {
      await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "erin", password: "wrong" } });
    }
    const success = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "erin", password: "correct-password-123" }
    });
    expect(success.statusCode).toBe(200);

    // Should NOT be locked out now — the prior failures were reset by the success above.
    const afterSuccess = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "erin", password: "wrong-again" }
    });
    expect(afterSuccess.statusCode).toBe(401); // not 429
  });

  it("GET /api/auth/me is 401 with no session", async () => {
    const res = await app.inject({ method: "GET", url: "/api/auth/me" });
    expect(res.statusCode).toBe(401);
  });

  it("GET /api/auth/me returns the signed-in user with a valid session", async () => {
    await createTestUser({ username: "frank", password: "correct-password-123" });
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "frank", password: "correct-password-123" }
    });
    const res = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: extractCookie(login) } });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.username).toBe("frank");
  });

  it("logout clears the session — a subsequent /me is 401 again", async () => {
    await createTestUser({ username: "grace", password: "correct-password-123" });
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "grace", password: "correct-password-123" }
    });
    const cookieHeader = extractCookie(login);
    await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie: cookieHeader } });

    // The client would drop the cleared cookie; simulate that by not resending it.
    const me = await app.inject({ method: "GET", url: "/api/auth/me" });
    expect(me.statusCode).toBe(401);
  });

  it("logout succeeds even with no session at all — an expired/cleared/never-had-one cookie doesn't 401 the Sign Out button", async () => {
    // Regression: /api/auth/logout must be in the global gate's public allowlist, not
    // just reachable *with* a valid session — otherwise anyone whose session already
    // expired (or was disabled by an admin) gets a 401 error from the button that's
    // supposed to get them cleanly to the login page.
    const noCookieAtAll = await app.inject({ method: "POST", url: "/api/auth/logout" });
    expect(noCookieAtAll.statusCode).toBe(200);

    const garbageCookie = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: "session=this-is-not-a-valid-jwt" }
    });
    expect(garbageCookie.statusCode).toBe(200);
  });

  it("every other /api route requires a session too — the global gate, not just auth's own routes", async () => {
    const res = await app.inject({ method: "GET", url: "/api/assets" });
    expect(res.statusCode).toBe(401);
  });

  it("a must-change-password session can reach /me and /change-password but nothing else, until it changes it", async () => {
    await createTestUser({ username: "temp-pw-henry", password: "temp-password-123", mustChangePassword: true });
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "temp-pw-henry", password: "temp-password-123" }
    });
    expect(login.json().user.mustChangePassword).toBe(true);
    const cookieHeader = extractCookie(login);

    const blocked = await app.inject({ method: "GET", url: "/api/assets", headers: { cookie: cookieHeader } });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().code).toBe("MUST_CHANGE_PASSWORD");

    const change = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: { cookie: cookieHeader },
      payload: { currentPassword: "temp-password-123", newPassword: "a-brand-new-password" }
    });
    expect(change.statusCode).toBe(200);

    // Same session cookie, now unblocked — must_change_password is read fresh from the
    // DB on every request, not baked into the token. (Not asserting 200 here: this test
    // app has no FY settings configured, so /api/assets legitimately 409s for that
    // unrelated reason — asserting the MUST_CHANGE_PASSWORD gate specifically cleared is
    // the precise check.)
    const unblocked = await app.inject({ method: "GET", url: "/api/assets", headers: { cookie: cookieHeader } });
    expect(unblocked.statusCode).not.toBe(403);
    expect(unblocked.json().code).not.toBe("MUST_CHANGE_PASSWORD");
  });

  it("change-password rejects the wrong current password", async () => {
    await createTestUser({ username: "ivan", password: "correct-password-123" });
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "ivan", password: "correct-password-123" }
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: { cookie: extractCookie(login) },
      payload: { currentPassword: "not-my-password", newPassword: "a-brand-new-password" }
    });
    expect(res.statusCode).toBe(401);
  });
});
