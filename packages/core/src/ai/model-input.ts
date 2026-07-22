import { z } from "zod";
import { evidenceRecordTypeSchema } from "../record-types";
import { EVIDENCE_LIMITS, type AnalysisEvidence } from "../analysis/evidence";

// Explicit bounds for every AnalysisEvidence collection that ISN'T already
// bounded by EVIDENCE_LIMITS (packages/core/src/analysis/evidence.ts) —
// impactedRequirements, impactedMilestones, verificationGaps, relatedDefects,
// riskScores, readinessScore.factors, assumptions, and unknowns are all
// plain, unbounded arrays on AnalysisEvidence. Reuses
// EVIDENCE_LIMITS.maxItemsPerRecordType (25) as the per-list cap instead of
// inventing a second, conflicting number for the same "how many of one kind
// of thing is reasonable" question — see docs/DECISIONS.md, "Model-input
// projection bounds reuse EVIDENCE_LIMITS".
export const MODEL_INPUT_LIMITS = {
  maxListItems: EVIDENCE_LIMITS.maxItemsPerRecordType,
  // Matches OUTPUT_LIMITS.maxAssumptions/maxUnknowns (output-schema.ts) —
  // kept numerically aligned so a provider that echoes the full supplied
  // list back is never rejected purely for exceeding the output schema's
  // own cap on a value that was already within the model-input's cap.
  maxAssumptions: 20,
  maxUnknowns: 20,
  maxReadinessFactors: 10,
  // Generous relative to what bounded fields above can actually produce
  // (evidence[] alone is capped at 100 items x 500 chars = ~50KB) — this is
  // a final safety net, not the primary bounding mechanism.
  maxSerializedBytes: 80_000,
} as const;

const eventFactsProjectionSchema = z
  .object({
    eventId: z.string().min(1),
    eventType: z.string().min(1),
    componentId: z.string().nullable(),
    supplierId: z.string().nullable(),
    originalDate: z.string().nullable(),
    revisedDate: z.string().nullable(),
    computedDelayDays: z.number().int().nullable(),
    storedDelayDays: z.number().int().nullable(),
    delayDaysConsistent: z.boolean().nullable(),
    confidence: z.string().nullable(),
    quantity: z.number().int().nullable(),
  })
  .strict();

const milestoneImpactProjectionSchema = z
  .object({
    milestoneId: z.string().min(1),
    status: z.string().min(1),
    relationship: z.enum(["direct", "dependency-derived"]),
  })
  .strict();

const verificationGapProjectionSchema = z
  .object({
    requirementId: z.string().min(1),
    gapCategory: z.string().min(1),
  })
  .strict();

const relatedDefectProjectionSchema = z
  .object({
    defectId: z.string().min(1),
    status: z.string().min(1),
    severity: z.string().min(1),
  })
  .strict();

const riskScoreProjectionSchema = z
  .object({
    riskId: z.string().min(1),
    score: z.number(),
    computedBand: z.string().min(1),
    status: z.string().min(1),
  })
  .strict();

const readinessFactorProjectionSchema = z
  .object({
    label: z.string().min(1),
    score: z.number(),
    detail: z.string().min(1),
  })
  .strict();

/**
 * The authoritative shape of a readiness result inside a model-input
 * projection — also reused, unchanged, as the persisted
 * ImpactAnalysis.readinessSnapshot content schema (see
 * attempt-persistence.ts), rather than inventing a second representation
 * for what is the same data at rest. See docs/DECISIONS.md, "Phase 4
 * correction: immutable readiness snapshot".
 */
export const readinessSnapshotSchema = z
  .object({
    totalScore: z.number().int(),
    factors: z.array(readinessFactorProjectionSchema).max(MODEL_INPUT_LIMITS.maxReadinessFactors),
  })
  .strict();

export type ReadinessSnapshot = z.infer<typeof readinessSnapshotSchema>;

const readinessScoreProjectionSchema = readinessSnapshotSchema.nullable();

const evidenceAllowlistItemSchema = z
  .object({
    recordId: z.string().min(1),
    recordType: evidenceRecordTypeSchema,
    summary: z.string(),
  })
  .strict();

