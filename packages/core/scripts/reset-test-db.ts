import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { config as loadEnv } from "dotenv";
import { LOCAL_TEST_TARGETS, checkDestructiveOperationAllowed } from "../src/db-safety";

// Environment files live at the repo root (SPEC.md §17); load explicitly so
// this script works when invoked directly, not just through npm/CI env vars.
if (!process.env.TEST_DATABASE_URL) {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  loadEnv({ path: path.join(rootDir, ".env.test") });
}

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

// checkDestructiveOperationAllowed() is the single guard shared by this
// script and the seed script's own clear-and-reseed step — see
// packages/core/src/db-safety.ts. Its rejection messages are pre-sanitized
// (host/port/database only), so it's always safe to print directly; never
// interpolate testDatabaseUrl itself into a log line, which would leak the
// local database credentials.
const check = checkDestructiveOperationAllowed({
  operationName: "test database reset",
  databaseUrl: testDatabaseUrl,
  // Local-only tool: CI never runs this script (it migrates+seeds the CI
  // Postgres service directly — see .github/workflows/ci.yml), so only the
  // local test targets are ever appropriate here, never CI_TEST_TARGETS.
  approvedTargets: LOCAL_TEST_TARGETS,
});

if (!check.allowed) {
  console.error(check.message);
  process.exit(1);
}

console.log(check.message);

execFileSync("npx", ["prisma", "migrate", "reset", "--force", "--schema", "prisma/schema.prisma"], {
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: testDatabaseUrl },
});

console.log("Seeding test database...");

// Explicit, rather than relying on Prisma's own post-reset auto-seed, so
// this script's outcome doesn't depend on that behavior across CLI versions.
// seed.ts runs its own copy of this same guard before it clears any data,
// so this is not the only line of defense even if this script were bypassed.
execFileSync("npx", ["tsx", "prisma/seed.ts"], {
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: testDatabaseUrl },
});

console.log("Test database reset complete.");
