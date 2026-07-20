import type { ModelInputProjection } from "./model-input";

/**
 * Everything a provider needs to produce one attempt's output. Providers
 * never see Prisma, the actor's identity beyond what's already baked into
 * the trace/run IDs, or raw database rows — only this request shape. See
 * docs/DECISIONS.md, "LLMProvider boundary".
 */
export interface LLMProviderRequest {
  traceId: string;
  analysisRunId: string;
  attempt: number;
  systemPrompt: string;
  modelInput: ModelInputProjection;
  /**
   * Concise, safe validation-failure summaries from the previous attempt in
   * the same run — present only on a retry (attempt 2). Never raw stack
   * traces or provider payloads; see output-validation.ts /
   * output-schema.ts for how these strings are produced.
   */
  validationFeedback?: string[];
}

/**
 * `rawOutput` is intentionally `unknown` — the caller (orchestrator.ts)
 * always re-validates it against the authoritative Zod output schema before
 * trusting any field, never assumes a provider already enforced the shape
 * correctly.
 */
export interface LLMProviderResponse {
  provider: string;
  model: string;
  rawOutput: unknown;
  durationMs: number;
}

/**
 * A provider must never: touch Prisma, mutate any application state, decide
 * authorization, or loosen/bypass the caller's own structural or semantic
 * output validation. It only turns a request into a response; everything
 * else (persistence, retry, audit, authorization) is the orchestrator's job.
 */
export interface LLMProvider {
  readonly name: string;
  generateImpactAnalysis(request: LLMProviderRequest): Promise<LLMProviderResponse>;
}
