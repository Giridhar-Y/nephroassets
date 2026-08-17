import { startScalePostgres, stopScalePostgres } from "./db/scalePostgres.js";

export default async function setup() {
  await startScalePostgres();
  return async () => {
    await stopScalePostgres();
  };
}
