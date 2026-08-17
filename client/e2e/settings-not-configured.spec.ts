import { expect, test } from "@playwright/test";

// Guards against a real bug found during the Phase 5 polish pass: if the settings row
// doesn't exist yet (a fresh deployment), every page used to get stuck in a perpetual
// loading skeleton — including the Settings page itself, so a first-run user could
// never get past it. Intercepts the API instead of touching the real dev database.
test("a missing settings row shows a clear prompt, not a stuck skeleton or a crash", async ({ page }) => {
  await page.route("**/api/settings", (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ status: 404, json: { error: "Settings have not been configured yet." } });
    }
    return route.continue();
  });

  await page.goto("/#/register");
  await expect(page.getByText("Your financial year hasn't been set up yet.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Go to Settings" })).toBeVisible();

  // The top bar must not hang on a skeleton forever either.
  await expect(page.getByRole("link", { name: "Set up your financial year →" })).toBeVisible();

  // Following the link must land on a *usable* (not stuck) Settings form.
  await page.getByRole("link", { name: "Go to Settings" }).click();
  await expect(page.getByText("Welcome! Set up your financial year below to get started.")).toBeVisible();
  await expect(page.getByLabel("Financial Year Start (FY Start)")).toBeEditable();
});
