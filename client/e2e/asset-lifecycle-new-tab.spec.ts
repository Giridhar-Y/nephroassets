import { expect, test } from "@playwright/test";

const FAR_ID = "FAR-000001";

test("View Lifecycle opens Asset History in a new tab, leaving Register untouched", async ({ page, context }) => {
  await page.goto("/#/register");

  const row = page.locator(`[data-testid="register-row"][data-far-id="${FAR_ID}"]`);
  await expect(row).toBeVisible();

  const [newTab] = await Promise.all([
    context.waitForEvent("page"),
    page.getByRole("link", { name: `View lifecycle for ${FAR_ID}` }).click()
  ]);
  await newTab.waitForLoadState();

  // The new tab lands on the right asset's detail view, not blank or defaulting to Register.
  await expect(newTab).toHaveURL(new RegExp(`#/assets/${FAR_ID}$`));
  await expect(newTab.getByRole("heading", { name: new RegExp(FAR_ID) })).toBeVisible();

  // The original Register tab never navigated away.
  await expect(page).toHaveURL(/#\/register$/);
  await expect(row).toBeVisible();

  await newTab.close();
});
