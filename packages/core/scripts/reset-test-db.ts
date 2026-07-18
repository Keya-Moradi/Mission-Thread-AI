import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { config as loadEnv } from "dotenv";
import {
  LOCAL_TEST_TARGETS,
  checkDestructiveOperationAllowed,
  classifySeedScopeError,
  isTestSeedScope,
} from "../src/db-safety";

// Checked before anything else in this module runs — before dotenv is
// loaded, before TEST_DATABASE_URL is read, and before
// checkDestructiveOperationAllowed() or `prisma migrate reset` run below.
// npm run db:reset:test normally sets MISSIONTHREAD_SEED_SCOPE=test via
// scripts/with-destructive-auth.mjs before this script starts, but this
// script does not trust that wrapper to have done so correctly — a wrapper
// bug, or this file being invoked directly, could otherwise let an
// irreversible `prisma migrate reset` run with the wrong scope inherited.
// The rejection message reports only missing-vs-invalid, never the raw
// value: a malformed environment variable could itself be a connection
// string, a credential, or other sensitive text.
if (!isTestSeedScope(process.env.MISSIONTHREAD_SEED_SCOPE)) {
  const reason = classifySeedScopeError(process.env.MISSIONTHREAD_SEED_SCOPE);
  console.error(
    `Refusing test database reset: MISSIONTHREAD_SEED_SCOPE is ${reason}; expected exactly "test".`,
  );
  process.exit(1);
}

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
  // Local-only tool: CI never runs this script (it migrates+seeds the
  // GitHub Actions Postgres service directly via a dedicated internal
  // command — see .github/workflows/ci.yml), so only the local test
  // targets are ever appropriate here, never GITHUB_ACTIONS_TEST_TARGETS.
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
// MISSIONTHREAD_SEED_SCOPE is not set explicitly here — it's already
// "test" in process.env, inherited from the wrapper that launched this
// script (npm run db:reset:test), and the spread below passes it through.
execFileSync("npx", ["tsx", "prisma/seed.ts"], {
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: testDatabaseUrl },
});

console.log("Test database reset complete.");
