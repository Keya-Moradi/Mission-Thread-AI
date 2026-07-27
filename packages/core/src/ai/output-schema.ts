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
 * Renders a Zod issue's `path` as `a.b[2].c` — string segments joined with
 * `.`, numeric (array-index) segments wrapped in `[...]` — matching the
 * same path-based message style `output-validation.ts`'s semantic checks
 * already use. An empty path (a top-level `.refine()`/`unrecognized_keys`
 * violation on the object itself) renders as `"(root)"`.
 */
function formatIssuePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "(root)";
  let result = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      result += `[${segment}]`;
    } else {
      result += result.length > 0 ? `.${String(segment)}` : String(segment);
    }
  }
  return result;
}

/**
 * Fixed, safe messages for the specific `.refine()` custom-validation
 * checks this schema defines, keyed by the exact `path` Zod reports for
 * each — the only "custom"-code issues this schema can ever actually
 * produce. Never a general-purpose lookup: an unrecognized path here
 * (which should never happen given the schema above, but is never
 * assumed) falls through to the generic per-path message in
 * `summarizeStructuralIssue()` below rather than ever reading
 * `issue.message`.
 */
const KNOWN_CUSTOM_ISSUE_MESSAGES: Record<string, string> = {
  mitigationOptions: "exactly one mitigation option must be marked as recommended.",
};

/**
 * Builds one safe, human-readable string per Zod structural-validation
 * issue — entirely from `issue.code`, `issue.path`, and schema-authored
 * numeric/format metadata (`.minimum`/`.maximum`/`.values`), **never**
 * from `issue.message`, `issue.input`, `issue.keys`, a received enum
 * value, or any other provider-controlled content. This matters most for
 * `unrecognized_keys`: a naive `` `${path}: ${issue.message}` `` (Zod's
 * default `unrecognized_keys` message embeds the offending key name
 * verbatim, e.g. `Unrecognized key: "IGNORE_ALL_RULES..."`) would let a
 * provider inject arbitrary text into `ImpactAnalysis.validationErrors`
 * (persisted) and the next attempt's `validationFeedback` (fed back into
 * the prompt) using nothing but a well-chosen *property name* — no value
 * needed. Every branch below reports only the field path and, where
 * genuinely useful, schema-authored limits. See docs/DECISIONS.md, "Phase
 * 6 correction: provider-terminal-state and validation-error safety", and
 * docs/THREAT_MODEL.md.
 */
function summarizeStructuralIssue(issue: z.core.$ZodIssue): string {
  const path = formatIssuePath(issue.path);
  switch (issue.code) {
    case "unrecognized_keys":
      // Deliberately never lists issue.keys — see the function doc comment.
      return `${path}: unexpected fields are not allowed.`;
    case "invalid_type":
      return `${path}: value has an unexpected type.`;
    case "invalid_value": {
      // issue.values is the schema-authored ALLOWED set (e.g. ["LOW",
      // "MEDIUM", "HIGH"]) — safe to include. The provider's actual
      // (rejected) value is never read here.
      const allowed = Array.isArray(issue.values) ? issue.values.map(String).join(", ") : undefined;
      return allowed
        ? `${path}: value is not an allowed value (expected one of: ${allowed}).`
        : `${path}: value is not an allowed value.`;
    }
    case "too_small":
      if (issue.origin === "array") {
        return issue.exact
          ? `${path}: exactly ${issue.minimum} item(s) are required.`
          : `${path}: value has fewer than the minimum required ${issue.minimum} item(s).`;
      }
      return `${path}: value is shorter than the minimum permitted length of ${issue.minimum} character(s).`;
    case "too_big":
      if (issue.origin === "array") {
        return issue.exact
          ? `${path}: exactly ${issue.maximum} item(s) are required.`
          : `${path}: value has more than the maximum permitted ${issue.maximum} item(s).`;
      }
      return `${path}: value exceeds the maximum permitted length of ${issue.maximum} character(s).`;
    case "invalid_format":
      return `${path}: value does not match the required format.`;
    case "custom":
      return `${path}: ${KNOWN_CUSTOM_ISSUE_MESSAGES[path] ?? "value failed validation."}`;
    default:
      // Any future Zod issue code this schema doesn't otherwise recognize —
      // still safe (path + a fixed phrase only), never issue.message.
      return `${path}: value failed validation.`;
  }
}

/**
 * Turns a ZodError into a short list of safe, human-readable strings —
 * concise enough to feed back to the provider as retry guidance
 * (LLMProviderRequest.validationFeedback) and safe enough to persist on
 * ImpactAnalysis.validationErrors, since they only ever describe this
 * schema's own field paths and fixed, application-authored phrases —
 * never Zod's own issue.message, which can embed provider-controlled text
 * (see summarizeStructuralIssue() above).
 */
export function summarizeOutputSchemaErrors(error: z.ZodError): string[] {
  return error.issues.map(summarizeStructuralIssue);
}
