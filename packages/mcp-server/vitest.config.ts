import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/test/setup-env.ts"],
    // Matches packages/core's own choice (see its vitest.config.ts) — this
    // suite shares the same seeded PROGRAM_ID data with packages/core's own
    // test run when both happen to run around the same time locally.
    fileParallelism: false,
  },
});
