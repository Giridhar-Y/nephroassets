import bcrypt from "bcryptjs";

// Cost factor 12 — 2024-era guidance for bcrypt on commodity hardware (OWASP's password
// storage cheat sheet recommends >=10, with 12 as a common "comfortable margin" default).
// Note bcryptjs is pure JS (no native bindings, deliberately — avoids native-module build
// issues in this Windows dev environment and on Vercel's serverless build), so it's
// slower than native bcrypt at the same cost factor; ~150-300ms/hash is the tradeoff for
// that portability.
const BCRYPT_COST = 12;

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
