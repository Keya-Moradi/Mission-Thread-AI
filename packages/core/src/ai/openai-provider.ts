import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  AuthenticationError,
  InternalServerError,
  PermissionDeniedError,
  RateLimitError,
  type ClientOptions,
} from "openai";
import { buildOpenAiImpactAnalysisJsonSchema } from "./openai-schema";
import { AiConfigurationError, AiProviderError } from "./errors";
import type { LLMProvider, LLMProviderRequest, LLMProviderResponse } from "./provider";
import { buildImpactAnalysisUserPrompt } from "./prompts/impact-analysis-user";

// Generated once at module load — the schema itself never changes at
// runtime. Always derived FROM impactAnalysisOutputSchema and verified
// against OpenAI's supported JSON Schema subset (see openai-schema.ts,
// docs/DECISIONS.md "Phase 4 correction: provider-facing JSON Schema
// subset") — never hand-duplicated. The parsed response is always
// re-validated against that same authoritative Zod schema afterward (see
// generateImpactAnalysis() below and orchestrator.ts) — this JSON schema is
// steering for the API, never the sole enforcement.
const OUTPUT_JSON_SCHEMA = buildOpenAiImpactAnalysisJsonSchema();

/**
 * The official OpenAI SDK enables its own automatic retry behavior by
 * default (2 retries) and a 10-minute default request timeout — both left
 * enabled would mean the orchestrator's own "at most two attempts total"
 * cap (packages/core/src/ai/orchestrator.ts) no longer actually bounds the
 * number of real HTTP requests one provider invocation can make. Disabling
 * SDK-level retries here makes the orchestrator the sole retry authority:
 * exactly one provider invocation equals exactly one HTTP request. See
 * docs/DECISIONS.md, "Phase 6 correction: sole retry authority".
 */
export const OPENAI_SDK_MAX_RETRIES = 0;

/**
 * Bounds a single request's worst-case wall-clock time — the SDK's own
 * 10-minute default would let one "attempt" (out of the orchestrator's
 * 2-attempt cap) hang far longer than any human reviewer would wait for an
 * analysis. A timeout is classified through the existing transient-provider
 * failure path (toProviderError() below) and retried exactly like any other
 * transient failure — the orchestrator's second attempt is the only retry
 * that ever follows.
 */
export const OPENAI_REQUEST_TIMEOUT_MS = 60_000;

/**
 * Hard ceiling on the live provider's own response size, sent as
 * `max_output_tokens` on every request — includes both the model's visible
 * output tokens and any internal reasoning tokens the model spends before
 * producing that output (OpenAI's Responses API counts both against this
 * one ceiling). Server-controlled only: never derived from form data, a
 * client request, or model output itself. Applies identically to
 * production analyses and `npm run eval:live`, since both go through this
 * same provider class.
 */
export const IMPACT_ANALYSIS_MAX_OUTPUT_TOKENS = 8192;

/**
 * The only place a real `OpenAI` client is constructed with production
 * settings — pulled into its own pure, directly-testable function (rather
 * than inlined in the constructor) specifically so a test can assert on the
 * exact resolved `maxRetries`/`timeout` values without needing to intercept
 * the SDK's module internals. Constructing an `OpenAI` client never itself
 * opens a network connection (the SDK connects lazily, per-request), so
 * this is safe to call directly in a test with a fake API key.
 */
export function buildOpenAiClientOptions(apiKey: string): ClientOptions {
  return {
    apiKey,
    maxRetries: OPENAI_SDK_MAX_RETRIES,
    timeout: OPENAI_REQUEST_TIMEOUT_MS,
  };
}

/**
 * Never touches Prisma, never mutates application state, never decides
 * authorization — turns one LLMProviderRequest into one LLMProviderResponse
 * and nothing else. Constructed only when AI_MODE=live (see
 * provider-factory.ts); reads OPENAI_API_KEY/OPENAI_MODEL from the
 * environment at construction time, never hardcodes a model name.
 */
export class OpenAiImpactAnalysisProvider implements LLMProvider {
  readonly name = "openai";
  private readonly client: OpenAI;
  private readonly modelName: string;

