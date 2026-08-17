import { expect, test } from "@playwright/test";

const API_BASE = "http://localhost:4000";
const FAR_ID = "FAR-000001";
const BASELINE_AS_AT = "2026-08-17";
const NEW_AS_AT = "2026-06-01";

const currencyFormatter = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0
});

async function fetchExpectedC1Nbv(request: import("@playwright/test").APIRequestContext, asAt: string) {
  const res = await request.get(`${API_BASE}/api/assets?asAt=${asAt}&search=${FAR_ID}&limit=1`);
  const body = await res.json();
  const item = body.items.find((i: { asset: { farId: string } }) => i.asset.farId === FAR_ID);
  if (!item) throw new Error(`${FAR_ID} not found for asAt=${asAt}`);
  return currencyFormatter.format(item.result.c1.nbv);
}

test.beforeEach(async ({ request }) => {
  const current = await (await request.get(`${API_BASE}/api/settings`)).json();
  await request.put(`${API_BASE}/api/settings`, {
    data: { ...current, asAt: BASELINE_AS_AT }
  });
});

test("changing AS_AT recomputes the register with no stale data", async ({ page, request }) => {
  await page.goto("/#/register");

  const row = page.locator(`[data-testid="register-row"][data-far-id="${FAR_ID}"]`);
  await expect(row).toBeVisible();

  const nbvCell = row.locator('[data-testid="cell-c1Nbv"]');
  const initialText = await nbvCell.textContent();

  const expectedInitial = await fetchExpectedC1Nbv(request, BASELINE_AS_AT);
  expect(initialText?.trim()).toBe(expectedInitial);

  const responsePromise = page.waitForResponse(
    (res) => res.url().includes("/api/assets") && res.url().includes(`asAt=${NEW_AS_AT}`)
  );
  const asAtInput = page.getByTestId("asat-input");
  await asAtInput.fill(NEW_AS_AT);
  await asAtInput.blur();
  await responsePromise;

  // Same row, same field, must now reflect the new AS_AT — not the value cached from
  // the previous date.
  await expect(row).toBeVisible();
  const updatedText = await nbvCell.textContent();
  expect(updatedText?.trim()).not.toBe(initialText?.trim());

  const expectedUpdated = await fetchExpectedC1Nbv(request, NEW_AS_AT);
  expect(updatedText?.trim()).toBe(expectedUpdated);
});
