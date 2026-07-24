import { defineConfig } from "vitest/config";

// Pure-function tests only (e.g. the event-entry FormData adapter) — no
// database, no setupFiles needed. Database-backed and page-rendering
// behavior for apps/web continues to be covered by
// apps/web/scripts/smoke-test.mjs against the dedicated test database, not
// by this Vitest suite.
export default defineConfig({
  test: {
    environment: "node",
    // "e2e/**/*.test.ts" covers playwright-test-environment.test.ts — a
    // plain pure-function unit test living next to the Playwright module
    // it tests. Playwright's own config restricts itself to "*.spec.ts"
    // specifically so the two tools never both try to run the same file.
    include: ["src/**/*.test.ts", "e2e/**/*.test.ts"],
  },
});
