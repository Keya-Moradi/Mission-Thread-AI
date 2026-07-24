import path from "node:path";
import { defineConfig } from "@playwright/test";
import { config as loadEnv } from "dotenv";

// Playwright compiles this config to CommonJS (apps/web/package.json has no
// "type": "module"), so `__dirname` — not `import.meta.url` — is what's
// actually available here.
const appDir = __dirname;
const rootDir = path.resolve(appDir, "..", "..");
// Resolved via Node's own module resolution, not a hardcoded relative path
// — see apps/web/scripts/smoke-test.mjs's identical comment: npm workspaces
// hoist `next` to the monorepo root's node_modules, not apps/web's own.
const nextBinPath = require.resolve("next/dist/bin/next");

// Always .env.test, never the shell's own DATABASE_URL — same discipline as
// apps/web/scripts/smoke-test.mjs and every database-backed test in this
// repo (SPEC.md §14): this suite must never run against missionthread_dev.
// `.parsed` (not the process.env side effect) is used directly as the
// webServer's env override, so this file's own process env stays untouched.
const testEnv = loadEnv({ path: path.join(rootDir, ".env.test") }).parsed ?? {};

const PORT = process.env.PLAYWRIGHT_PORT ?? "3200";

export default defineConfig({
  testDir: "./e2e",
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
    env: { ...testEnv, AI_MODE: "mock" },
  },
});
