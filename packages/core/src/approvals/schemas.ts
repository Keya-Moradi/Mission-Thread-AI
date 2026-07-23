import { z } from "zod";
import { entityIdSchema } from "../analysis/schemas";
import { dateOnlySchema } from "../events/schemas";
import { persistedMoneyStringSchema } from "../ai/output-schema";

// Documented, deliberately generous-but-bounded limits — same discipline as
// packages/core/src/ai/output-schema.ts's OUTPUT_LIMITS and
// packages/core/src/events/schemas.ts's MAX_REASON_LENGTH: chosen so a real
// rationale/action is never truncated mid-sentence, while still rejecting an
// oversized or adversarial submission before it's persisted.
export const RATIONALE_MIN_LENGTH = 10;
export const RATIONALE_MAX_LENGTH = 2000;
export const MAX_PROPOSED_CHANGES_PER_DECISION = 10;
export const NEW_ACTION_TITLE_MAX_LENGTH = 200;
export const NEW_ACTION_DESCRIPTION_MAX_LENGTH = 2000;
/** Conventional probability/impact range this program uses — see
 * packages/core/src/analysis/risk.ts's own documented 1-5 convention and
 * MAX_RISK_SCORE (5x5=25). Not a database constraint (Risk.probability/
 * impact are plain Int columns), enforced here at the input boundary. */
export const MIN_RISK_PROBABILITY_IMPACT = 1;
export const MAX_RISK_PROBABILITY_IMPACT = 5;

/**
 * Required for every decision — approve, reject, and request-revision all
 * need a documented human reason. See docs/DECISIONS.md, "Phase 5 decision
 * validation contract".
 */
export const rationaleSchema = z
  .string()
  .trim()
  .min(RATIONALE_MIN_LENGTH)
  .max(RATIONALE_MAX_LENGTH);

// Mirrors the Prisma RiskStatus/RiskSeverity enums (packages/core/prisma/
// schema.prisma) — same "one Prisma enum, Zod validates the allowed subset
// at the application boundary" discipline as record-types.ts, here simply
// because RISK_UPDATE is the only caller that needs these as an input
// contract rather than a read-side allowlist.
export const RISK_STATUSES = ["OPEN", "MITIGATING", "CLOSED"] as const;
export const riskStatusSchema = z.enum(RISK_STATUSES);
export const RISK_SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export const riskSeveritySchema = z.enum(RISK_SEVERITIES);

/**
 * One proposed change per allowed changeType (SPEC.md-derived, see
 * docs/DECISIONS.md "Phase 5: resolved ProposedChangeType.NEW_ACTION
 * target-field conflict"). This is the *client-submitted* shape only — the
 * server never trusts targetRecordType, oldValue, or newValue from the
 * caller; see packages/core/src/approvals/snapshot.ts for how the
 * authoritative ProposedChange row is actually constructed from these
 * validated inputs.
 */
export const milestoneDateProposedChangeInputSchema = z
  .object({
    changeType: z.literal("MILESTONE_DATE"),
    targetRecordId: entityIdSchema,
    // The proposed new value for Milestone.currentDate (distinct from
    // Milestone.plannedDate, which this workflow never changes).
    currentDate: dateOnlySchema,
  })
  .strict();

export const riskUpdateProposedChangeInputSchema = z
  .object({
    changeType: z.literal("RISK_UPDATE"),
    targetRecordId: entityIdSchema,
    status: riskStatusSchema.optional(),
    severity: riskSeveritySchema.optional(),
    probability: z
      .number()
      .int()
      .min(MIN_RISK_PROBABILITY_IMPACT)
      .max(MAX_RISK_PROBABILITY_IMPACT)
      .optional(),
    impact: z
      .number()
      .int()
      .min(MIN_RISK_PROBABILITY_IMPACT)
      .max(MAX_RISK_PROBABILITY_IMPACT)
      .optional(),
  })
  .strict()
  .refine(
    (data) =>
      data.status !== undefined ||
      data.severity !== undefined ||
      data.probability !== undefined ||
      data.impact !== undefined,
    {
      message: "at least one of status, severity, probability, impact must be proposed",
      path: ["status"],
    },
  );