  constructor(options: { apiKey: string; model: string; client?: OpenAI }) {
    if (!options.apiKey) {
      throw new AiConfigurationError("OPENAI_API_KEY is required in live mode.");
    }
    if (!options.model) {
      throw new AiConfigurationError("OPENAI_MODEL is required in live mode.");
    }
    this.modelName = options.model;
    // Dependency injection point: tests supply a fake `client` so no unit,
    // integration, or smoke test ever makes a real network call — see
    // docs/DECISIONS.md, "Live provider is never exercised by automated tests".
    this.client = options.client ?? new OpenAI(buildOpenAiClientOptions(options.apiKey));
  }

  async generateImpactAnalysis(request: LLMProviderRequest): Promise<LLMProviderResponse> {
    const startedAt = Date.now();
    let response: OpenAI.Responses.Response;
    try {
      response = await this.client.responses.create({
        model: this.modelName,
        instructions: request.systemPrompt,
        input: buildRequestInput(request),
        // Structured output: strict JSON-schema mode, generated from the
        // same authoritative Zod schema every attempt is re-validated
        // against — see OUTPUT_JSON_SCHEMA above.
        text: {
          format: {
            type: "json_schema",
            name: "impact_analysis_output",
            schema: OUTPUT_JSON_SCHEMA,
            strict: true,
          },
        },
        // Server-controlled response-size ceiling — see
        // IMPACT_ANALYSIS_MAX_OUTPUT_TOKENS above.
        max_output_tokens: IMPACT_ANALYSIS_MAX_OUTPUT_TOKENS,
        // Never persisted server-side by OpenAI — this app keeps its own
        // record of every attempt (ImpactAnalysis rows), so there's no
        // reason to also retain the raw conversation on the provider side.
        store: false,
      });
    } catch (error) {
      throw toProviderError(error);
    }
    const durationMs = Date.now() - startedAt;

    // The request succeeded (no thrown error) but was truncated before the
    // model finished, because it hit IMPACT_ANALYSIS_MAX_OUTPUT_TOKENS —
    // response.output_text in this state is a cut-off fragment, not
    // necessarily even syntactically valid JSON, and must never be treated
    // as a successful result. Thrown here (outside the try/catch above, so
    // toProviderError() never reclassifies it) and propagates directly to
    // the orchestrator's classifyProviderError(), which recognizes
    // AiProviderError instances and returns their own category unchanged.
    // Never includes response.output_text itself in the thrown message.
    if (
      response.status === "incomplete" &&
      response.incomplete_details?.reason === "max_output_tokens"
    ) {
      throw new AiProviderError(
        "The live provider's response was truncated before completion (output-token ceiling reached).",
        "INCOMPLETE_OUTPUT",
      );
    }

    let rawOutput: unknown;
    try {
      rawOutput = JSON.parse(response.output_text);
    } catch {
      throw new AiProviderError(
        "The live provider's response body could not be parsed as JSON.",
        "MALFORMED_JSON",
      );
    }

    return {
      provider: this.name,
      model: response.model ?? this.modelName,
      rawOutput,
      durationMs,
    };
  }
}

function buildRequestInput(request: LLMProviderRequest): string {
  const parts = [buildImpactAnalysisUserPrompt(request.modelInput)];
  if (request.validationFeedback && request.validationFeedback.length > 0) {
    parts.push(
      "",
      "Your previous attempt failed validation for these reasons — correct exactly these issues:",
      ...request.validationFeedback.map((issue) => `- ${issue}`),
    );
  }
  return parts.join("\n");
}

/**
 * Converts any error thrown by the OpenAI SDK into a safe AiProviderError —
 * never re-throws the original error (which could carry response bodies,
 * headers, or other provider-side detail) beyond a short, fixed message.
 */
function toProviderError(error: unknown): AiConfigurationError | AiProviderError {
  if (error instanceof AuthenticationError || error instanceof PermissionDeniedError) {
    // A bad/missing/revoked API key never recovers on retry.
    return new AiConfigurationError("The live provider rejected the request credentials.");
  }
  if (
    error instanceof RateLimitError ||
    error instanceof InternalServerError ||
    error instanceof APIConnectionError ||
    error instanceof APIConnectionTimeoutError
  ) {
    return new AiProviderError(
      "The live provider call failed transiently.",
      "TRANSIENT_PROVIDER_FAILURE",
    );
  }
  return new AiProviderError("The live provider call failed.", "TRANSIENT_PROVIDER_FAILURE");
}
