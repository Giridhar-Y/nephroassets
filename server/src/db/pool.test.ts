import { describe, expect, it } from "vitest";
import { shouldUseSsl } from "./pool.js";

describe("shouldUseSsl", () => {
  it("skips SSL for localhost/127.0.0.1/the docker-compose postgres service name", () => {
    expect(shouldUseSsl("postgres://u:p@localhost:5432/db")).toBe(false);
    expect(shouldUseSsl("postgres://u:p@127.0.0.1:5432/db")).toBe(false);
    expect(shouldUseSsl("postgres://u:p@postgres:5432/db")).toBe(false);
  });

  it("defaults to SSL for any other host (managed Postgres like Supabase)", () => {
    expect(shouldUseSsl("postgres://u:p@db.supabase.co:5432/db")).toBe(true);
    expect(shouldUseSsl("postgres://u:p@203.0.113.10:5432/db")).toBe(true);
  });

  it("?sslmode=disable turns SSL off even for a real host/IP — self-hosted Postgres with no SSL configured", () => {
    expect(shouldUseSsl("postgres://u:p@203.0.113.10:5432/db?sslmode=disable")).toBe(false);
  });

  it("?sslmode=require forces SSL on even for a recognized-local hostname", () => {
    expect(shouldUseSsl("postgres://u:p@localhost:5432/db?sslmode=require")).toBe(true);
  });
});
