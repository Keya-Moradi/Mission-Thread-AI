import type { z } from "zod";
import { evidenceRecordTypeSchema } from "../record-types";
import type { ModelInputProjection } from "./model-input";
import type { ImpactAnalysisOutput } from "./output-schema";

export interface AttemptSourceReferenceInput {
  recordId: string;
  recordType: z.infer<typeof evidenceRecordTypeSchema>;
  summary: string;
  wasCited: boolean;
  /** Bounded, fixed-vocabulary strings only — "analysis" or "option:<index>" — never model text. */
  citationContexts: string[];
}

/**
 * Pure builder: every allowlisted evidence item supplied to an attempt,
 * exactly once, with citation metadata attached when `output` is supplied.
 * Called twice per successful attempt with the SAME modelInput: once before
 * the provider call (no `output` — every item wasCited:false, the complete
 * "supplied" snapshot to persist up front) and once after a validated
 * response (`output` present — marks which items were actually cited and in
 * which context). A failed attempt only ever gets the first call, so its
 * persisted rows correctly stay wasCited:false throughout — see
 * docs/DECISIONS.md, "Phase 4 correction: complete attempt-evidence
 * persistence".
 *
 * `output` must already have passed semantic validation
 * (output-validation.ts) before being passed here — that step is what
 * guarantees every citation actually resolves to an allowlist entry. This
 * function still defensively verifies that invariant (never silently
 * ignoring a citation that doesn't resolve) rather than assuming it.
 */
export function buildAttemptSourceReferenceSnapshot(
  modelInput: ModelInputProjection,
  output?: ImpactAnalysisOutput,
): AttemptSourceReferenceInput[] {
  const contextsByRecordId = new Map<string, string[]>();

  if (output) {
    for (const id of output.sourceRecordIds) {
      const contexts = contextsByRecordId.get(id) ?? [];
      contexts.push("analysis");
      contextsByRecordId.set(id, contexts);
    }
    output.mitigationOptions.forEach((option, index) => {
      for (const id of option.sourceRecordIds) {
        const contexts = contextsByRecordId.get(id) ?? [];
        contexts.push(`option:${index}`);
        contextsByRecordId.set(id, contexts);
      }
    });

    const allowlistIds = new Set(modelInput.evidenceAllowlist.map((item) => item.recordId));
    const unresolvedCitations = [...contextsByRecordId.keys()].filter(
      (id) => !allowlistIds.has(id),
    );
    if (unresolvedCitations.length > 0) {
      // Should be unreachable in practice — output-validation.ts already
      // rejects any output with a citation outside the allowlist before it
      // ever reaches this function. Failing loudly here, rather than
      // silently dropping the unresolved IDs, is a defensive invariant
      // check: it would surface a real bug in the calling order rather
      // than persisting a citation this snapshot can't actually attribute
      // to a real evidence record.
      throw new Error(
        `buildAttemptSourceReferenceSnapshot received output citing IDs not in the evidence allowlist: ${unresolvedCitations.join(", ")}.`,
      );
    }
  }

  // Deterministic ordering preserved from modelInput.evidenceAllowlist,
  // which is itself already deterministically ordered (see
  // buildModelInputProjection()) — this function only maps, never re-sorts.
  return modelInput.evidenceAllowlist.map((item) => {
    const recordType = evidenceRecordTypeSchema.parse(item.recordType);
    const contexts = contextsByRecordId.get(item.recordId) ?? [];
    return {
      recordId: item.recordId,
      recordType,
      // Trusted, already-bounded evidence summaries only — never
      // untrustedData, never raw provider/model text.
      summary: item.summary,
      wasCited: contexts.length > 0,
      citationContexts: contexts,
    };
  });
}

export interface SucceededAttemptData {
  status: "SUCCEEDED";
  validationPassed: true;
  executiveSummary: string;
  missionImpact: string;
  scheduleExposureDays: number | null;
  budgetExposureAmount: string | null;
  readinessSnapshot: ModelInputProjection["deterministicResults"]["readinessScore"];
  verificationGaps: ImpactAnalysisOutput["verificationGaps"];
  assumptions: string[];
  unknowns: string[];
  confidence: ImpactAnalysisOutput["confidence"];
}

/**
 * Pure builder for a successful attempt's ImpactAnalysis update payload.
 * Deterministic values (scheduleExposureDays, budgetExposureAmount,
 * readinessSnapshot) are always read from modelInput.deterministicResults —
 * never from the model's own copy in `output` — even though semantic
 * validation has already confirmed the schedule/budget figures agree. The
 * model is never the source of truth for a deterministic calculation, and
 * readiness specifically has no model-supplied copy to begin with: it's
 * never part of the output schema, only ever the application's own
 * already-computed value, persisted as-is and never recalculated on
 * read — see docs/DECISIONS.md, "Phase 4 correction: immutable readiness
 * snapshot". Kept pure and exported so both cases (a real readiness value,
 * and readiness genuinely unavailable -> null) are directly unit-testable
 * without a database.
 */
export function buildSucceededImpactAnalysisData(
  output: ImpactAnalysisOutput,
  modelInput: ModelInputProjection,
): SucceededAttemptData {
  return {
    status: "SUCCEEDED",
    validationPassed: true,
    executiveSummary: output.executiveSummary,
    missionImpact: output.missionImpact,
    scheduleExposureDays: modelInput.deterministicResults.scheduleExposureDays,
    budgetExposureAmount: modelInput.deterministicResults.budgetExposureAmount,
    readinessSnapshot: modelInput.deterministicResults.readinessScore,
    verificationGaps: output.verificationGaps,
    assumptions: output.assumptions,
    unknowns: output.unknowns,
    confidence: output.confidence,
  };
}
