import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatConsoleReport, writeJsonReport } from "./reporters";
import { runEvalSuite } from "./runner";

// Entry point for `npm run eval:mock` — deterministic, offline, safe for
// CI, independent of any database, zero network calls. Reuses the
// production mock provider (generateMockImpactAnalysis) and the
// production validateProviderOutput() throughout scenarios.ts; this file
// only runs the suite, prints it, writes the JSON report, and sets a
// nonzero exit code on any failure. See evals/README.md.
const report = runEvalSuite();
console.log(formatConsoleReport(report));

const outputPath = join(dirname(fileURLToPath(import.meta.url)), ".output", "mock-report.json");
writeJsonReport(report, outputPath);
console.log(`\nWrote machine-readable report to ${outputPath}`);

if (!report.allPassed) {
  process.exitCode = 1;
}
