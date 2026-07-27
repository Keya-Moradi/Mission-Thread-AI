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
 * The OpenAI SDK's own `debug`/`info` log levels print request and response
 * bodies — including the full prompt (which embeds `untrustedData`) and the
 * model's raw output — to the process's stdout/stderr. By default the SDK
 * resolves its log level from `process.env.OPENAI_LOG`, so a developer or a
 * deployment environment setting `OPENAI_LOG=debug` for unrelated reasons
 * (general SDK troubleshooting, a shared logging convention, etc.) would
 * silently start logging prompts and model output through this provider
 * with no code change and no warning. Explicitly forcing the client-level
 * `logLevel` option to `"off"` overrides `OPENAI_LOG` entirely — the SDK
 * checks the explicit client option before falling back to the environment
 * variable (see `node_modules/openai/src/client.ts`'s constructor) — so
 * this application never depends on a developer remembering to unset it.
 */
export const OPENAI_SDK_LOG_LEVEL = "off";

/**
 * The only place a real `OpenAI` client is constructed with production
 * settings — pulled into its own pure, directly-testable function (rather
 * than inlined in the constructor) specifically so a test can assert on the
 * exact resolved `maxRetries`/`timeout`/`logLevel` values without needing to
 * intercept the SDK's module internals. Constructing an `OpenAI` client
 * never itself opens a network connection (the SDK connects lazily,
 * per-request), so this is safe to call directly in a test with a fake API
 * key.
 */
export function buildOpenAiClientOptions(apiKey: string): ClientOptions {
  return {
    apiKey,
    maxRetries: OPENAI_SDK_MAX_RETRIES,
    timeout: OPENAI_REQUEST_TIMEOUT_MS,
    logLevel: OPENAI_SDK_LOG_LEVEL,
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

    // Terminal-state gate — thrown here, outside the try/catch above, so
    // toProviderError() never reclassifies it; propagates directly to the
    // orchestrator's classifyProviderError(), which recognizes
    // AiProviderError instances and returns their own category unchanged.
    // response.output_text is never parsed, returned, logged, or included
    // in any thrown message unless this assertion passes. See
    // assertOpenAiResponseCompleted() below.
    assertOpenAiResponseCompleted(response);

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

/**
 * True if any output item in the response is an explicit model refusal —
 * checked before looking at `response.status` at all, since a model can in
 * principle produce a `completed` response whose sole content is a refusal
 * (a deliberate decision to decline, not a truncation or filter event) —
 * see `ResponseOutputRefusal` in the `openai` package's own types. Never
 * returns or logs the refusal text itself; only whether one is present.
 */
function hasResponseRefusal(response: OpenAI.Responses.Response): boolean {
  for (const item of response.output ?? []) {
    if (item.type !== "message") continue;
    for (const content of item.content) {
      if (content.type === "refusal") return true;
    }
  }
  return false;
}

/**
 * The one gate between a raw SDK response and `JSON.parse(response.output_text)`
 * — `output_text` is never read anywhere else in this file. Every branch
 * either returns normally (only for a genuinely usable `completed`
 * response with no refusal) or throws a safe `AiProviderError`; none of
 * the branches below ever include `response.error`, `response.output_text`,
 * `response.incomplete_details`, or any other response-derived text in a
 * thrown message. See docs/DECISIONS.md, "Phase 6 correction:
 * provider-terminal-state and validation-error safety".
 *
 * Deliberately does not special-case a missing `response.status` as
 * "probably fine" — a production-shaped response from the real API always
 * sets it; an `undefined` value here only ever happens in a test fake that
 * omitted it, which is exactly the case that must fail loudly rather than
 * silently fall through to JSON parsing.
 */
export function assertOpenAiResponseCompleted(response: OpenAI.Responses.Response): void {
  if (hasResponseRefusal(response)) {
    throw new AiProviderError(
      "The live provider declined to produce a response for this request.",
      "PROVIDER_REFUSAL",
    );
  }

  if (response.status === "completed") {
    return;
  }

  if (response.status === "incomplete") {
    const reason = response.incomplete_details?.reason;
    if (reason === "max_output_tokens") {
      throw new AiProviderError(
        "The live provider's response was truncated before completion (output-token ceiling reached).",
        "INCOMPLETE_OUTPUT",
      );
    }
    if (reason === "content_filter") {
      throw new AiProviderError(
        "The live provider declined to produce a response for this request.",
        "PROVIDER_REFUSAL",
      );
    }
    // An absent or unrecognized incomplete reason is a genuine anomaly
    // this application has no specific handling for — never parsed,
    // never assumed safe. Classified as retryable: an unrecognized reason
    // is more likely a provider-side quirk than a permanent, request-specific
    // block, and the cost of being wrong is bounded by the orchestrator's
    // existing 2-attempt cap either way. See docs/DECISIONS.md for this
    // choice.
    throw new AiProviderError(
      "The live provider returned an incomplete response for an unrecognized reason.",
      "TRANSIENT_PROVIDER_FAILURE",
    );
  }

  // status is "failed" | "cancelled" | "in_progress" | "queued" | undefined
  // | any other non-completed value this synchronous (non-streaming)
  // request path should never legitimately see. Never parsed, never
  // accepted, regardless of what response.output_text happens to contain.
  throw new AiProviderError(
    "The live provider did not return a completed response.",
    "TRANSIENT_PROVIDER_FAILURE",
  );
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
