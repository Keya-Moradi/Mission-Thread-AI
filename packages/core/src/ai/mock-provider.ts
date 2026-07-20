import type { ModelInputProjection } from "./model-input";
import { OUTPUT_LIMITS, type ImpactAnalysisOutput } from "./output-schema";
import type { LLMProvider, LLMProviderRequest, LLMProviderResponse } from "./provider";

function normalizeConfidence(value: string | null): "LOW" | "MEDIUM" | "HIGH" {
  return value === "LOW" || value === "MEDIUM" || value === "HIGH" ? value : "MEDIUM";
}

function humanizeEventType(eventType: string): string {
  return eventType.replaceAll("_", " ").toLowerCase();
}

/**
 * Pure, deterministic transform: ModelInputProjection -> ImpactAnalysisOutput.
 * No network, no randomness, no clock-dependent content — the same input
 * always produces the same output. Every field is either copied verbatim
 * from a deterministic input value or built from a fixed template over
 * that data; nothing here invents a date, dollar amount, or record ID that
 * wasn't already in the supplied model input. Exported separately from the
 * MockLLMProvider class so prisma/seed.ts can call it directly to generate
 * the one seeded demonstration analysis without going through the full
 * provider/orchestrator machinery.
 */
export function generateMockImpactAnalysis(modelInput: ModelInputProjection): ImpactAnalysisOutput {
  const { eventFacts, deterministicResults } = modelInput;

  const delayDays = deterministicResults.scheduleExposureDays;
  const budgetAmount = deterministicResults.budgetExposureAmount;
  const milestoneCount = deterministicResults.affectedMilestones.length;
  const requirementCount = deterministicResults.affectedRequirementIds.length;
  const gapCount = deterministicResults.verificationGaps.length;
  const defectCount = deterministicResults.relatedDefects.length;

  const delayPhrase =
    delayDays !== null ? `a ${delayDays}-day schedule delay` : "no computed schedule delay";
  const executiveSummary =
    `This ${humanizeEventType(eventFacts.eventType)} event reports ${delayPhrase}` +
    `${eventFacts.componentId ? ` affecting component ${eventFacts.componentId}` : ""}` +
    `${eventFacts.supplierId ? ` from supplier ${eventFacts.supplierId}` : ""}, impacting ` +
    `${milestoneCount} milestone(s) and ${requirementCount} requirement(s), with ${gapCount} open ` +
    `verification gap(s) and ${defectCount} related defect(s) identified from the supplied evidence.`;

  const missionImpact =
    budgetAmount !== null
      ? `Budget exposure on the linked component totals ${budgetAmount}; schedule exposure is ` +
        `${delayDays ?? "unknown"} day(s) against the affected milestone set. Mitigation should be ` +
        `reviewed before the affected milestones proceed as currently planned.`
      : `No budget exposure could be determined from the supplied evidence; schedule exposure is ` +
        `${delayDays ?? "unknown"} day(s) against the affected milestone set.`;

  const allowlistIds = modelInput.evidenceAllowlist.map((item) => item.recordId);
  // Always at least one entry: buildAnalysisEvidence() always cites the
  // triggering PROGRAM_EVENT itself, so allowlistIds is never empty for any
  // real call — but guard anyway rather than assume.
  const topSourceRecordIds = (allowlistIds.length > 0 ? allowlistIds : [eventFacts.eventId]).slice(
    0,
    OUTPUT_LIMITS.maxSourceRecordIds,
  );
  const optionSourceRecordIds = topSourceRecordIds.slice(0, OUTPUT_LIMITS.maxOptionSourceRecordIds);

  const affectedMilestoneIds = deterministicResults.affectedMilestones.map((m) => m.milestoneId);
  const milestoneList =
    affectedMilestoneIds.length > 0 ? affectedMilestoneIds.join(", ") : "none identified";

  const verificationGaps = deterministicResults.verificationGaps
    .slice(0, OUTPUT_LIMITS.maxVerificationGaps)
    .map((gap) => ({
      requirementId: gap.requirementId,
      category: gap.gapCategory,
      summary: `Requirement ${gap.requirementId} has a ${gap.gapCategory} verification gap.`,
    }));

  return {
    executiveSummary,
    missionImpact,
    scheduleExposureDays: delayDays,
    budgetExposureAmount: budgetAmount,
    affectedRequirementIds: deterministicResults.affectedRequirementIds.slice(
      0,
      OUTPUT_LIMITS.maxAffectedIds,
    ),
    affectedMilestoneIds: affectedMilestoneIds.slice(0, OUTPUT_LIMITS.maxAffectedIds),
    verificationGaps,
    assumptions: deterministicResults.assumptions.slice(0, OUTPUT_LIMITS.maxAssumptions),
    unknowns: deterministicResults.unknowns.slice(0, OUTPUT_LIMITS.maxUnknowns),
    confidence: normalizeConfidence(eventFacts.confidence),
    sourceRecordIds: topSourceRecordIds,
    mitigationOptions: [
      {
        title: "Prioritize the critical path with available supply",
        description:
          `Allocate the available quantity from this ${humanizeEventType(eventFacts.eventType)} ` +
          `toward the highest-priority affected milestone(s) first (${milestoneList}), deferring ` +
          `lower-priority allocation until the underlying constraint resolves.`,
        tradeoffs:
          "Concentrates limited supply on the critical path but may delay other, lower-priority work that depends on the same component.",
        costImpact: null,
        scheduleImpact: null,
        isRecommended: true,
        sourceRecordIds: optionSourceRecordIds,
      },
      {
        title: "Resequence unaffected downstream work",
        description:
          "Reorder engineering and test activities for milestones that do not depend on the delayed " +
          "item so schedule pressure elsewhere is reduced while the underlying issue is resolved.",
        tradeoffs:
          "Requires cross-team coordination to resequence work, and does not by itself reduce the underlying delay.",
        costImpact: null,
        scheduleImpact: null,
        isRecommended: false,
        sourceRecordIds: optionSourceRecordIds,
      },
      {
        title: "Accept the full slip and reset dependent milestones",
        description:
          `Formally accept ${delayPhrase} and update the planned dates of the affected milestone(s) ` +
          `(${milestoneList}) to reflect the revised schedule.`,
        tradeoffs:
          "Simplest to execute and most transparent to stakeholders, but confirms the schedule slip rather than attempting to recover any of it.",
        costImpact: null,
        scheduleImpact: delayDays,
        isRecommended: false,
        sourceRecordIds: optionSourceRecordIds,
      },
    ],
  };
}

/**
 * Deterministic, no-network, no-API-key provider — the default for
 * AI_MODE=mock (required in CI and for demos). Every call with the same
 * modelInput produces byte-identical rawOutput; only the caller-supplied
 * traceId/analysisRunId/attempt (which never appear in rawOutput) vary
 * between calls.
 */
export class MockLLMProvider implements LLMProvider {
  readonly name = "mock";

  async generateImpactAnalysis(request: LLMProviderRequest): Promise<LLMProviderResponse> {
    const startedAt = Date.now();
    const rawOutput = generateMockImpactAnalysis(request.modelInput);
    return {
      provider: this.name,
      model: "mock-deterministic-v1",
      rawOutput,
      durationMs: Date.now() - startedAt,
    };
  }
}
