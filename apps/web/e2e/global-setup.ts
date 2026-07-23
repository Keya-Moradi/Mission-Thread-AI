import { execFileSync } from "node:child_process";
import path from "node:path";

// Playwright compiles this file to CommonJS (apps/web/package.json has no
// "type": "module"), so `__dirname` — not `import.meta.url` — is what's
// actually available here.
const rootDir = path.resolve(__dirname, "..", "..", "..");

/**
 * Resets and reseeds `missionthread_test` before the Playwright suite runs
 * — the same `db:reset:test` command used everywhere else in this repo
 * (packages/core/scripts/reset-test-db.ts, via the root
 * scripts/with-destructive-auth.mjs wrapper), never a bespoke reset path.
 * Guarantees the deterministic fixture this suite's happy-path test
 * depends on: one successful analysis, three PENDING mitigation options,
 * no decisions, no proposed changes, no applied changes — see
 * docs/DECISIONS.md, "Phase 5 Playwright test-database determinism".
 */
export default function globalSetup(): void {
  execFileSync("npm", ["run", "db:reset:test"], { cwd: rootDir, stdio: "inherit" });
}
