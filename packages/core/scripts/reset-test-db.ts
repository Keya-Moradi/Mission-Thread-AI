import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { config as loadEnv } from "dotenv";
import { extractDatabaseName, isTestDatabaseName } from "../src/db-safety";

// Environment files live at the repo root (SPEC.md §17); load explicitly so
// this script works when invoked directly, not just through npm/CI env vars.
if (!process.env.TEST_DATABASE_URL) {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  loadEnv({ path: path.join(rootDir, ".env.test") });
}

// Refuses to run unless the target database name clearly contains a test
// marker, so this can never accidentally be pointed at a dev/prod database.
const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) {
  console.error("TEST_DATABASE_URL is not set. Refusing to reset any database.");
  process.exit(1);
}

let databaseName: string;
try {
  databaseName = extractDatabaseName(testDatabaseUrl);
} catch {
  console.error(`TEST_DATABASE_URL is not a valid connection string: ${testDatabaseUrl}`);
  process.exit(1);
}

if (!isTestDatabaseName(databaseName)) {
  console.error(
    `Refusing to reset database "${databaseName}": its name does not contain "test". ` +
      "Test reset must only ever target a database whose name clearly marks it as a test database.",
  );
  process.exit(1);
}

console.log(`Resetting test database "${databaseName}"...`);

execFileSync("npx", ["prisma", "migrate", "reset", "--force", "--schema", "prisma/schema.prisma"], {
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: testDatabaseUrl },
});

console.log("Seeding test database...");

// Explicit, rather than relying on Prisma's own post-reset auto-seed, so
// this script's outcome doesn't depend on that behavior across CLI versions.
execFileSync("npx", ["tsx", "prisma/seed.ts"], {
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: testDatabaseUrl },
});

console.log("Test database reset complete.");
