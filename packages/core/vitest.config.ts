import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Forces DATABASE_URL to the approved local test target before any test
    // file runs — see src/test/setup-env.ts. Required now that Phase 2 adds
    // database-backed service tests; Phase 1's tests were all DB-free.
    setupFiles: ["src/test/setup-env.ts"],
  },
});
