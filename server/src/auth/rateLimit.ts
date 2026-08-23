import type pg from "pg";

// Deliberately generous enough not to lock out a real user who mistypes their password a
// couple of times, tight enough to make credential-stuffing slow and noisy.
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_WINDOW_MINUTES = 15;

// Separate, higher threshold: this catches a different pattern than the per-username
// limit above — one source trying many *different* usernames (enumeration/credential
// stuffing) rather than many passwords against one account. Set well above
// MAX_FAILED_ATTEMPTS because IP is a much coarser signal (NAT, a shared office network,
// a mobile carrier's CGNAT can all put many unrelated real users behind one address) —
// this threshold trades a slower reaction to distributed guessing for not locking out a
// whole office over one person's typos.
export const MAX_FAILED_ATTEMPTS_PER_IP = 20;

/** Keyed by the *submitted* username, not a users.id — see the comment on
 *  login_attempts in schema.sql for why (identical lockout behavior whether or not the
 *  account is real, so lockout state itself can't be used to enumerate usernames). */
export async function isLockedOut(db: pg.Pool, username: string): Promise<boolean> {
  const { rows } = await db.query<{ count: string }>(
    `SELECT COUNT(*) FROM login_attempts
     WHERE LOWER(username) = LOWER($1)
       AND success = FALSE
       AND attempted_at > now() - ($2 || ' minutes')::interval`,
    [username, LOCKOUT_WINDOW_MINUTES]
  );
  return Number(rows[0]!.count) >= MAX_FAILED_ATTEMPTS;
}

/** Failed attempts from one source IP against *any* username, not just one — the per-
 *  username check above can't see this pattern since it only ever looks at one account
 *  at a time. `ip` is whatever Fastify's `req.ip` resolved to; undefined (couldn't be
 *  determined) never locks anyone out — there's nothing to key on. */
export async function isIpLockedOut(db: pg.Pool, ip: string | undefined): Promise<boolean> {
  if (!ip) return false;
  const { rows } = await db.query<{ count: string }>(
    `SELECT COUNT(*) FROM login_attempts
     WHERE ip = $1
       AND success = FALSE
       AND attempted_at > now() - ($2 || ' minutes')::interval`,
    [ip, LOCKOUT_WINDOW_MINUTES]
  );
  return Number(rows[0]!.count) >= MAX_FAILED_ATTEMPTS_PER_IP;
}

export async function recordLoginAttempt(
  db: pg.Pool,
  username: string,
  ip: string | undefined,
  success: boolean
): Promise<void> {
  await db.query(`INSERT INTO login_attempts (username, ip, success) VALUES ($1, $2, $3)`, [
    username,
    ip ?? null,
    success
  ]);
  // A successful login means the account is genuinely in this person's control — the
  // failed attempts before it (typos, an old saved password) shouldn't keep counting
  // against them going forward.
  if (success) {
    await db.query(`DELETE FROM login_attempts WHERE LOWER(username) = LOWER($1) AND success = FALSE`, [username]);
  }
}
