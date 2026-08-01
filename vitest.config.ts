import { defineConfig } from "vitest/config";

// Pure-function tests for root-level scripts/ only (currently
// scripts/check-audit.mjs) — mirrors apps/web/vitest.config.ts's own
// minimal, database-free setup for the same reason: a small, genuinely
// pure module earned direct unit coverage without pulling scripts/ into a
// full npm workspace of its own. No database, no setupFiles, no child
// process — see scripts/check-audit.test.mjs's own header comment.
export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/**/*.test.mjs"],
  },
});
