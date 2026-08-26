import { getPool } from "../db/pool.js";
import { computeComponent } from "../calc/engine.js";
import type { FySettings } from "../calc/types.js";

// One-off comparison script for the end-of-life taper change — NOT part of the app, not
// imported anywhere. Computes "old" (pre-taper, flat-rate + cap) periodDepreciation
// alongside "new" (taper-aware, the actual computeComponent now in engine.ts) for every
// real asset in the local dev database, using only fields the taper change left
// untouched (depOnOpening/depOnAdditions/grossBlock/disposalEffective, all still governed
// by the same pre-taper logic) — so this needs only the current engine, not a checkout of
// the pre-change code.
async function main() {
  const client = await getPool();

  const { rows: settingsRows } = await client.query(
    `SELECT as_at, fy_start, fy_end, days_in_fy FROM settings WHERE id = TRUE`
  );
  const s = settingsRows[0];
  const fy: FySettings = { asAt: s.as_at, fyStart: s.fy_start, fyEnd: s.fy_end, daysInFy: s.days_in_fy };
  console.log("FY settings:", fy);

  const { rows: assets } = await client.query(`SELECT * FROM assets`);
  console.log(`Total assets: ${assets.length}`);

  let affectedComponentRows = 0;
  let oldTotal = 0;
  let newTotal = 0;
  const affectedFarIds = new Set<string>();
  const samples: unknown[] = [];

  for (const a of assets) {
    for (const comp of ["1", "2"] as const) {
      const input = {
        dateAcquired: a.date_acquired,
        openingCost: Number(a[`c${comp}_opening_cost`]),
        additions: Number(a[`additions_c${comp}`]),
        dateOfAddition: a.date_of_addition,
        usefulLifeYears: Number(a[`useful_life_c${comp}_years`]),
        dateOfDisposal: a.date_of_disposal,
        deletionsCost: Number(a[`deletions_c${comp}`]),
        saleValue: Number(a.sale_value),
        accDepOpening: Number(a[`acc_dep_c${comp}_opening`])
      };
      const r = computeComponent(input, fy);
      const effectiveDisposedCost = r.disposalEffective ? input.deletionsCost : 0;
      const costBase = r.grossBlock + effectiveDisposedCost;
      const oldPeriodDep = Math.min(
        r.depOnOpening + r.depOnAdditions,
        Math.max(costBase - input.accDepOpening, 0)
      );
      const newPeriodDep = r.periodDepreciation;

      oldTotal += oldPeriodDep;
      newTotal += newPeriodDep;

      if (Math.round(oldPeriodDep * 100) !== Math.round(newPeriodDep * 100)) {
        affectedComponentRows++;
        affectedFarIds.add(a.far_id);
        if (samples.length < 15) {
          samples.push({
            farId: a.far_id,
            component: `C${comp}`,
            dateAcquired: a.date_acquired,
            usefulLifeYears: input.usefulLifeYears,
            openingCost: input.openingCost,
            oldPeriodDep: Math.round(oldPeriodDep * 100) / 100,
            newPeriodDep: Math.round(newPeriodDep * 100) / 100,
            newNbv: Math.round(r.nbv * 100) / 100
          });
        }
      }
    }
  }

  console.log(`\nAssets affected (>=1 component's period-dep changes): ${affectedFarIds.size} of ${assets.length}`);
  console.log(`Component-rows affected (C1 or C2 individually changed): ${affectedComponentRows} of ${assets.length * 2}`);
  console.log(`Old total period depreciation (all components): ${oldTotal.toFixed(2)}`);
  console.log(`New total period depreciation (all components): ${newTotal.toFixed(2)}`);
  console.log(`Delta: ${(newTotal - oldTotal).toFixed(2)}`);
  console.log("\nSample of affected rows:");
  console.table(samples);

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
