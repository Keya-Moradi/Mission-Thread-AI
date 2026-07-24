import path from "node:path";
import { defineConfig } from "@playwright/test";
import { config as loadEnv } from "dotenv";
import {
  resolvePlaywrightTestEnvironment,
  PlaywrightTestEnvironmentError,
} from "./e2e/playwright-test-environment";

// Playwright compiles this config to CommonJS (apps/web/package.json has no
// "type": "module"), so `__dirname` — not `import.meta.url` — is what's
// actually available here.
const appDir = __dirname;
const rootDir = path.resolve(appDir, "..", "..");
// Resolved via Node's own module resolution, not a hardcoded relative path
// — see apps/web/scripts/smoke-test.mjs's identical comment: npm workspaces
// hoist `next` to the monorepo root's node_modules, not apps/web's own.
const nextBinPath = require.resolve("next/dist/bin/next");

// Explicit replacement semantics (`override: true`): without it, dotenv
// leaves an already-set `process.env.DATABASE_URL` (e.g. a developer's own
// shell pointed at missionthread_dev for normal local work) untouched, and
// while the Next.js webServer below is still explicitly given the correct
// test-database env, this Playwright worker process's own `process.env`
// would keep the ambient value — exactly what previously let a Prisma
// client statically imported in a spec file connect to missionthread_dev
// even though the browser it drove was talking to missionthread_test. See
// docs/DECISIONS.md, "Phase 5 correction: Playwright database-isolation
// repair".
const loadResult = loadEnv({ path: path.join(rootDir, ".env.test"), override: true });
if (loadResult.error) {
  throw new Error(`Failed to load .env.test: ${loadResult.error.message}`);
}

let resolvedTestEnvironment;
try {
  resolvedTestEnvironment = resolvePlaywrightTestEnvironment(process.env, loadResult.parsed);
} catch (error) {
  if (error instanceof PlaywrightTestEnvironmentError) {
    throw new Error(`Playwright test-database resolution failed: ${error.message}`);
  }
  throw error;
}

// The same resolved values are used for both this Playwright worker
// process (and every test-file worker Playwright forks from it — Node's
// child_process.fork() inherits the parent's process.env at fork time,
// which is why mutating it here, in the config-loading process, is enough)
// and the Next.js web server's child process below. Neither ever derives
// its database URL through a separate path. e2e/decision-workflow.spec.ts
// independently re-verifies this again immediately before it ever
// constructs a Prisma client, rather than trusting that this assignment
// definitely propagated.
Object.assign(process.env, resolvedTestEnvironment.env);

const PORT = process.env.PLAYWRIGHT_PORT ?? "3200";

export default defineConfig({
  testDir: "./e2e",
  // Explicit, not Playwright's default "*.spec.ts or *.test.ts" match —
  // e2e/playwright-test-environment.test.ts is a plain Vitest unit-test
  // file (picked up separately by apps/web/vitest.config.ts) that lives
  // alongside its module for proximity; without narrowing this, Playwright
  // would also try to run it as one of its own tests.
  testMatch: "**/*.spec.ts",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  // Deliberately no globalSetup here: this suite must never perform a
  // hidden schema/database reset on an ordinary `npm run test:e2e`. The
  // deterministic starting fixture it needs (one successful analysis,
  // three PENDING mitigation options, no decisions) comes from a
  // separately, explicitly authorized `npm run db:reset:test` run before
  // this suite — see README.md and docs/DECISIONS.md, "Phase 5
  // correction: non-destructive Playwright command". The one test this
  // suite currently runs (e2e/decision-workflow.spec.ts) restores every
  // record it changes in a try/finally, so it stays repeatable without a
  // reset between runs.
  use: {
    baseURL: `http://localhost:${PORT}`,
  },
  webServer: {
    command: `node ${nextBinPath} start -p ${PORT}`,
    cwd: appDir,
    port: Number(PORT),
    reuseExistingServer: false,
    timeout: 60_000,
    env: { ...resolvedTestEnvironment.env, AI_MODE: "mock" },
  },
});
