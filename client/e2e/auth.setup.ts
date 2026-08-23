import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, test as setup } from "@playwright/test";

const authFile = "e2e/.auth/user.json";

const E2E_USERNAME = "e2e-admin";
const E2E_PASSWORD = "e2e-test-password-not-a-secret";
const E2E_EMAIL = "e2e-admin@example.test";

// Points at the same embedded dev Postgres server/src/db/devPostgres.ts starts (and the
// already-running dev server holds a lock on) — must match its DEV_DATABASE_URL exactly,
// not go through seedAdmin.ts's own no-DATABASE_URL auto-provision path, which would try
// to start a second instance against the same locked data directory and fail.
const DEV_DATABASE_URL = "postgres://postgres:postgres@localhost:55432/nephroassets";

// Runs once before the main test project (see playwright.config.ts's "setup" project
// and the "chromium" project's `dependencies`/`storageState`). Real auth (replacing the
// old demo/demo-password client-side gate) means there's no fixed credential to log in
// with anymore — so this idempotently seeds one known admin user via the same script a
// real deploy uses (server/src/scripts/seedAdmin.ts), then logs in through the real UI
// and saves the resulting session so every other spec starts pre-authenticated.
setup("authenticate", async ({ page }) => {
  // shell:true is required on Windows for spawnSync/execFileSync to run "npx" at all
  // (it's npx.cmd, a batch file — EINVAL without a shell to interpret it). The
  // deprecation warning it prints is about unescaped args being a risk with untrusted
  // input; every arg below is a fixed string literal, so that risk doesn't apply here.
  execFileSync("npx", ["tsx", "src/scripts/seedAdmin.ts"], {
    cwd: path.resolve(import.meta.dirname, "../../server"),
    env: {
      ...process.env,
      DATABASE_URL: DEV_DATABASE_URL,
      ADMIN_USERNAME: E2E_USERNAME,
      ADMIN_EMAIL: E2E_EMAIL,
      ADMIN_PASSWORD: E2E_PASSWORD
    },
    stdio: "inherit",
    shell: true
  });

  await page.goto("/#/login");
  await page.getByLabel("Username").fill(E2E_USERNAME);
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(page).not.toHaveURL(/#\/login/);
  await page.context().storageState({ path: authFile });
});