/**
 * The only shape a provider ever receives — never the full AnalysisEvidence
 * object (see docs/DECISIONS.md, "Deferred Phase 4 constraint: bounded
 * model-input projection", recorded during Phase 3). Every field here is
 * either a structured deterministic fact, a deterministic calculation
 * result, an entry from the already-bounded evidence allowlist, or the two
 * explicitly-labeled untrusted free-text fields.
 */
export const modelInputProjectionSchema = z
  .object({
    eventFacts: eventFactsProjectionSchema,
    deterministicResults: z
      .object({
        affectedRequirementIds: z.array(z.string().min(1)).max(MODEL_INPUT_LIMITS.maxListItems),
        affectedMilestones: z
          .array(milestoneImpactProjectionSchema)
          .max(MODEL_INPUT_LIMITS.maxListItems),
        scheduleExposureDays: z.number().int().nullable(),
        budgetExposureAmount: z.string().nullable(),
        verificationGaps: z
          .array(verificationGapProjectionSchema)
          .max(MODEL_INPUT_LIMITS.maxListItems),
        relatedDefects: z.array(relatedDefectProjectionSchema).max(MODEL_INPUT_LIMITS.maxListItems),
        riskScores: z.array(riskScoreProjectionSchema).max(MODEL_INPUT_LIMITS.maxListItems),
        readinessScore: readinessScoreProjectionSchema,
        assumptions: z.array(z.string().min(1)).max(MODEL_INPUT_LIMITS.maxAssumptions),
        unknowns: z.array(z.string().min(1)).max(MODEL_INPUT_LIMITS.maxUnknowns),
      })
      .strict(),
    // Bounded by EVIDENCE_LIMITS already, at the point AnalysisEvidence was
    // built — passed through as-is, never re-serialized from a wider object.
    evidenceAllowlist: z.array(evidenceAllowlistItemSchema),
    // Explicitly labeled as data, never instructions — see the prompt in
    // prompts/impact-analysis-system.ts, which states this in the model's
    // own instructions, and prompts/impact-analysis-user.ts, which never
    // interpolates these values into surrounding prose.
    untrustedData: z
      .object({
        reason: z.string().nullable(),
        rawNotes: z.string().nullable(),
      })
      .strict(),
  })
  .strict();

export type ModelInputProjection = z.infer<typeof modelInputProjectionSchema>;

/**
 * Truncates an already-deterministically-ordered array to `max` items,
 * appending a warning to `warnings` instead of silently dropping the
 * remainder — mirrors applyEvidenceBounds()'s own truncation-notes pattern
 * in packages/core/src/analysis/evidence.ts.
 */
function boundList<T>(items: readonly T[], max: number, label: string, warnings: string[]): T[] {
  if (items.length <= max) return [...items];
  warnings.push(
    `More than ${max} ${label} were present; only the first ${max} (by deterministic order) are included in the model input.`,
  );
  return items.slice(0, max);
}

/**
 * Pure transform: AnalysisEvidence (packages/core/src/analysis/evidence.ts)
 * -> ModelInputProjection. Never serializes the full AnalysisEvidence object
 * — only structured facts, deterministic results, the pre-bounded evidence
 * allowlist, and the two isolated untrusted-text fields. Deterministic
 * ordering is preserved throughout (every source array here is already
 * sorted by its producing service); this function only truncates, it never
 * reorders.
 */
