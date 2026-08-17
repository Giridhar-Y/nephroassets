import { startTestPostgres, stopTestPostgres } from "./db/testPostgres.js";

export default async function setup() {
  await startTestPostgres();
  return async () => {
    await stopTestPostgres();
  };
}
