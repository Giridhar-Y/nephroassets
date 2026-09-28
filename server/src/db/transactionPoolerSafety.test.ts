import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// On Vercel, DATABASE_URL goes through Supabase's pooler. In transaction mode (port 6543)
// each transaction may run on a different backend connection, so anything that lives on
// a *session* silently breaks: session advisory locks, session SETs, LISTEN/NOTIFY, temp
// tables, cursors, named prepared statements. The app uses none of these (the schema
// and approval-config locks are pg_advisory_xact_lock inside a transaction; the job
// "locks" are row leases), which also keeps it correct on Docker's direct Postgres.
// This guard fails if one is ever added. Comments are stripped before matching. A
// statement that *starts* with SET is a session SET (only an opening quote, ";" or the
// file start count as a statement start), unlike an UPDATE's "SET col = ..." line.

const SRC = path.resolve(import.meta.dirname, "..");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return /\.(ts|sql)$/.test(name) && !/\.test\.ts$|\.loadtest\.ts$/.test(name) ? [full] : [];
  });
}

function stripComments(text: string, sql: boolean): string {
  return sql ? text.replace(/--.*$/gm, "") : text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const FORBIDDEN: Array<[string, RegExp]> = [
  ["session-level advisory lock (use pg_advisory_xact_lock inside a transaction)", /pg_(try_)?advisory_lock(_shared)?\s*\(|pg_advisory_unlock/i],
  ["session SET (use SET LOCAL inside a transaction)", /(?:^|[`"';])\s*SET\s+(SESSION\s+)?(?!LOCAL\b|TRANSACTION\b|CONSTRAINTS\b)[a-z_.]+\s*(=|TO\b)/i],
  ["set_config(..., false), which is session-scoped", /set_config\s*\([^)]*,\s*false\s*\)/i],
  ["LISTEN/NOTIFY", /\b(UN)?LISTEN\s+\w|pg_notify\s*\(|(?:^|[`"';])\s*NOTIFY\s+\w/i],
  ["temporary table", /CREATE\s+(GLOBAL\s+|LOCAL\s+)?TEMP(ORARY)?\s+TABLE/i],
  ["SQL cursor", /DECLARE\s+\w+\s+(BINARY\s+)?(ASENSITIVE\s+|INSENSITIVE\s+)?(NO\s+)?(SCROLL\s+)?CURSOR/i],
  ["named prepared statement", /\.query\s*(<[^>]*>)?\s*\(\s*\{[^}]*\bname\s*:|\bPREPARE\s+\w+\s*(\(|AS)/i],
  ["pg-cursor / pg-query-stream", /from\s+["']pg-(cursor|query-stream)["']/]
];

describe("works through a transaction-mode pooler", () => {
  const sources = files(SRC).map((f) => ({ file: path.relative(SRC, f), text: stripComments(readFileSync(f, "utf-8"), f.endsWith(".sql")) }));

  it("scans the server source", () => {
    expect(sources.length).toBeGreaterThan(50);
    expect(sources.some((s) => s.file.endsWith("pool.ts"))).toBe(true);
  });

  it.each(FORBIDDEN)("no %s", (_label, pattern) => {
    expect(sources.filter((s) => pattern.test(s.text)).map((s) => s.file)).toEqual([]);
  });

  it("the patterns catch what they're for, and allow the transaction-safe forms", () => {
    const samples: Array<[number, string]> = [
      [0, "SELECT pg_advisory_lock(1)"],
      [0, "SELECT pg_try_advisory_lock(1)"],
      [1, 'await c.query("SET statement_timeout = 0")'],
      [1, "BEGIN; SET search_path TO x"],
      [2, "SELECT set_config('x', '1', false)"],
      [3, "LISTEN jobs"],
      [4, "CREATE TEMP TABLE t (id int)"],
      [5, "DECLARE c CURSOR FOR SELECT 1"],
      [6, 'db.query({ name: "q1", text: "SELECT 1" })'],
      [7, 'import Cursor from "pg-cursor"']
    ];
    for (const [i, sample] of samples) expect(FORBIDDEN[i]![1].test(sample), sample).toBe(true);
    const allowed = [
      'await client.query("SET LOCAL statement_timeout = 0")',
      "SELECT pg_advisory_xact_lock($1)",
      "UPDATE t SET a = 1 WHERE id = $1",
      "`UPDATE t\n     SET a = 1 WHERE id = $1`"
    ];
    for (const ok of allowed) expect(FORBIDDEN.some(([, p]) => p.test(ok)), ok).toBe(false);
  });
});
