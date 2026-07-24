import { z } from "zod";
import { entityIdSchema } from "../analysis/schemas";
import { dateOnlySchema } from "../events/schemas";
import { persistedMoneyStringSchema } from "../ai/output-schema";
import {
  riskStatusSchema,
  riskSeveritySchema,
  MIN_RISK_PROBABILITY_IMPACT,
  MAX_RISK_PROBABILITY_IMPACT,
  NEW_ACTION_TITLE_MAX_LENGTH,
  NEW_ACTION_DESCRIPTION_MAX_LENGTH,
} from "./schemas";

/**
 * Strict schemas for what a persisted `ProposedChange` row's `oldValue`/
 * `newValue` JSON must actually contain, keyed by `changeType` — the
 * defensive boundary `applyApprovedChanges()` revalidates against
 * immediately before staleness checking and domain mutation. Decision-time
 * validation (`schemas.ts`'s `proposedChangeInputSchema`,
 * `snapshot.ts`'s `buildProposedChangeSnapshot()`) is the normal boundary
 * for what gets written in the first place; this is the fail-closed check
 * for what actually comes back out of the database at apply time — a
 * stored row could in principle be malformed (a bug in an earlier version
 * of this code, a direct database edit, a future migration gap), and the
 * apply transaction must never trust a TypeScript type or a non-null
 * assertion as a substitute for verifying that at runtime. See
 * docs/DECISIONS.md, "Phase 5 correction: apply-time persisted-snapshot
 * revalidation".
 */

const persistedMilestoneDateValueSchema = z.object({ currentDate: dateOnlySchema }).strict();

export const persistedMilestoneDateChangeSchema = z.object({
  targetRecordId: entityIdSchema,
  targetRecordType: z.literal("MILESTONE"),
  oldValue: persistedMilestoneDateValueSchema,
  newValue: persistedMilestoneDateValueSchema,
});

const persistedRiskFieldsSchema = z
  .object({
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
  .strict();

/**
 * `oldValue`/`newValue` must carry the identical non-empty key set — the
 * same "captured value and proposed value describe the same fields"
 * invariant `buildProposedChangeSnapshot()` establishes when the row is
 * first written, reverified here rather than assumed still true.
 */
function requireMatchingNonEmptyKeySets(
  ctx: z.RefinementCtx,
  oldValue: Record<string, unknown>,
  newValue: Record<string, unknown>,
): void {
  const oldKeys = Object.keys(oldValue).sort();
  const newKeys = Object.keys(newValue).sort();
  if (oldKeys.length === 0) {
    ctx.addIssue({
      code: "custom",
      message: "oldValue must have at least one field",
      path: ["oldValue"],
    });
    return;
  }
  if (oldKeys.join(",") !== newKeys.join(",")) {
    ctx.addIssue({
      code: "custom",
      message: "oldValue and newValue must carry the identical set of fields",
      path: ["newValue"],
    });
  }
}

export const persistedRiskUpdateChangeSchema = z
  .object({
    targetRecordId: entityIdSchema,
    targetRecordType: z.literal("RISK"),
    oldValue: persistedRiskFieldsSchema,
    newValue: persistedRiskFieldsSchema,
  })
  .superRefine((data, ctx) => requireMatchingNonEmptyKeySets(ctx, data.oldValue, data.newValue));

const persistedBudgetFieldsSchema = z
  .object({
    plannedAmount: persistedMoneyStringSchema.optional(),
    actualAmount: persistedMoneyStringSchema.optional(),
  })
  .strict();

export const persistedBudgetUpdateChangeSchema = z
  .object({
    targetRecordId: entityIdSchema,
    targetRecordType: z.literal("BUDGET_ITEM"),
    oldValue: persistedBudgetFieldsSchema,
    newValue: persistedBudgetFieldsSchema,
  })
  .superRefine((data, ctx) => requireMatchingNonEmptyKeySets(ctx, data.oldValue, data.newValue));

const persistedNewActionValueSchema = z
  .object({
    title: z.string().trim().min(1).max(NEW_ACTION_TITLE_MAX_LENGTH),
    description: z.string().trim().min(1).max(NEW_ACTION_DESCRIPTION_MAX_LENGTH),
    dueDate: dateOnlySchema.nullable(),
  })
  .strict();

export const persistedNewActionChangeSchema = z.object({
  targetRecordId: z.null(),
  targetRecordType: z.null(),
  oldValue: z.object({}).strict(),
  newValue: persistedNewActionValueSchema,
});

export type PersistedMilestoneDateChange = z.infer<typeof persistedMilestoneDateChangeSchema>;
export type PersistedRiskUpdateChange = z.infer<typeof persistedRiskUpdateChangeSchema>;
export type PersistedBudgetUpdateChange = z.infer<typeof persistedBudgetUpdateChangeSchema>;
export type PersistedNewActionChange = z.infer<typeof persistedNewActionChangeSchema>;

export type PersistedProposedChange =
  | ({ changeType: "MILESTONE_DATE" } & PersistedMilestoneDateChange)
  | ({ changeType: "RISK_UPDATE" } & PersistedRiskUpdateChange)
  | ({ changeType: "BUDGET_UPDATE" } & PersistedBudgetUpdateChange)
  | ({ changeType: "NEW_ACTION" } & PersistedNewActionChange);

export type PersistedProposedChangeParseResult =
  { ok: true; data: PersistedProposedChange } | { ok: false; message: string };

/**
 * Parses one stored `ProposedChange` row against the schema its
 * `changeType` requires. Never throws — every failure (an unrecognized
 * `changeType`, a wrong `targetRecordType`, a malformed `oldValue`/
 * `newValue`, a key-set mismatch) becomes a safe `{ ok: false, message }`
 * result, never a raw Zod error or the row's own untrusted JSON content.
 */
export function parsePersistedProposedChange(row: {
  changeType: string;
  targetRecordId: string | null;
  targetRecordType: string | null;
  oldValue: unknown;
  newValue: unknown;
}): PersistedProposedChangeParseResult {
  switch (row.changeType) {
    case "MILESTONE_DATE": {
      const result = persistedMilestoneDateChangeSchema.safeParse(row);
      if (!result.success) {
        return { ok: false, message: "stored MILESTONE_DATE proposed change is malformed" };
      }
      return { ok: true, data: { changeType: "MILESTONE_DATE", ...result.data } };
    }
    case "RISK_UPDATE": {
      const result = persistedRiskUpdateChangeSchema.safeParse(row);
      if (!result.success) {
        return { ok: false, message: "stored RISK_UPDATE proposed change is malformed" };
      }
      return { ok: true, data: { changeType: "RISK_UPDATE", ...result.data } };
    }
    case "BUDGET_UPDATE": {
      const result = persistedBudgetUpdateChangeSchema.safeParse(row);
      if (!result.success) {
        return { ok: false, message: "stored BUDGET_UPDATE proposed change is malformed" };
      }
      return { ok: true, data: { changeType: "BUDGET_UPDATE", ...result.data } };
    }
    case "NEW_ACTION": {
      const result = persistedNewActionChangeSchema.safeParse(row);
      if (!result.success) {
        return { ok: false, message: "stored NEW_ACTION proposed change is malformed" };
      }
      return { ok: true, data: { changeType: "NEW_ACTION", ...result.data } };
    }
    default:
      return { ok: false, message: "stored proposed change has an unrecognized changeType" };
  }
}
