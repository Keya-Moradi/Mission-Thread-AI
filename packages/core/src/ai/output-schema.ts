import { z } from "zod";

// Documented, deliberately generous-but-bounded limits — chosen so a real
// executive summary/mitigation option is never truncated mid-sentence, while
// still rejecting a runaway or adversarial response before it's persisted.
// Independent of MODEL_INPUT_LIMITS (model-input.ts), which bounds what goes
// INTO a request, not what a provider is allowed to return.
export const OUTPUT_LIMITS = {
  maxExecutiveSummaryLength: 1000,
  maxMissionImpactLength: 1000,
  maxAffectedIds: 25,
  maxVerificationGaps: 25,
  maxGapSummaryLength: 300,
  maxAssumptions: 20,
  maxUnknowns: 20,
  maxSourceRecordIds: 30,
  maxOptionTitleLength: 150,
  maxOptionDescriptionLength: 800,
  maxOptionTradeoffsLength: 500,
  maxOptionSourceRecordIds: 10,
} as const;

/**
 * Fixed-2-decimal monetary string ("480000.00"), matching how
 * calculateBudgetExposure() (packages/core/src/analysis/budget.ts) already
 * serializes Prisma.Decimal totals — never a bare number (float rounding)
 * and never a currency-symbol-prefixed string.
 */
const moneyStringSchema = z
  .string()
  .regex(/^\d+\.\d{2}$/, 'must be a fixed two-decimal monetary string, e.g. "480000.00"');

const nonEmptyTrimmedString = (max: number) => z.string().trim().min(1).max(max);

const mitigationOptionOutputSchema = z
  .object({
    title: nonEmptyTrimmedString(OUTPUT_LIMITS.maxOptionTitleLength),
    description: nonEmptyTrimmedString(OUTPUT_LIMITS.maxOptionDescriptionLength),
    tradeoffs: nonEmptyTrimmedString(OUTPUT_LIMITS.maxOptionTradeoffsLength),
    costImpact: moneyStringSchema.nullable(),
    scheduleImpact: z.number().int().nullable(),
    isRecommended: z.boolean(),
    sourceRecordIds: z
      .array(z.string().min(1))
      .min(1, "each mitigation option must cite at least one source record")
      .max(OUTPUT_LIMITS.maxOptionSourceRecordIds),
  })
  .strict();

export type MitigationOptionOutput = z.infer<typeof mitigationOptionOutputSchema>;

const verificationGapOutputSchema = z
  .object({
    requirementId: z.string().min(1),
    category: z.string().min(1),
    summary: nonEmptyTrimmedString(OUTPUT_LIMITS.maxGapSummaryLength),
  })
  .strict();

/**
 * The authoritative shape every provider's output is validated against —
 * mock and live alike. Structural validation only (Zod); source-ID/
 * deterministic-value/completeness checks are a second, semantic pass in
 * output-validation.ts, since Zod alone can't check a value against the
 * request's own model input. `.strict()` everywhere (no extra keys) and no
 * optional fields (nullable instead) — both required for the live provider's
 * strict JSON-schema structured output (see openai-provider.ts).
 */
export const impactAnalysisOutputSchema = z
  .object({
    executiveSummary: nonEmptyTrimmedString(OUTPUT_LIMITS.maxExecutiveSummaryLength),
    missionImpact: nonEmptyTrimmedString(OUTPUT_LIMITS.maxMissionImpactLength),
    scheduleExposureDays: z.number().int().nullable(),
    budgetExposureAmount: moneyStringSchema.nullable(),
    affectedRequirementIds: z.array(z.string().min(1)).max(OUTPUT_LIMITS.maxAffectedIds),
    affectedMilestoneIds: z.array(z.string().min(1)).max(OUTPUT_LIMITS.maxAffectedIds),
    verificationGaps: z.array(verificationGapOutputSchema).max(OUTPUT_LIMITS.maxVerificationGaps),
    assumptions: z.array(z.string().trim().min(1)).max(OUTPUT_LIMITS.maxAssumptions),
    unknowns: z.array(z.string().trim().min(1)).max(OUTPUT_LIMITS.maxUnknowns),
    confidence: z.enum(["LOW", "MEDIUM", "HIGH"]),
    sourceRecordIds: z
      .array(z.string().min(1))
      .min(1, "at least one source record must be cited")
      .max(OUTPUT_LIMITS.maxSourceRecordIds),
    // Exactly 3 — a fixed-length tuple, not a bounded array, since "exactly
    // three mitigation options" is a hard structural requirement, not just a
    // typical range.
    mitigationOptions: z.tuple([
      mitigationOptionOutputSchema,
      mitigationOptionOutputSchema,
      mitigationOptionOutputSchema,
    ]),
  })
  .strict()
  .refine((data) => data.mitigationOptions.filter((option) => option.isRecommended).length === 1, {
    message: "exactly one mitigation option must have isRecommended: true",
    path: ["mitigationOptions"],
  });

export type ImpactAnalysisOutput = z.infer<typeof impactAnalysisOutputSchema>;

/**
 * Turns a ZodError into a short list of safe, human-readable strings —
 * concise enough to feed back to the provider as retry guidance
 * (LLMProviderRequest.validationFeedback) and safe enough to persist on
 * ImpactAnalysis.validationErrors, since they only ever describe this
 * schema's own field paths/messages, never raw provider output.
 */
export function summarizeOutputSchemaErrors(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
}
