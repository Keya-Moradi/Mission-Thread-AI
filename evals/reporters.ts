import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { EvalReport } from "./runner";

export function formatConsoleReport(report: EvalReport): string {
  const lines: string[] = [];
  lines.push(`MissionThread AI — mock evaluation suite (${report.generatedAt})`);
  lines.push("");
  lines.push("Scenarios:");
  for (const scenario of report.scenarios) {
    const status = scenario.passed ? "PASS" : "FAIL";
    lines.push(`  [${status}] ${scenario.id} — ${scenario.description}`);
    if (scenario.error) {
      lines.push(`         ERROR (scenario threw, treated as a failure): ${scenario.error}`);
    }
    for (const c of scenario.checks) {
      if (!c.pass) {
        lines.push(`         FAILED CHECK: ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
      }
    }
  }
  lines.push("");
  lines.push("Metrics:");
  for (const m of report.metrics) {
    const status =
      m.totalChecks === 0 ? "N/A (no scenario exercised this metric)" : m.passed ? "PASS" : "FAIL";
    lines.push(`  [${status}] ${m.metric}: ${m.passedChecks}/${m.totalChecks} checks passed`);
  }
  lines.push("");
  lines.push(
    `Summary: ${report.passedScenarios}/${report.totalScenarios} scenarios passed — ` +
      `${report.allPassed ? "ALL PASSED" : "FAILURES PRESENT"}`,
  );
  return lines.join("\n");
}

/**
 * Writes the complete report as machine-readable JSON to a fixed,
 * gitignored path (evals/.output/ — see .gitignore) so a CI run or a local
 * run always produces the same file location without ever committing a
 * captured result. The report contains only scenario IDs/descriptions,
 * boolean/string check results, and metric counts — never a raw prompt,
 * a full untrusted-notes value, or a secret (every fixture in evals/fixtures
 * is fictional, offline, synthetic data to begin with).
 */
export function writeJsonReport(report: unknown, outputPath: string): void {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(report, null, 2), "utf8");
}
