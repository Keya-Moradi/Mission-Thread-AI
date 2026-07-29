import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { findApprovedDatabaseTarget, sanitizeDatabaseUrl } from "@missionthread/core/db-safety";
import { resolveTestDatabaseConfiguration } from "@missionthread/core/test-db-config";

// Mirrors packages/core/src/test/setup-env.ts exactly — reusing the same
// shared db-safety helpers and test-database-selection logic (§21: "reuse
// the established test-database safety helpers"). Validates the target
// before any test file in this package can import Prisma (transitively,
// through @missionthread/core) and touch a real database.
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

const target = sanitizeDatabaseUrl(process.env.DATABASE_URL ?? "");
if (!target || !findApprovedDatabaseTarget(target, configuration.approvedTargets, process.env)) {
  const expected =
    process.env.GITHUB_ACTIONS === "true"
      ? 'localhost:5432/missionthread_test with GITHUB_ACTIONS="true" (the GitHub Actions service-container target)'
      : "localhost:55432/missionthread_test or 127.0.0.1:55432/missionthread_test. Run `npm run db:reset:test` first and do not override DATABASE_URL for `npm run test:mcp`";
  throw new Error(
    `Refusing to run tests: DATABASE_URL does not resolve to the approved target. Expected ${expected}.`,
  );
}