export const budgetUpdateProposedChangeInputSchema = z
  .object({
    changeType: z.literal("BUDGET_UPDATE"),
    targetRecordId: entityIdSchema,
    plannedAmount: persistedMoneyStringSchema.optional(),
    actualAmount: persistedMoneyStringSchema.optional(),
  })
  .strict()
  .refine((data) => data.plannedAmount !== undefined || data.actualAmount !== undefined, {
    message: "at least one of plannedAmount, actualAmount must be proposed",
    path: ["plannedAmount"],
  });

/**
 * NEW_ACTION has no existing record to target — targetRecordId/
 * targetRecordType are required literal nulls (not omitted) so every
 * proposed-change input shape explicitly states its target, rather than
 * three of the four variants having the field and one silently lacking it.
 */
export const newActionProposedChangeInputSchema = z
  .object({
    changeType: z.literal("NEW_ACTION"),
    targetRecordId: z.null(),
    targetRecordType: z.null(),
    title: z.string().trim().min(1).max(NEW_ACTION_TITLE_MAX_LENGTH),
    description: z.string().trim().min(1).max(NEW_ACTION_DESCRIPTION_MAX_LENGTH),
    dueDate: dateOnlySchema.nullable(),
  })
  .strict();

export const proposedChangeInputSchema = z.discriminatedUnion("changeType", [
  milestoneDateProposedChangeInputSchema,
  riskUpdateProposedChangeInputSchema,
  budgetUpdateProposedChangeInputSchema,
  newActionProposedChangeInputSchema,
]);

export type MilestoneDateProposedChangeInput = z.infer<
  typeof milestoneDateProposedChangeInputSchema
>;
export type RiskUpdateProposedChangeInput = z.infer<typeof riskUpdateProposedChangeInputSchema>;
export type BudgetUpdateProposedChangeInput = z.infer<typeof budgetUpdateProposedChangeInputSchema>;
export type NewActionProposedChangeInput = z.infer<typeof newActionProposedChangeInputSchema>;
export type ProposedChangeInput = z.infer<typeof proposedChangeInputSchema>;

/**
 * The full decision-input contract: a strict discriminated union keyed by
 * `verdict`. Only APPROVED accepts `proposedChanges` (and requires at least
 * one); REJECTED/REVISION_REQUESTED reject the key entirely via `.strict()`.
 * actorUserId, role, analysisId, programId, status, traceId, and every
 * server-generated snapshot value are never fields of this schema at all —
 * they can never be supplied by a caller because there's nowhere in this
 * shape to put them. See docs/DECISIONS.md, "Phase 5 decision validation
 * contract".
 */
const approvedDecisionInputSchema = z
  .object({
    verdict: z.literal("APPROVED"),
    mitigationOptionId: entityIdSchema,
    rationale: rationaleSchema,
    proposedChanges: z
      .array(proposedChangeInputSchema)
      .min(1, "an approval must include at least one proposed change")
      .max(MAX_PROPOSED_CHANGES_PER_DECISION),
  })
  .strict();

const rejectedDecisionInputSchema = z
  .object({
    verdict: z.literal("REJECTED"),
    mitigationOptionId: entityIdSchema,
    rationale: rationaleSchema,
  })
  .strict();

const revisionRequestedDecisionInputSchema = z
  .object({
    verdict: z.literal("REVISION_REQUESTED"),
    mitigationOptionId: entityIdSchema,
    rationale: rationaleSchema,
  })
  .strict();

export const recordDecisionInputSchema = z.discriminatedUnion("verdict", [
  approvedDecisionInputSchema,
  rejectedDecisionInputSchema,
  revisionRequestedDecisionInputSchema,
]);

export type ApprovedDecisionInput = z.infer<typeof approvedDecisionInputSchema>;
export type RejectedDecisionInput = z.infer<typeof rejectedDecisionInputSchema>;
export type RevisionRequestedDecisionInput = z.infer<typeof revisionRequestedDecisionInputSchema>;
export type RecordDecisionInput = z.infer<typeof recordDecisionInputSchema>;

/**
 * The server must not trust a hidden Boolean for an irreversible apply — the
 * caller has to submit this exact string. See docs/DECISIONS.md, "Phase 5
 * explicit apply confirmation".
 */
export const APPLY_CONFIRMATION_VALUE = "APPLY";
export const applyConfirmationSchema = z.literal(APPLY_CONFIRMATION_VALUE);

export function formatApprovalsZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}
