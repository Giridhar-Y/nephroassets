import { expect, test as setup } from "@playwright/test";
import { DEMO_USERNAME, DEMO_PASSWORD } from "../src/lib/AuthContext.js";

const authFile = "e2e/.auth/user.json";

// Runs once before the main test project (see playwright.config.ts's "setup" project
// and the "chromium" project's `dependencies`/`storageState`), logging in through the
// real UI and saving the resulting session so every other spec starts pre-authenticated
// instead of getting redirected to /login.
setup("authenticate", async ({ page }) => {
  await page.goto("/#/login");
  await page.getByLabel("Username").fill(DEMO_USERNAME);
  await page.getByLabel("Password").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(page).not.toHaveURL(/#\/login/);
  await page.context().storageState({ path: authFile });
});
