import { defineConfig } from "vitest/config";

// Pure-function tests only (e.g. the event-entry FormData adapter) — no
// database, no setupFiles needed. Database-backed and page-rendering
// behavior for apps/web continues to be covered by
// apps/web/scripts/smoke-test.mjs against the dedicated test database, not
// by this Vitest suite.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
