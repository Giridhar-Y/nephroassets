import { defineConfig } from "vitest/config";

// Separate from vitest.config.ts on purpose: seeding + querying 2,50,000 rows takes
// minutes, not milliseconds, and shouldn't slow down the routine `npm test` loop.
// Run explicitly with `npm run test:scale`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/loadtest/**/*.loadtest.ts"],
    globalSetup: ["./src/scaleGlobalSetup.ts"],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    fileParallelism: false,
    env: {
      DATABASE_URL: "postgres://postgres:postgres@localhost:55434/nephroassets_scale",
      JWT_SECRET: "test-only-fixed-secret-never-used-outside-the-test-suite"
    }
  }
});
