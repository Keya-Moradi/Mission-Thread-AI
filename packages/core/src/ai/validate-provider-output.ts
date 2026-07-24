import type { ModelInputProjection } from "./model-input";
import {
  impactAnalysisOutputSchema,
  summarizeOutputSchemaErrors,
  type ImpactAnalysisOutput,
} from "./output-schema";
import { validateImpactAnalysisSemantics } from "./output-validation";

/**
 * The complete, authoritative "is this a safe output to persist" check —
 * structural (Zod) validation followed by semantic/source validation
 * against the request's own model input. Extracted out of
 * orchestrator.ts's runProviderAndValidate() so the exact same rules run
 * in three places that must never drift apart: the live orchestration
 * path, the mock evaluation suite (evals/), and tests. See
 * docs/DECISIONS.md, "Phase 6: centralized provider-output validation" —
 * before this, the two validation stages were duplicated inline; now there
 * is exactly one implementation of "what makes a provider response safe."
 *
 * Never throws for any malformed/adversarial `rawOutput` — both
 * `impactAnalysisOutputSchema.safeParse()` and
 * `validateImpactAnalysisSemantics()` are safeParse/return-value based, so
 * this is safe to call directly on unscripted or hostile input (exactly
 * what the eval suite's adversarial scenarios do). Never touches the
 * database or a provider — a pure function of its two arguments only.
 */
export type ProviderOutputValidationResult =
  | { valid: true; output: ImpactAnalysisOutput }
  | {
      valid: false;
      category: "INVALID_OUTPUT_SCHEMA" | "SEMANTIC_VALIDATION_FAILED";
      errors: string[];
    };

export function validateProviderOutput(
  rawOutput: unknown,
  modelInput: ModelInputProjection,
): ProviderOutputValidationResult {
  const structural = impactAnalysisOutputSchema.safeParse(rawOutput);
  if (!structural.success) {
    return {
      valid: false,
      category: "INVALID_OUTPUT_SCHEMA",
      errors: summarizeOutputSchemaErrors(structural.error),
    };
  }

  const semantic = validateImpactAnalysisSemantics(structural.data, modelInput);
  if (!semantic.valid) {
    return {
      valid: false,
      category: "SEMANTIC_VALIDATION_FAILED",
      errors: semantic.errors,
    };
  }

  return { valid: true, output: structural.data };
}