export function buildModelInputProjection(evidence: AnalysisEvidence): ModelInputProjection {
  const warnings: string[] = [];

  const affectedRequirementIds = boundList(
    [...evidence.impactedRequirements.map((r) => r.requirementId)].sort(),
    MODEL_INPUT_LIMITS.maxListItems,
    "affected requirement IDs",
    warnings,
  );

  const affectedMilestones = boundList(
    [...evidence.impactedMilestones]
      .sort((a, b) => a.milestoneId.localeCompare(b.milestoneId))
      .map((m) => ({ milestoneId: m.milestoneId, status: m.status, relationship: m.relationship })),
    MODEL_INPUT_LIMITS.maxListItems,
    "affected milestones",
    warnings,
  );

  const verificationGaps = boundList(
    (evidence.verificationGaps?.results ?? [])
      .filter((r) => r.gapCategory !== "NONE")
      .sort((a, b) => a.requirementId.localeCompare(b.requirementId))
      .map((r) => ({ requirementId: r.requirementId, gapCategory: r.gapCategory })),
    MODEL_INPUT_LIMITS.maxListItems,
    "verification gaps",
    warnings,
  );

  const relatedDefects = boundList(
    (evidence.relatedDefects?.results ?? [])
      .slice()
      .sort((a, b) => a.defectId.localeCompare(b.defectId))
      .map((d) => ({ defectId: d.defectId, status: d.status, severity: d.severity })),
    MODEL_INPUT_LIMITS.maxListItems,
    "related defects",
    warnings,
  );

  const riskScores = boundList(
    [...evidence.riskScores]
      .sort((a, b) => a.riskId.localeCompare(b.riskId))
      .map((r) => ({
        riskId: r.riskId,
        score: r.score,
        computedBand: r.computedBand,
        status: r.status,
      })),
    MODEL_INPUT_LIMITS.maxListItems,
    "risk scores",
    warnings,
  );

  const readinessScore = evidence.readinessScore
    ? {
        totalScore: evidence.readinessScore.totalScore,
        factors: boundList(
          evidence.readinessScore.factors.map((f) => ({
            label: f.label,
            score: f.score,
            detail: f.detail,
          })),
          MODEL_INPUT_LIMITS.maxReadinessFactors,
          "readiness factors",
          warnings,
        ),
      }
    : null;

  const assumptions = boundList(
    evidence.assumptions,
    MODEL_INPUT_LIMITS.maxAssumptions,
    "assumptions",
    warnings,
  );
  const unknowns = boundList(
    [...evidence.unknowns, ...warnings],
    MODEL_INPUT_LIMITS.maxUnknowns,
    "unknowns",
    // Bounding the unknowns list itself must not recurse into its own
    // warnings array — any overflow here is silently capped rather than
    // generating a note about a note.
    [],
  );

  return {
    eventFacts: {
      eventId: evidence.eventId,
      eventType: evidence.eventFacts.eventType,
      componentId: evidence.eventFacts.componentId,
      supplierId: evidence.eventFacts.supplierId,
      originalDate: evidence.eventFacts.originalDate,
      revisedDate: evidence.eventFacts.revisedDate,
      computedDelayDays: evidence.eventFacts.computedDelayDays,
      storedDelayDays: evidence.eventFacts.storedDelayDays,
      delayDaysConsistent: evidence.eventFacts.delayDaysConsistent,
      confidence: evidence.eventFacts.confidence,
      quantity: evidence.eventFacts.quantity,
    },
    deterministicResults: {
      affectedRequirementIds,
      affectedMilestones,
      scheduleExposureDays: evidence.scheduleExposure?.directDelayDays ?? null,
      budgetExposureAmount: evidence.budgetExposure?.totalDeterministicExposure ?? null,
      verificationGaps,
      relatedDefects,
      riskScores,
      readinessScore,
      assumptions,
      unknowns,
    },
    evidenceAllowlist: evidence.evidence.map((item) => ({
      recordId: item.recordId,
      recordType: item.recordType,
      summary: item.summary,
    })),
    untrustedData: {
      reason: evidence.untrustedText.reason,
      rawNotes: evidence.untrustedText.rawNotes,
    },
  };
}

export interface ModelInputSizeCheck {
  ok: boolean;
  sizeBytes: number;
  maxBytes: number;
}

/**
 * Final safety net before a provider call — every field above is already
 * individually bounded, but this catches the case where the combination is
 * still too large (or a future field is added without a bound) rather than
 * silently sending an oversized payload to a live provider.
 */
export function checkModelInputSize(projection: ModelInputProjection): ModelInputSizeCheck {
  const sizeBytes = Buffer.byteLength(JSON.stringify(projection), "utf8");
  return {
    ok: sizeBytes <= MODEL_INPUT_LIMITS.maxSerializedBytes,
    sizeBytes,
    maxBytes: MODEL_INPUT_LIMITS.maxSerializedBytes,
  };
}
