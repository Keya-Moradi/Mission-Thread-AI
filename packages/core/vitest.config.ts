import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Forces DATABASE_URL to the approved local test target before any test
    // file runs — see src/test/setup-env.ts. Required now that Phase 2 adds
    // database-backed service tests; Phase 1's tests were all DB-free.
    setupFiles: ["src/test/setup-env.ts"],
    // Phase 5 added tests that create/apply real domain-record fixtures
    // (Milestone/Risk/BudgetItem rows under the live seeded PROGRAM_ID) —
    // several other test files compute whole-program aggregates over that
    // same data (e.g. calculateReadinessScore's exact locked-in seeded
    // score) and assert an exact result. Running test files in parallel
    // against one shared test database let those two kinds of test
    // transiently race each other. Sequential file execution removes the
    // race at the cost of some wall-clock time — acceptable at this
    // project's test-suite size. See docs/DECISIONS.md, "Phase 5 test
    // suite: disabled cross-file parallelism".
    fileParallelism: false,
  },
});
