import type { AssetInput } from "../calc/types.js";

// Deterministic PRNG (same algorithm as db/seed.ts) so the exact same fixture can be
// regenerated in pure JS — used as the independent oracle the load test checks the
// SQL-aggregated report totals against, without ever reading the seeded rows back out
// of the database.
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const CENTERS = Array.from({ length: 500 }, (_, i) => `Center-${String(i + 1).padStart(3, "0")}`);
const SUB_CLASSIFICATIONS = [
  "Dialysis Machines",
  "RO Plants",
  "Furniture & Fixtures",
  "IT Equipment",
  "Medical Equipment",
  "Office Equipment",
  "Vehicles",
  "Electrical Installations"
];
const STATUSES = ["Active", "Disposed", "Under Repair"];

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, days: number): Date {
  const copy = new Date(d.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

export const LOADTEST_FY_START = new Date(Date.UTC(2026, 3, 1)); // 2026-04-01

export function generateAssets(count: number, seed: number): AssetInput[] {
  const rand = mulberry32(seed);
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]!;
  const assets: AssetInput[] = [];

  for (let i = 0; i < count; i++) {
    const farId = `LT-${String(i + 1).padStart(7, "0")}`;
    const center = pick(CENTERS);
    const subClass = pick(SUB_CLASSIFICATIONS);
    const acquiredYearsAgo = 1 + Math.floor(rand() * 5);
    const dateAcquired = addDays(LOADTEST_FY_START, -365 * acquiredYearsAgo - Math.floor(rand() * 365));

    const c1Cost = Math.round(10000 + rand() * 490000);
    const c2Cost = Math.round(rand() * 50000);
    const usefulLifeC1 = pick([5, 7, 10, 15]);
    const usefulLifeC2 = pick([3, 5]);

    const hasAddition = rand() < 0.15;
    const additionsC1 = hasAddition ? Math.round(5000 + rand() * 50000) : 0;
    const additionsC2 = hasAddition ? Math.round(rand() * 5000) : 0;
    const dateOfAddition = hasAddition ? isoDate(addDays(LOADTEST_FY_START, Math.floor(rand() * 130))) : null;

    const isDisposed = rand() < 0.1;
    const dateOfDisposal = isDisposed ? isoDate(addDays(LOADTEST_FY_START, 30 + Math.floor(rand() * 100))) : null;
    const deletionsC1 = isDisposed ? Math.round(c1Cost * (0.3 + rand() * 0.7)) : 0;
    const deletionsC2 = isDisposed ? Math.round(c2Cost * (0.3 + rand() * 0.7)) : 0;
    const saleValue = isDisposed ? Math.round(deletionsC1 * rand() * 0.5) : 0;

    const status = isDisposed ? "Disposed" : pick(STATUSES.filter((s) => s !== "Disposed"));

    const ageFraction = Math.min(0.85, acquiredYearsAgo / (usefulLifeC1 + 2));
    const accDepC1Opening = Math.round(c1Cost * ageFraction * rand());
    const accDepC2Opening = Math.round(c2Cost * ageFraction * rand());

    assets.push({
      farId,
      subClassification: subClass,
      assetDescription: `${subClass} #${i + 1}`,
      serialNo: `SN-LT-${100000 + i}`,
      qty: 1,
      status,
      dateAcquired: isoDate(dateAcquired),
      location: center,
      revisedLocation: null,
      lastDateOfTransaction: null,
      parentFarId: null,
      disposedViaParentFarId: null,
      hasChildren: false,
      usefulLifeC1Years: usefulLifeC1,
      usefulLifeC2Years: usefulLifeC2,
      c1OpeningCost: c1Cost,
      c2OpeningCost: c2Cost,
      additionsC1,
      additionsC2,
      dateOfAddition,
      dateOfDisposal,
      deletionsC1,
      deletionsC2,
      saleValue,
      accDepC1Opening,
      accDepC2Opening
    });
  }

  return assets;
}
