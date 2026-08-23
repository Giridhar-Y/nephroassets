import jwt from "jsonwebtoken";
import type { CookieSerializeOptions } from "@fastify/cookie";

export const SESSION_COOKIE_NAME = "session";
const SESSION_LIFETIME_HOURS = 12;

// Required, no fallback, no NODE_ENV gating — a missing JWT_SECRET must fail loudly at
// import time (before any request can be handled, and before app.ts/index.ts finish
// building the app), not silently sign every session with a guessable default in
// whatever environment happens not to define it. This throws as soon as anything
// imports this module — see server/src/localDevSecret.ts for how local dev supplies one
// without touching this file, and vitest.config.ts's `env` block for tests. The
// production deploy (Vercel) must have JWT_SECRET set in its environment; this file
// intentionally does not — and must not — special-case that deployment to make it work
// without it.
const jwtSecretEnv = process.env.JWT_SECRET;
if (!jwtSecretEnv) {
  throw new Error(
    "JWT_SECRET environment variable is required and is not set — refusing to start. " +
      "Generate one (e.g. `openssl rand -base64 48`) and set it in the environment."
  );
}
// Re-bound with an explicit type so TS carries the non-undefined narrowing above into
// signSession/verifySession below — it doesn't narrow a module-level const across
// function-closure boundaries on its own.
const JWT_SECRET: string = jwtSecretEnv;

export interface SessionPayload {
  sub: number;
  username: string;
}

export function signSession(payload: SessionPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: `${SESSION_LIFETIME_HOURS}h` });
}

/** Returns null on any invalid/expired/tampered token rather than throwing — callers
 *  treat "couldn't verify" and "no token at all" identically (not authenticated). */
export function verifySession(token: string): SessionPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (typeof decoded === "string" || typeof decoded.sub !== "number" || typeof decoded.username !== "string") {
      return null;
    }
    return { sub: decoded.sub, username: decoded.username };
  } catch {
    return null;
  }
}

// secure:false in dev — the app is served over plain http://localhost there (both
// directly and through Vite's proxy), and a Secure cookie is silently dropped by the
// browser over http on anything but localhost's special-cased exemption, which isn't
// worth depending on. sameSite:"lax" is enough CSRF protection for a cookie that's never
// read by third-party-triggered top-level navigations to state-changing endpoints (this
// app has none — every mutation is a fetch from its own page, which "lax" still allows
// since it's same-site) — see the self-report for why this is an assumption to revisit
// if that ever changes, not a fully general CSRF defense.
export function sessionCookieOptions(): CookieSerializeOptions {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_LIFETIME_HOURS * 60 * 60
  };
}
