import type { ModelInputProjection } from "./model-input";
import type { ImpactAnalysisOutput } from "./output-schema";

export interface SemanticValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Second validation stage, beyond Zod structural validation
 * (output-schema.ts): checks the output's claims against the request's own
 * model input, which a JSON-schema/Zod check alone cannot do. Every rule
 * here is an exact-match-or-subset-of-the-allowlist check — an ID is never
 * accepted merely because it *looks* like a real ID (matches the repo's
 * naming convention); it must actually appear in the evidence this specific
 * request supplied. See docs/DECISIONS.md, "Phase 4 semantic validation".
 */
export function validateImpactAnalysisSemantics(
  output: ImpactAnalysisOutput,
  modelInput: ModelInputProjection,
): SemanticValidationResult {
  const errors: string[] = [];

  const allowlistIds = new Set(modelInput.evidenceAllowlist.map((item) => item.recordId));
  const requirementIdsInAllowlist = new Set(
    modelInput.evidenceAllowlist
      .filter((item) => item.recordType === "REQUIREMENT")
      .map((item) => item.recordId),
  );
  const milestoneIdsInAllowlist = new Set(
    modelInput.evidenceAllowlist
      .filter((item) => item.recordType === "MILESTONE")
      .map((item) => item.recordId),
  );

  // (a) every sourceRecordIds entry — top-level and per-option — must exist
  // in the evidence allowlist this request actually supplied.
  for (const id of output.sourceRecordIds) {
    if (!allowlistIds.has(id)) {
      errors.push(
        `sourceRecordIds cites "${id}", which is not in the supplied evidence allowlist.`,
      );
    }
  }
  for (const option of output.mitigationOptions) {
    for (const id of option.sourceRecordIds) {
      if (!allowlistIds.has(id)) {
        errors.push(
          `Mitigation option "${option.title}" cites "${id}", which is not in the supplied evidence allowlist.`,
        );
      }
    }
  }

  // (b) affected requirement/milestone IDs must exist as evidence of the
  // matching record type — a milestone ID in affectedRequirementIds (or vice
  // versa) is rejected even if that ID exists somewhere in the allowlist
  // under the other type.
  for (const id of output.affectedRequirementIds) {
    if (!requirementIdsInAllowlist.has(id)) {
      errors.push(
        `affectedRequirementIds includes "${id}", which is not a REQUIREMENT in the evidence allowlist.`,
      );
    }
  }
  for (const id of output.affectedMilestoneIds) {
    if (!milestoneIdsInAllowlist.has(id)) {
      errors.push(
        `affectedMilestoneIds includes "${id}", which is not a MILESTONE in the evidence allowlist.`,
      );
    }
  }
  for (const gap of output.verificationGaps) {
    if (!requirementIdsInAllowlist.has(gap.requirementId)) {
      errors.push(
        `verificationGaps references requirement "${gap.requirementId}", which is not a REQUIREMENT in the evidence allowlist.`,
      );
    }
  }

  // (c) deterministic equality — the model may never report a schedule or
  // budget exposure number that disagrees with the deterministic value
  // packages/core already computed. scheduleExposureDays maps to
  // ScheduleExposureResult.directDelayDays; budgetExposureAmount maps to
  // BudgetExposureResult.totalDeterministicExposure — see
  // docs/DECISIONS.md, "Phase 4 deterministic equality mapping", for why
  // these specific fields (not currentVarianceTotal or storedDelayDays)
  // were chosen. The *deterministic* value is always what gets persisted,
  // never the model's own copy of it, even when they agree.
  if (output.scheduleExposureDays !== modelInput.deterministicResults.scheduleExposureDays) {
    errors.push(
      `scheduleExposureDays (${output.scheduleExposureDays}) does not match the deterministic value (${modelInput.deterministicResults.scheduleExposureDays}).`,
    );
  }
  if (output.budgetExposureAmount !== modelInput.deterministicResults.budgetExposureAmount) {
    errors.push(
      `budgetExposureAmount (${output.budgetExposureAmount}) does not match the deterministic value (${modelInput.deterministicResults.budgetExposureAmount}).`,
    );
  }

  // Duplicate-ID checks — a duplicate citation would let one record
  // silently carry more apparent weight without adding new information,
  // matching the same rule SourceReference's own DB uniqueness constraint
  // enforces at persistence time.
  if (new Set(output.sourceRecordIds).size !== output.sourceRecordIds.length) {
    errors.push("sourceRecordIds contains duplicate entries.");
  }
  if (new Set(output.affectedRequirementIds).size !== output.affectedRequirementIds.length) {
    errors.push("affectedRequirementIds contains duplicate entries.");
  }
  if (new Set(output.affectedMilestoneIds).size !== output.affectedMilestoneIds.length) {
    errors.push("affectedMilestoneIds contains duplicate entries.");
  }
  for (const option of output.mitigationOptions) {
    if (new Set(option.sourceRecordIds).size !== option.sourceRecordIds.length) {
      errors.push(`Mitigation option "${option.title}" has duplicate sourceRecordIds entries.`);
    }
  }

  return { valid: errors.length === 0, errors };
}
