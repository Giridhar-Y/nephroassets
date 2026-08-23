// Imported ONLY by index.ts (the local/dev entry — never by api/index.ts, the Vercel
// serverless entry) as its very first import, so this runs before anything else,
// including auth/session.ts, which requires JWT_SECRET unconditionally and throws if
// it's missing. That's deliberate: production must never fall back to a default, but
// local dev needs *something* set so `npm run dev` works without one-time setup, and it
// needs to be a *fixed* value — tsx watch restarts the server on every file save, and a
// freshly-random secret each restart would invalidate every open session cookie on
// every save, forcing a re-login after each edit while iterating.
//
// Side-effect-only import ordering matters here: ES module imports execute in
// declaration order, so this file's top-level code runs to completion before the next
// import statement in index.ts (app.js, which transitively imports session.ts) even
// begins evaluating. Do not reorder the imports in index.ts.
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = "local-dev-only-fixed-secret-never-used-in-any-real-deployment";
}
