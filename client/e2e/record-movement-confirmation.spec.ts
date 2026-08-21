import { expect, test } from "@playwright/test";

const API_BASE = "http://localhost:4000";

test("Transfer: Go back preserves entered values, Esc dismisses the confirm step without submitting", async ({
  page,
  request
}) => {
  const farId = `E2E-XFER-${Date.now()}`;
  await request.post(`${API_BASE}/api/assets`, {
    data: {
      farId,
      subClassification: "IT Equipment",
      assetDescription: "E2E Transfer Confirmation Asset",
      status: "Active",
      dateAcquired: "2020-01-01",
      location: "Center-001",
      usefulLifeC1Years: 5,
      usefulLifeC2Years: 5,
      c1OpeningCost: 10000
    }
  });

  await page.goto("/#/register");
  await page.getByRole("button", { name: "Filter FAR ID" }).click();
  await page.getByPlaceholder("e.g. FAR-000123").fill(farId);
  const row = page.locator(`[data-testid="register-row"][data-far-id="${farId}"]`);
  await expect(row).toBeVisible();

  await row.locator('input[type="checkbox"]').check();
  await page.getByRole("button", { name: /Record Movement \(1\)/ }).click();
  await page.getByRole("button", { name: "Transfer", exact: true }).click();

  await page.getByLabel("Destination Center").selectOption("Center-007");
  await page.getByRole("button", { name: "Transfer", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Confirm Transfer" })).toBeVisible();

  // Go back must return to the form with the chosen destination still selected, not reset it.
  await page.getByRole("button", { name: "Go back" }).click();
  await expect(page.getByLabel("Destination Center")).toHaveValue("Center-007");

  // Re-open the confirm step, then dismiss with Escape — must not submit anything.
  await page.getByRole("button", { name: "Transfer", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Confirm Transfer" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("Destination Center")).toBeVisible();

  const res = await request.get(`${API_BASE}/api/assets?search=${farId}&limit=1`);
  const body = await res.json();
  // Still at the original location — neither Go back nor Escape actually transferred it.
  expect(body.items[0].result.effectiveLocation).toBe("Center-001");
});

test("Dispose: confirm step shows the right summary, then completes the disposal on confirm", async ({
  page,
  request
}) => {
  const farId = `E2E-DISP-${Date.now()}`;
  await request.post(`${API_BASE}/api/assets`, {
    data: {
      farId,
      subClassification: "IT Equipment",
      assetDescription: "E2E Disposal Confirmation Asset",
      status: "Active",
      dateAcquired: "2020-01-01",
      location: "Center-001",
      usefulLifeC1Years: 5,
      usefulLifeC2Years: 5,
      c1OpeningCost: 10000
    }
  });

  await page.goto("/#/register");
  await page.getByRole("button", { name: "Filter FAR ID" }).click();
  await page.getByPlaceholder("e.g. FAR-000123").fill(farId);
  const row = page.locator(`[data-testid="register-row"][data-far-id="${farId}"]`);
  await expect(row).toBeVisible();

  await row.locator('input[type="checkbox"]').check();
  await page.getByRole("button", { name: /Record Movement \(1\)/ }).click();
  await page.getByRole("button", { name: "Dispose", exact: true }).click();

  await page.getByLabel("Sale Value").fill("500");
  await page.getByRole("button", { name: "Dispose", exact: true }).click();

  await expect(page.getByRole("heading", { name: "Confirm Disposal" })).toBeVisible();
  await expect(page.getByRole("cell", { name: farId })).toBeVisible();
  await expect(page.getByText(/cannot be easily undone/)).toBeVisible();

  await page.getByRole("button", { name: "Confirm & Dispose" }).click();
  await expect(page.getByText(/asset.*disposed/)).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();

  const res = await request.get(`${API_BASE}/api/assets?search=${farId}&limit=1`);
  const body = await res.json();
  expect(body.items[0].asset.status).toBe("Disposed");
  expect(body.items[0].asset.saleValue).toBe(500);
});
