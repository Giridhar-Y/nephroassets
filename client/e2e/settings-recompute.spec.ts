import { expect, test } from "@playwright/test";

const API_BASE = "http://localhost:4000";
const FAR_ID = "FAR-000001";

const currencyFormatter = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0
});

async function fetchExpectedC1Nbv(request: import("@playwright/test").APIRequestContext) {
  const res = await request.get(`${API_BASE}/api/assets?search=${FAR_ID}&limit=1`);
  const body = await res.json();
  const item = body.items.find((i: { asset: { farId: string } }) => i.asset.farId === FAR_ID);
  if (!item) throw new Error(`${FAR_ID} not found`);
  return currencyFormatter.format(item.result.c1.nbv);
}

test.beforeEach(async ({ request }) => {
  await request.put(`${API_BASE}/api/settings`, {
    data: { asAt: "2026-08-17", fyStart: "2026-04-01", fyEnd: "2027-03-31", daysInFy: 365 }
  });
});

// Non-negotiable criterion #2 ("changing AS_AT ... must recompute with no stale data")
// extends to the other settings the Settings page makes editable: changing FY Start
// changes Days Held for every asset's opening balance even when AS_AT itself doesn't
// move, so the register must recompute then too.
test("changing FY Start on the Settings page recomputes the register with no stale data", async ({
  page,
  request
}) => {
  await page.goto("/#/register");
  const row = page.locator(`[data-testid="register-row"][data-far-id="${FAR_ID}"]`);
  await expect(row).toBeVisible();
  const nbvCell = row.locator('[data-testid="cell-c1Nbv"]');

  const initialText = await nbvCell.textContent();
  expect(initialText?.trim()).toBe(await fetchExpectedC1Nbv(request));

  await page.goto("/#/settings");
  await page.getByLabel("Financial Year Start (FY Start)").fill("2026-01-01");
  await page.getByRole("button", { name: "Save Settings" }).click();
  await expect(page.getByText(/Settings saved\./)).toBeVisible();

  const expectedAfter = await fetchExpectedC1Nbv(request);

  await page.goto("/#/register");
  await expect(row).toBeVisible();
  const updatedText = await nbvCell.textContent();

  expect(updatedText?.trim()).not.toBe(initialText?.trim());
  expect(updatedText?.trim()).toBe(expectedAfter);
});
