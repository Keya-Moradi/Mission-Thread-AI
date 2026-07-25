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
  // Phase 6 correction: every previously-unbounded output string gets an
  // explicit ceiling — see docs/DECISIONS.md, "Phase 6 correction:
  // provider-spend and output-bounds". Record IDs in this application are
  // always short, human-readable, fixed-format strings (e.g. "REQ-001",
  // "EVT-SUPPLIER-001") — 128 characters is generous headroom over any real
  // ID while still rejecting a runaway/adversarial value before persistence.
  maxRecordIdLength: 128,
  maxVerificationCategoryLength: 64,
  maxAssumptionLength: 500,
  maxUnknownLength: 500,
} as const;

/**
 * Shared bound for every output field that identifies a record by ID —
 * affectedRequirementIds/affectedMilestoneIds/sourceRecordIds (top-level
 * and per-option) and verificationGaps[*].requirementId. One schema so
 * every ID field is bounded identically, rather than five independently
 * maintained (and easily inconsistent) length checks.
 */
const outputRecordIdSchema = z.string().min(1).max(OUTPUT_LIMITS.maxRecordIdLength);

/**
 * PostgreSQL `Decimal(12, 2)` (see `MitigationOption.costImpact` and
 * `ImpactAnalysis.budgetExposureAmount` in schema.prisma) permits at most 10
 * digits before the decimal point plus the 2 after it — 12 significant
 * digits total. A structurally "valid-looking" monetary string with more
 * integer digits than that would pass a looser regex but fail at Prisma
 * persistence time, after the provider response has already been treated as
 * successful. This schema is the database-safe boundary itself, not merely
 * documentation of it — see docs/DECISIONS.md, "Persistence-boundary
 * repair: database-safe output constraints".
 */
export const MAX_DECIMAL_12_2_INTEGER_DIGITS = 10;

/**
 * Fixed-2-decimal, non-negative monetary string ("480000.00") bounded to
 * fit `Decimal(12, 2)` — never a bare JS number (binary-float rounding),
 * never a currency-symbol-prefixed string, never more integer digits than
 * the column can actually store. Used for every monetary field this schema
 * persists directly: `budgetExposureAmount` and each mitigation option's
 * `costImpact`.
 */
export const persistedMoneyStringSchema = z
  .string()
  .regex(
    /^\d{1,10}\.\d{2}$/,
    "must be a non-negative fixed two-decimal value within Decimal(12,2)",
  );

/**
 * Documented business range for a mitigation option's *proposed* schedule
 * impact — unlike `scheduleExposureDays` (which must exactly equal an
 * already-computed deterministic value, enforced in output-validation.ts),
 * this is a model-proposed number with no deterministic counterpart to
 * check it against, so it needs its own explicit bound. ±3650 days (10
 * years) comfortably covers any real proposed acceleration or delay for
 * this program while staying far inside Postgres `Int` range, and — more
 * importantly — inside any range a human reviewer could sensibly evaluate.
 */
export const MIN_MITIGATION_SCHEDULE_IMPACT_DAYS = -3650;
export const MAX_MITIGATION_SCHEDULE_IMPACT_DAYS = 3650;

const nonEmptyTrimmedString = (max: number) => z.string().trim().min(1).max(max);

const mitigationOptionOutputSchema = z
  .object({
    title: nonEmptyTrimmedString(OUTPUT_LIMITS.maxOptionTitleLength),
    description: nonEmptyTrimmedString(OUTPUT_LIMITS.maxOptionDescriptionLength),
    tradeoffs: nonEmptyTrimmedString(OUTPUT_LIMITS.maxOptionTradeoffsLength),
    costImpact: persistedMoneyStringSchema.nullable(),
    scheduleImpact: z
      .number()
      .int()
      .min(MIN_MITIGATION_SCHEDULE_IMPACT_DAYS)
      .max(MAX_MITIGATION_SCHEDULE_IMPACT_DAYS)
      .nullable(),
    isRecommended: z.boolean(),
    sourceRecordIds: z
      .array(outputRecordIdSchema)
      .min(1, "each mitigation option must cite at least one source record")
      .max(OUTPUT_LIMITS.maxOptionSourceRecordIds),
  })
  .strict();

export type MitigationOptionOutput = z.infer<typeof mitigationOptionOutputSchema>;

const verificationGapOutputSchema = z
  .object({
    requirementId: outputRecordIdSchema,
    category: z.string().min(1).max(OUTPUT_LIMITS.maxVerificationCategoryLength),
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
    budgetExposureAmount: persistedMoneyStringSchema.nullable(),
    affectedRequirementIds: z.array(outputRecordIdSchema).max(OUTPUT_LIMITS.maxAffectedIds),
    affectedMilestoneIds: z.array(outputRecordIdSchema).max(OUTPUT_LIMITS.maxAffectedIds),
    verificationGaps: z.array(verificationGapOutputSchema).max(OUTPUT_LIMITS.maxVerificationGaps),
    assumptions: z
      .array(z.string().trim().min(1).max(OUTPUT_LIMITS.maxAssumptionLength))
      .max(OUTPUT_LIMITS.maxAssumptions),
    unknowns: z
      .array(z.string().trim().min(1).max(OUTPUT_LIMITS.maxUnknownLength))
      .max(OUTPUT_LIMITS.maxUnknowns),
    confidence: z.enum(["LOW", "MEDIUM", "HIGH"]),
    sourceRecordIds: z
      .array(outputRecordIdSchema)
      .min(1, "at least one source record must be cited")
      .max(OUTPUT_LIMITS.maxSourceRecordIds),
    // Exactly 3 — enforced with .length(3), not z.tuple(...). A tuple
    // converts to JSON Schema's "prefixItems" (positional-item validation),
    // which is outside OpenAI Structured Outputs' documented supported
    // subset (see openai-schema.ts). A bounded array with minItems/maxItems
    // both set to 3 expresses the identical "exactly three" constraint using
    // only "items"/"minItems"/"maxItems" — a form OpenAI's strict mode does
    // support — while Zod itself still rejects any array whose length isn't
    // exactly 3, so nothing about the authoritative validation is weakened.
    // See docs/DECISIONS.md, "Phase 4 correction: mitigationOptions array
    // instead of tuple".
    mitigationOptions: z
      .array(mitigationOptionOutputSchema)
      .length(3, "exactly three mitigation options are required"),
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
