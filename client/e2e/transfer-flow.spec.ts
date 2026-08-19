import { expect, test } from "@playwright/test";

const API_BASE = "http://localhost:4000";
const FAR_ID = "FAR-000009";

test("center-first transfer: pick a center, select an asset, move it to another center", async ({
  page,
  request
}) => {
  // Put the asset at a known starting center first, so this test is self-contained
  // regardless of what earlier test/manual-testing runs left it at.
  await request.post(`${API_BASE}/api/transfers`, {
    data: { farIds: [FAR_ID], toLocation: "Center-010", transactionDate: "2026-01-01" }
  });

  await page.goto("/#/register");

  // Center-first: narrow the list to one center before picking assets to transfer.
  // Filtering lives in an inline header popover now, so open it before the select is reachable.
  await page.getByRole("button", { name: "Filter Current Location" }).click();
  await page.getByLabel("Center").selectOption("Center-010");
  const row = page.locator(`[data-testid="register-row"][data-far-id="${FAR_ID}"]`);
  await expect(row).toBeVisible();

  await row.locator('input[type="checkbox"]').check();
  // Transfer and Dispose now live behind one combined "Record Movement" dropdown.
  await page.getByRole("button", { name: /Record Movement \(1\)/ }).click();
  await page.getByRole("button", { name: "Transfer", exact: true }).click(); // dropdown item

  await page.getByLabel("Destination Center").selectOption("Center-020");
  await page.getByRole("button", { name: "Transfer", exact: true }).click(); // form submit -> confirm step

  // Confirm step: summarizes the change before anything is actually written.
  await expect(page.getByRole("heading", { name: "Confirm Transfer" })).toBeVisible();
  await expect(page.getByRole("cell", { name: FAR_ID })).toBeVisible();
  await page.getByRole("button", { name: "Confirm & Transfer" }).click();

  // Success step, then dismiss it — the modal only closes once the user acknowledges it.
  await expect(page.getByText(/asset.*transferred to Center-020/)).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByLabel("Destination Center")).toBeHidden();

  const res = await request.get(`${API_BASE}/api/assets?search=${FAR_ID}&limit=1`);
  const body = await res.json();
  expect(body.items[0].result.effectiveLocation).toBe("Center-020");
});
