import {
  EVAL_METRICS,
  EVAL_SCENARIOS,
  type EvalCheck,
  type EvalMetric,
  type EvalScenario,
} from "./scenarios";

export interface ScenarioResult {
  id: string;
  description: string;
  passed: boolean;
  checks: EvalCheck[];
  /** Set only if the scenario's own run() threw — every scenario in this
   * suite is written to never throw for an expected (even adversarial)
   * case, so a populated error here is itself a suite-level defect. */
  error?: string;
}

export interface MetricSummary {
  metric: EvalMetric;
  totalChecks: number;
  passedChecks: number;
  /** false if any tagged check failed; also false (not vacuously true) if
   * no scenario tagged this metric at all — that's a reporting gap, never
   * silently treated as a pass. */
  passed: boolean;
}

export interface EvalReport {
  generatedAt: string;
  totalScenarios: number;
  passedScenarios: number;
  failedScenarios: number;
  allPassed: boolean;
  scenarios: ScenarioResult[];
  metrics: MetricSummary[];
}

function runScenario(scenario: EvalScenario): ScenarioResult {
  try {
    const checks = scenario.run();
    return {
      id: scenario.id,
      description: scenario.description,
      passed: checks.length > 0 && checks.every((c) => c.pass),
      checks,
    };
  } catch (error) {
    return {
      id: scenario.id,
      description: scenario.description,
      passed: false,
      checks: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Runs every scenario against the production mock provider and the
 * production validateProviderOutput() — no test-only or eval-only
 * reimplementation of either. Deterministic, offline, synchronous: no
 * network call, no database access, no randomness, no real-time delay
 * anywhere in this call graph. See evals/README.md.
 */
export function runEvalSuite(scenarios: EvalScenario[] = EVAL_SCENARIOS): EvalReport {
  const scenarioResults = scenarios.map(runScenario);
  const allChecks = scenarioResults.flatMap((r) => r.checks);

  const metrics: MetricSummary[] = EVAL_METRICS.map((metric) => {
    const tagged = allChecks.filter((c) => c.metric === metric);
    const passedChecks = tagged.filter((c) => c.pass).length;
    return {
      metric,
      totalChecks: tagged.length,
      passedChecks,
      passed: tagged.length > 0 && passedChecks === tagged.length,
    };
  });

  const passedScenarios = scenarioResults.filter((r) => r.passed).length;
  return {
    generatedAt: new Date().toISOString(),
    totalScenarios: scenarioResults.length,
    passedScenarios,
    failedScenarios: scenarioResults.length - passedScenarios,
    allPassed: passedScenarios === scenarioResults.length,
    scenarios: scenarioResults,
    metrics,
  };
}
