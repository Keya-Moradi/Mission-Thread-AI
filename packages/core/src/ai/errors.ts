// Safe, fixed error-category allowlist for a failed ImpactAnalysis attempt —
// same "one Prisma String column + an application-layer allowlist" pattern
// already used for RecordType subsets (see packages/core/src/record-types.ts)
// rather than a new Prisma enum, since these categories are an
// orchestration/validation concept, not a database-level one. Every value
// here must be safe to persist and to show in the UI: no stack traces, no
// provider payloads, no secrets.
export const AI_ERROR_CATEGORIES = [
  // Provider construction/config failed before any attempt could be made
  // (missing OPENAI_API_KEY/OPENAI_MODEL, unknown AI_MODE). Never retried —
  // retrying doesn't fix a missing credential.
  "CONFIGURATION_ERROR",
  // The provider call itself failed (network error, non-2xx response, rate
  // limit, provider-side outage). Retryable.
  "TRANSIENT_PROVIDER_FAILURE",
  // The provider returned a response whose body could not be parsed as JSON
  // at all. Retryable.
  "MALFORMED_JSON",
  // The parsed JSON did not satisfy the authoritative Zod output schema
  // (wrong option count, extra keys, bad monetary format, etc). Retryable.
  "INVALID_OUTPUT_SCHEMA",
  // The output was structurally valid but failed semantic/source validation
  // (fabricated source ID, deterministic-value mismatch, etc). Retryable.
  "SEMANTIC_VALIDATION_FAILED",
  // The provider succeeded and its output passed structural and semantic
  // validation, but writing the result to the database failed (connection
  // drop, constraint violation, transaction rollback). Never retryable: a
  // retry would call the provider again for a response it already produced
  // correctly, and a broken persistence layer isn't fixed by asking the
  // provider to try again. See docs/DECISIONS.md, "Persistence-boundary
  // repair: provider vs. persistence failure separation".
  "PERSISTENCE_FAILURE",
] as const;

export type AiErrorCategory = (typeof AI_ERROR_CATEGORIES)[number];

const RETRYABLE_CATEGORIES: ReadonlySet<AiErrorCategory> = new Set([
  "TRANSIENT_PROVIDER_FAILURE",
  "MALFORMED_JSON",
  "INVALID_OUTPUT_SCHEMA",
  "SEMANTIC_VALIDATION_FAILED",
]);

export function isRetryableCategory(category: AiErrorCategory): boolean {
  return RETRYABLE_CATEGORIES.has(category);
}

/**
 * Thrown by provider-factory.ts (missing/unknown AI_MODE, missing
 * OPENAI_API_KEY/OPENAI_MODEL in live mode) or by a provider's constructor.
 * Caught by the orchestrator before any ImpactAnalysis row is created — a
 * configuration failure isn't a real "attempt," so nothing is persisted for
 * it beyond the safe ServiceResult error the orchestrator returns.
 */
export class AiConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiConfigurationError";
  }
}

/**
 * Thrown by a provider's generateImpactAnalysis() for a call-time failure
 * (network error, non-2xx, provider-side error, response body that isn't
 * valid JSON). `category` must be one of the retryable categories above —
 * AiConfigurationError is the only non-retryable provider-side failure, and
 * it's a distinct class specifically so the orchestrator never has to guess
 * retryability from a message string.
 */
export class AiProviderError extends Error {
  readonly category: AiErrorCategory;

  constructor(message: string, category: AiErrorCategory = "TRANSIENT_PROVIDER_FAILURE") {
    super(message);
    this.name = "AiProviderError";
    this.category = category;
  }
}

/**
 * Classifies any error thrown out of a provider call into a safe category —
 * never echoes the original error's message into what gets persisted or
 * logged, since a thrown error from a live HTTP call could contain response
 * bodies, headers, or other provider-side detail that isn't safe to store.
 */
export function classifyProviderError(error: unknown): AiErrorCategory {
  if (error instanceof AiConfigurationError) return "CONFIGURATION_ERROR";
  if (error instanceof AiProviderError) return error.category;
  return "TRANSIENT_PROVIDER_FAILURE";
}
