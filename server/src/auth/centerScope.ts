import type pg from "pg";
import type { AuthedUser } from "./middleware.js";

// Center-scoped access — a second, independent dimension on top of
// auth/permissions.ts's module/action grants, never a replacement for them (see
// schema.sql's user_center_access comment for the full reasoning). A user still needs
// the relevant permission (e.g. transfers:create) to reach a route at all —
// requirePermission (middleware.ts) is completely unchanged and is still the only
// boolean allow/deny gate. Everything in this file only narrows WHICH ROWS an
// already-permitted request can see or touch, applied inside each route handler once
// the specific asset(s)/center(s) involved are known — center scope can't be a
// preHandler the way requirePermission is, since it's per-row, not per-route.

/** One user's center scope, fresh from the database — shared by auth/middleware.ts's
 *  resolveUser (every authenticated request) and routes/auth.ts's login handler (which
 *  can't use resolveUser: it reads the session cookie off the incoming request, and a
 *  login request never carries the cookie the response is only just about to set).
 *  `null` (not an empty Set) when the user has zero `user_center_access` rows — see
 *  that table's own schema.sql comment for why "no rows" must mean unscoped rather
 *  than "scoped to nothing". */
export async function fetchCenterScope(db: Pick<pg.Pool | pg.PoolClient, "query">, userId: number): Promise<Set<string> | null> {
  const { rows } = await db.query<{ code: string }>(
    `SELECT c.code FROM user_center_access uca JOIN centers c ON c.id = uca.center_id WHERE uca.user_id = $1`,
    [userId]
  );
  return rows.length === 0 ? null : new Set(rows.map((r) => r.code));
}

/** True if `center` is within `user`'s scope — always true when unscoped
 *  (`centerScope === null`). Exact-string match: `centerScope` is populated from
 *  `centers.code` (auth/middleware.ts's resolveUser), the same canonical casing
 *  `assets.location`/`revised_location` already store, so no case-folding is needed
 *  here. */
export function isCenterInScope(user: Pick<AuthedUser, "centerScope">, center: string): boolean {
  return user.centerScope === null || user.centerScope.has(center);
}

/** The distinct centers in `centers` that fall outside `user`'s scope, in first-seen
 *  order — empty when unscoped. Used to build a single, complete rejection message
 *  (e.g. Transfers' batch check) rather than failing on just the first violation
 *  found. */
export function outOfScopeCenters(user: Pick<AuthedUser, "centerScope">, centers: Iterable<string>): string[] {
  if (user.centerScope === null) return [];
  const scope = user.centerScope;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const center of centers) {
    if (!scope.has(center) && !seen.has(center)) {
      seen.add(center);
      result.push(center);
    }
  }
  return result;
}

/** The Permissions panel's own read of one user's center access — a plain array
 *  (empty means unscoped) rather than the enforcement layer's `Set | null`, since the
 *  admin UI has no way to represent "scoped to literally zero centers" anyway (see
 *  MastersPage-style "empty selection = explicitly unscoped" convention) — there's
 *  nothing this endpoint needs the null/empty-Set distinction for. */
export async function fetchUserCenterAccess(db: Pick<pg.Pool | pg.PoolClient, "query">, userId: number): Promise<string[]> {
  const scope = await fetchCenterScope(db, userId);
  return scope === null ? [] : Array.from(scope).sort();
}

export interface ResolvedCenter {
  id: number;
  code: string;
}

/** Resolves a list of admin-submitted center codes against the FULL centers table
 *  (active or not — an already-assigned-but-since-deactivated center must still be
 *  revocable, and the Permissions panel always resubmits its complete current
 *  selection on Save, not just a diff, so rejecting a still-assigned inactive one here
 *  would silently drop it), case-insensitively, deduped, returning the master list's
 *  own canonical casing — same convention every other master-data reference in this
 *  app follows (bulkParse.ts's lookupCanonical). Unrecognized codes are reported
 *  separately rather than thrown here, so the caller (routes/adminUsers.ts) can phrase
 *  its own error the way every other "not recognized" message in this app already
 *  does. */
export async function resolveCenters(
  db: Pick<pg.Pool | pg.PoolClient, "query">,
  codes: string[]
): Promise<{ resolved: ResolvedCenter[]; unknown: string[] }> {
  if (codes.length === 0) return { resolved: [], unknown: [] };
  const { rows } = await db.query<{ id: string; code: string }>(`SELECT id, code FROM centers`);
  const byLowerCode = new Map(rows.map((r) => [r.code.toLowerCase(), { id: Number(r.id), code: r.code }]));

  const resolved: ResolvedCenter[] = [];
  const unknown: string[] = [];
  const seenIds = new Set<number>();
  for (const raw of codes) {
    const match = byLowerCode.get(raw.toLowerCase());
    if (!match) {
      unknown.push(raw);
      continue;
    }
    if (!seenIds.has(match.id)) {
      seenIds.add(match.id);
      resolved.push(match);
    }
  }
  return { resolved, unknown };
}

/** Replaces a user's entire center-access set in one transaction (delete-all +
 *  insert-all) — same replace-all contract as replaceUserPermissions
 *  (auth/permissions.ts), for the same reason: matches the Permissions panel's one
 *  Save of the full desired state, not incremental grant/revoke calls. Takes already-
 *  resolved centers (see resolveCenters above) — this function itself does no name
 *  validation, same split every other "replace" function in this codebase follows.
 *  Returns the added/removed diff for the caller's audit log entry. */
export async function replaceUserCenterAccess(
  db: pg.Pool,
  targetUserId: number,
  actorUserId: number,
  centers: ResolvedCenter[]
): Promise<{ added: string[]; removed: string[] }> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows: existingRows } = await client.query<{ code: string }>(
      `SELECT c.code FROM user_center_access uca JOIN centers c ON c.id = uca.center_id WHERE uca.user_id = $1`,
      [targetUserId]
    );
    const existingCodes = new Set(existingRows.map((r) => r.code));
    const incomingCodes = new Set(centers.map((c) => c.code));
    const added = centers.map((c) => c.code).filter((c) => !existingCodes.has(c));
    const removed = Array.from(existingCodes).filter((c) => !incomingCodes.has(c));

    await client.query(`DELETE FROM user_center_access WHERE user_id = $1`, [targetUserId]);
    for (const { id } of centers) {
      await client.query(`INSERT INTO user_center_access (user_id, center_id, granted_by) VALUES ($1, $2, $3)`, [
        targetUserId,
        id,
        actorUserId
      ]);
    }
    await client.query("COMMIT");
    return { added, removed };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** A SQL condition to AND into a listing query's WHERE clause — `null` when unscoped
 *  (no filter needed, matches every pre-existing user's behavior unchanged). Pushes
 *  the scope array onto `params` itself (same convention every other conditions-array
 *  builder in this codebase already follows — see assetColumnFilters.ts) and returns
 *  the placeholder expression to splice in; `columnExpr` is almost always
 *  `COALESCE(revised_location, location)` (an asset's *current* effective location —
 *  see routes/assets.ts's own `q.center` filter for the same expression), the one
 *  column every scoped listing/report/export/activity-log filters on. */
export function centerScopeSql(user: Pick<AuthedUser, "centerScope">, columnExpr: string, params: unknown[]): string | null {
  if (user.centerScope === null) return null;
  params.push(Array.from(user.centerScope));
  return `${columnExpr} = ANY($${params.length})`;
}
