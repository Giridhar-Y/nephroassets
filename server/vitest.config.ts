import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globalSetup: ["./src/testGlobalSetup.ts"],
    testTimeout: 20000,
    hookTimeout: 60000,
    // All test files share one ephemeral Postgres instance (testGlobalSetup.ts). Several
    // files manage shared singleton tables (e.g. `settings`) in their own beforeAll/
    // beforeEach — running files in parallel would let those interleave and race.
    fileParallelism: false,
    // Points db/pool.ts's getPool() at the test Postgres instance (testGlobalSetup.ts /
    // db/testPostgres.ts) instead of trying to boot its own dev instance.
    env: {
      DATABASE_URL: "postgres://postgres:postgres@localhost:55433/nephroassets_test"
    }
  }
});
