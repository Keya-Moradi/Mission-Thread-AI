import type { ModelInputProjection } from "./model-input";
import {
  impactAnalysisOutputSchema,
  summarizeOutputSchemaErrors,
  type ImpactAnalysisOutput,
} from "./output-schema";
import { validateImpactAnalysisSemantics } from "./output-validation";

/**
 * Pre-validation total-size ceiling — checked before Zod ever walks the
 * structure. Zod's own per-field `.max()` checks bound individual strings
 * and arrays, but nothing previously bounded the *combined* size of a
 * response (e.g. a schema-valid but enormous number of near-maximum-length
 * fields, or a provider bug producing a wildly oversized payload). 64KB is
 * generous headroom over any real response — the largest realistic valid
 * output (every string field at its individual maximum, every array at its
 * count ceiling) is well under this — while still rejecting a runaway
 * response before it reaches the more expensive structural/semantic
 * validation passes. See docs/DECISIONS.md, "Phase 6 correction:
 * provider-spend and output-bounds".
 */
export const MAX_PROVIDER_OUTPUT_BYTES = 65_536;

/**
 * Named bounds for validateProviderOutput()'s returned `errors` — applied
 * uniformly to both structural (Zod) and semantic validation-failure
 * results via sanitizeProviderValidationErrors() below, so every consumer
 * (ImpactAnalysis.validationErrors persistence, retry validationFeedback,
 * returned safe diagnostics, evaluation reporting) automatically inherits
 * the same bounds without needing its own sanitization step.
 */
export const MAX_VALIDATION_ERROR_COUNT = 20;
export const MAX_VALIDATION_ERROR_LENGTH = 240;
export const MAX_VALIDATION_FEEDBACK_BYTES = 4096;

/**
 * Safely measures a raw provider response's serialized size — never
 * throws. `JSON.stringify()` throws on a circular structure (and returns
 * `undefined`, not a string, for a small set of inputs like a bare
 * `undefined` or a function), both of which are treated identically here:
 * "could not be measured," which validateProviderOutput() rejects exactly
 * like an oversized response, before ever handing the value to Zod.
 */
function measureProviderOutputBytes(rawOutput: unknown): number | null {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(rawOutput);
  } catch {
    return null;
  }
  if (typeof serialized !== "string") {
    return null;
  }
  return Buffer.byteLength(serialized, "utf8");
}

/**
 * The one shared sanitizer every validation-failure error list passes
 * through before being returned. Caps the number of errors, the length of
 * each individual error, and the total *serialized* size of the whole
 * list — three independent, composable bounds, not a single "pick one"
 * limit. Never truncates mid-string in a way that could leave a fragment
 * of a provider-controlled value behind: by the time errors reach this
 * function, `validateImpactAnalysisSemantics()` (output-validation.ts) and
 * `summarizeOutputSchemaErrors()` (output-schema.ts) have already ensured
 * none of them contain a raw ID, option title, unrecognized key name, or
 * any other attacker-controlled text in the first place — every message
 * here is built entirely from this codebase's own fixed strings and safe
 * field-path/array-index references, so the length cap is a
 * defense-in-depth bound, not the mechanism that makes these messages
 * safe.
 *
 * `MAX_VALIDATION_FEEDBACK_BYTES` bounds `Buffer.byteLength(JSON.stringify(result),
 * "utf8")` — the array's actual serialized form, exactly as it's stored in
 * `ImpactAnalysis.validationErrors` (a JSON column) and as it would appear
 * inline in a retried prompt — not merely the sum of each raw string's own
 * UTF-8 byte length. `JSON.stringify` adds structural overhead (`[`, `]`,
 * `,`, the quotes around each string) and can *expand* a string's byte
 * count further still (escaping `"`, `\`, and control characters to
 * multi-character sequences like `\"`/`\\`/`\n`) — summing raw strings
 * alone silently undercounts both, so a list that looked safely under the
 * ceiling by the old measurement could still exceed it once actually
 * serialized. Each candidate error is appended to a *copy* of the
 * in-progress result and only kept if the newly re-serialized array still
 * fits — never decided from a per-string byte count in isolation.
 */
export function sanitizeProviderValidationErrors(errors: readonly string[]): string[] {
  const result: string[] = [];
  for (const rawError of errors) {
    if (result.length >= MAX_VALIDATION_ERROR_COUNT) break;
    const candidateError =
      rawError.length > MAX_VALIDATION_ERROR_LENGTH
        ? rawError.slice(0, MAX_VALIDATION_ERROR_LENGTH)
        : rawError;
    const candidateBytes = Buffer.byteLength(JSON.stringify([...result, candidateError]), "utf8");
    if (candidateBytes > MAX_VALIDATION_FEEDBACK_BYTES) break;
    result.push(candidateError);
  }
  return result;
}

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
  // Pre-validation size guard — runs before Zod ever touches rawOutput, so
  // a circular structure or a wildly oversized response is rejected
  // cheaply and safely, never partially walked. Never includes rawOutput
  // itself in the returned error.
  const sizeBytes = measureProviderOutputBytes(rawOutput);
  if (sizeBytes === null || sizeBytes > MAX_PROVIDER_OUTPUT_BYTES) {
    return {
      valid: false,
      category: "INVALID_OUTPUT_SCHEMA",
      errors: sanitizeProviderValidationErrors([
        "Provider output could not be validated: it exceeds the maximum allowed size or could not be safely measured.",
      ]),
    };
  }

  const structural = impactAnalysisOutputSchema.safeParse(rawOutput);
  if (!structural.success) {
    return {
      valid: false,
      category: "INVALID_OUTPUT_SCHEMA",
      errors: sanitizeProviderValidationErrors(summarizeOutputSchemaErrors(structural.error)),
    };
  }

  const semantic = validateImpactAnalysisSemantics(structural.data, modelInput);
  if (!semantic.valid) {
    return {
      valid: false,
      category: "SEMANTIC_VALIDATION_FAILED",
      errors: sanitizeProviderValidationErrors(semantic.errors),
    };
  }

  return { valid: true, output: structural.data };
}
