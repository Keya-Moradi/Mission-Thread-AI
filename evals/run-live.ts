import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createProviderFromEnv,
  IMPACT_ANALYSIS_SYSTEM_PROMPT,
  validateProviderOutput,
  type ModelInputProjection,
} from "@missionthread/core";
import {
  failedTestVerificationGapModelInput,
  insufficientEvidenceLowConfidenceModelInput,
  missingBudgetDataModelInput,
  promptInjectionAdversarialModelInput,
  promptInjectionBenignModelInput,
  supplierDelayMultiMilestoneModelInput,
} from "./fixtures/model-inputs";
import { writeJsonReport } from "./reporters";

// Entry point for `npm run eval:live` — NOT executed during Phase 6 (see
// docs/DECISIONS.md, "Phase 6: guarded live-evaluation command"). Phase 8
// ran the one authorized, sanitized live-evaluation run; see
// docs/EVAL_RESULTS.md.
//
// This script deliberately never calls runImpactAnalysis(). The
// live-evaluation runner never connects to, queries, or mutates the
// database: it calls the LLMProvider abstraction directly
// (createProviderFromEnv() -> provider.generateImpactAnalysis()) against
// six fixed, fictional, offline fixtures (the same ones evals/scenarios.ts
// uses for the mock suite's non-adversarial scenarios — the three
// scripted-adversarial-output scenarios test our own validator against a
// hand-mutated response and have nothing to learn from a real model call,
// so they're intentionally excluded here). Every response is still run
// through the production validateProviderOutput() before being reported.
// No retry beyond a single attempt per fixture — the orchestrator's
// production one-retry-on-validation-failure policy is not replicated
// here, since replicating it would double this script's already-capped
// worst-case call count for what is meant to be a small, bounded sanity
// check, not a full pipeline exercise.
//
// Note: the @missionthread/core import above does construct an unconnected
// PrismaClient as a module-load side effect (packages/core/src/db.ts's
// `export const prisma = ...` runs eagerly on import of the root barrel) —
// but constructing that object opens no network connection and issues no
// query on its own. No query or connection is ever initiated by this
// script. See docs/DECISIONS.md, "Live-eval Prisma import-boundary
// wording."
const LIVE_EVAL_FIXTURES: { id: string; modelInput: ModelInputProjection }[] = [
  { id: "supplier-delay-multi-milestone", modelInput: supplierDelayMultiMilestoneModelInput },
  { id: "failed-test-verification-gap", modelInput: failedTestVerificationGapModelInput },
  { id: "missing-budget-data", modelInput: missingBudgetDataModelInput },
  { id: "prompt-injection-benign", modelInput: promptInjectionBenignModelInput },
  { id: "prompt-injection-adversarial", modelInput: promptInjectionAdversarialModelInput },
  {
    id: "insufficient-evidence-low-confidence",
    modelInput: insufficientEvidenceLowConfidenceModelInput,
  },
];
const MAX_LIVE_PROVIDER_CALLS = LIVE_EVAL_FIXTURES.length;

/**
 * Fails closed on any missing opt-in — this is the only thing standing
 * between an accidental invocation and a real, billed provider call. All
 * three checks are exact-value comparisons (never a truthy check), the
 * same discipline packages/core/src/db-safety.ts uses for its own
 * destructive-operation opt-ins.
 */
function requireLiveOptIn(env: NodeJS.ProcessEnv): void {
  const missing: string[] = [];
  if (env.AI_MODE !== "live") missing.push('AI_MODE="live"');
  if (env.RUN_LIVE_EVALS !== "true") missing.push('RUN_LIVE_EVALS="true"');
  if (!env.OPENAI_API_KEY) missing.push("OPENAI_API_KEY");
  if (missing.length > 0) {
    throw new Error(
      `Refusing to run live evals — missing required opt-in: ${missing.join(", ")}. ` +
        "This command must never run automatically in tests, CI, or an ordinary development session; " +
        "it requires deliberately setting AI_MODE=live, RUN_LIVE_EVALS=true, and a real OPENAI_API_KEY.",
    );
  }
}

interface LiveScenarioResult {
  id: string;
  provider: string;
  model: string;
  durationMs: number;
  valid: boolean;
  category?: "INVALID_OUTPUT_SCHEMA" | "SEMANTIC_VALIDATION_FAILED";
  errorCount: number;
}

async function main(): Promise<void> {
  requireLiveOptIn(process.env);

  const provider = createProviderFromEnv();
  console.log(
    `Running ${MAX_LIVE_PROVIDER_CALLS} live evaluation call(s) against provider "${provider.name}" ` +
      "— this spends real provider credit.",
  );

  const results: LiveScenarioResult[] = [];
  for (const fixture of LIVE_EVAL_FIXTURES) {
    const traceId = randomUUID();
    // Never logs the prompt or the fixture's untrusted-notes text — only
    // safe, structural metadata, matching packages/core/src/ai/logging.ts's
    // own discipline.
    const response = await provider.generateImpactAnalysis({
      traceId,
      analysisRunId: `EVAL-LIVE-${traceId}`,
      attempt: 1,
      systemPrompt: IMPACT_ANALYSIS_SYSTEM_PROMPT,
      modelInput: fixture.modelInput,
    });
    const validation = validateProviderOutput(response.rawOutput, fixture.modelInput);
    const result: LiveScenarioResult = {
      id: fixture.id,
      provider: response.provider,
      model: response.model,
      durationMs: response.durationMs,
      valid: validation.valid,
      category: validation.valid ? undefined : validation.category,
      errorCount: validation.valid ? 0 : validation.errors.length,
    };
    results.push(result);
    console.log(
      `  [${validation.valid ? "VALID" : "INVALID"}] ${fixture.id} (${response.model}, ${response.durationMs}ms)` +
        (validation.valid ? "" : ` — ${result.category}, ${result.errorCount} error(s)`),
    );
  }

  const outputPath = join(dirname(fileURLToPath(import.meta.url)), ".output", "live-report.json");
  writeJsonReport(
    {
      generatedAt: new Date().toISOString(),
      provider: provider.name,
      totalCalls: results.length,
      validCount: results.filter((r) => r.valid).length,
      invalidCount: results.filter((r) => !r.valid).length,
      results,
    },
    outputPath,
  );
  console.log(`\nWrote machine-readable report to ${outputPath}`);
  console.log(
    "This command never auto-commits or auto-summarizes a result. Per docs/SPEC.md §13, only Phase 8's " +
      "one authorized live-eval run gets summarized (sanitized) in docs/EVAL_RESULTS.md — never paste raw " +
      "provider output beyond what these fictional fixtures already contain.",
  );

  if (results.some((r) => !r.valid)) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
