import { applySchema, getPool } from "./pool.js";

// Deterministic PRNG so seeded data (and any test that reads it) is reproducible.
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

const CENTERS = Array.from({ length: 25 }, (_, i) => `Center-${String(i + 1).padStart(3, "0")}`);
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

const FY_START = new Date(Date.UTC(2026, 3, 1)); // 2026-04-01
const ASSET_COUNT = Number(process.env.SEED_COUNT ?? 3000);

export async function seed(): Promise<void> {
  await applySchema();
  const db = await getPool();

  const { rows } = await db.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM assets`);
  if (Number(rows[0]?.count) > 0) {
    console.log("Seed skipped: assets table already has data.");
    return;
  }

  const rand = mulberry32(42);
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]!;

  await db.query(
    `INSERT INTO settings (id, as_at, fy_start, fy_end, days_in_fy) VALUES (TRUE, $1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    ["2026-08-17", "2026-04-01", "2027-03-31", 365]
  );

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    for (let i = 0; i < ASSET_COUNT; i++) {
      const farId = `FAR-${String(i + 1).padStart(6, "0")}`;
      const center = pick(CENTERS);
      const subClass = pick(SUB_CLASSIFICATIONS);
      const acquiredYearsAgo = 1 + Math.floor(rand() * 5);
      const dateAcquired = addDays(FY_START, -365 * acquiredYearsAgo - Math.floor(rand() * 365));

      const c1Cost = Math.round(10000 + rand() * 490000);
      const c2Cost = Math.round(rand() * 50000);
      const usefulLifeC1 = pick([5, 7, 10, 15]);
      const usefulLifeC2 = pick([3, 5]);

      // Roughly: 15% get an in-year addition, 10% get disposed, statuses follow.
      const hasAddition = rand() < 0.15;
      const additionsC1 = hasAddition ? Math.round(5000 + rand() * 50000) : 0;
      const additionsC2 = hasAddition ? Math.round(rand() * 5000) : 0;
      const dateOfAddition = hasAddition ? isoDate(addDays(FY_START, Math.floor(rand() * 130))) : null;

      const isDisposed = rand() < 0.1;
      const dateOfDisposal = isDisposed ? isoDate(addDays(FY_START, 30 + Math.floor(rand() * 100))) : null;
      const deletionsC1 = isDisposed ? Math.round(c1Cost * (0.3 + rand() * 0.7)) : 0;
      const deletionsC2 = isDisposed ? Math.round(c2Cost * (0.3 + rand() * 0.7)) : 0;
      const saleValue = isDisposed ? Math.round(deletionsC1 * rand() * 0.5) : 0;

      const status = isDisposed ? "Disposed" : pick(STATUSES.filter((s) => s !== "Disposed"));

      // Rough approximation of opening accumulated depreciation: a random fraction of
      // cost proportional to age, capped below cost so the fixture isn't all fully
      // depreciated.
      const ageFraction = Math.min(0.85, acquiredYearsAgo / (usefulLifeC1 + 2));
      const accDepC1Opening = Math.round(c1Cost * ageFraction * rand());
      const accDepC2Opening = Math.round(c2Cost * ageFraction * rand());

      await client.query(
        `INSERT INTO assets (
          far_id, sub_classification, asset_description, serial_no, qty, status,
          date_acquired, location, revised_location, last_date_of_transaction,
          useful_life_c1_years, useful_life_c2_years,
          c1_opening_cost, c2_opening_cost, additions_c1, additions_c2, date_of_addition,
          date_of_disposal, deletions_c1, deletions_c2, sale_value,
          acc_dep_c1_opening, acc_dep_c2_opening
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23
        )`,
        [
          farId,
          subClass,
          `${subClass} #${i + 1}`,
          `SN-${100000 + i}`,
          1,
          status,
          isoDate(dateAcquired),
          center,
          null,
          null,
          usefulLifeC1,
          usefulLifeC2,
          c1Cost,
          c2Cost,
          additionsC1,
          additionsC2,
          dateOfAddition,
          dateOfDisposal,
          deletionsC1,
          deletionsC2,
          saleValue,
          accDepC1Opening,
          accDepC2Opening
        ]
      );

      // ~5% of non-disposed assets have been transferred to a different center.
      if (!isDisposed && rand() < 0.05) {
        const newCenter = pick(CENTERS.filter((c) => c !== center));
        const transferDate = isoDate(addDays(FY_START, Math.floor(rand() * 130)));
        await client.query(
          `INSERT INTO transfers (far_id, transaction_date, location) VALUES ($1, $2, $3)`,
          [farId, transferDate, newCenter]
        );
      }
    }

    await client.query("COMMIT");
    console.log(`Seeded ${ASSET_COUNT} assets across ${CENTERS.length} centers.`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seed()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
