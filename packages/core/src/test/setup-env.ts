import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { LOCAL_TEST_TARGETS, findApprovedDatabaseTarget, sanitizeDatabaseUrl } from "../db-safety";

// PROJECT_GUIDE.md's testing rules forbid ever running tests against the
// dev database. `override: true` forces DATABASE_URL to the test target
// even if a developer's shell already has DATABASE_URL set to something
// else (e.g. left over from a manual db:seed:dev:destructive invocation) —
// a test run must never inherit an ambient dev DATABASE_URL by accident.
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
loadEnv({ path: path.join(rootDir, ".env.test"), override: true });

// Belt-and-suspenders on top of the override above: fail the whole test
// run immediately, before any test file can import db.ts and construct a
// PrismaClient, if DATABASE_URL doesn't resolve to the one approved local
// test target. A silently-wrong DATABASE_URL here would mean database-backed
// tests read or (via a future test) mutate the wrong database.
const target = sanitizeDatabaseUrl(process.env.DATABASE_URL ?? "");
if (!target || !findApprovedDatabaseTarget(target, LOCAL_TEST_TARGETS, process.env)) {
  throw new Error(
    "Refusing to run tests: DATABASE_URL does not resolve to the approved local test target " +
      "(localhost:55432/missionthread_test or 127.0.0.1:55432/missionthread_test). " +
      "Run `npm run db:reset:test` first and do not override DATABASE_URL for `npm run test`.",
  );
}
