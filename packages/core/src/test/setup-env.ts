import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { findApprovedDatabaseTarget, sanitizeDatabaseUrl } from "../db-safety";
import { resolveTestDatabaseConfiguration } from "./resolve-test-database-configuration";

// PROJECT_GUIDE.md's testing rules forbid ever running tests against the
// dev database, in either context this suite runs in (local development or
// GitHub Actions) — see resolveTestDatabaseConfiguration for why the two
// contexts need different environment-loading behavior.
const configuration = resolveTestDatabaseConfiguration(process.env);

if (configuration.environmentFile) {
  const rootDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "..",
  );
  loadEnv({
    path: path.join(rootDir, configuration.environmentFile),
    override: configuration.overrideEnvironment,
  });
}

// Belt-and-suspenders on top of the context-specific loading above: fail
// the whole test run immediately, before any test file can import db.ts
// and construct a PrismaClient, if DATABASE_URL doesn't resolve to the one
// target approved for this specific context. A silently-wrong DATABASE_URL
// here would mean database-backed tests read or (via a future test) mutate
// the wrong database.
const target = sanitizeDatabaseUrl(process.env.DATABASE_URL ?? "");
if (!target || !findApprovedDatabaseTarget(target, configuration.approvedTargets, process.env)) {
  const expected =
    process.env.GITHUB_ACTIONS === "true"
      ? 'localhost:5432/missionthread_test with GITHUB_ACTIONS="true" (the GitHub Actions service-container target)'
      : "localhost:55432/missionthread_test or 127.0.0.1:55432/missionthread_test. Run `npm run db:reset:test` first and do not override DATABASE_URL for `npm run test`";
  throw new Error(
    `Refusing to run tests: DATABASE_URL does not resolve to the approved target. Expected ${expected}.`,
  );
}
