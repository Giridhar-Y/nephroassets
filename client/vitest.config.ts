import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Separate from e2e (Playwright, client/e2e) — this is for fast, no-browser unit/
// integration tests of client logic (currently just AuthContext's session-death
// handling). Kept minimal on purpose: jsdom + Testing Library, no jest-dom matchers
// extension, since plain assertions cover what's tested here without another dependency.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.tsx", "src/**/*.test.ts"]
  }
});
