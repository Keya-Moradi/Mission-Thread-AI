import { z } from "zod";
import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  AuthenticationError,
  InternalServerError,
  PermissionDeniedError,
  RateLimitError,
} from "openai";
import { impactAnalysisOutputSchema } from "./output-schema";
import { AiConfigurationError, AiProviderError } from "./errors";
import type { LLMProvider, LLMProviderRequest, LLMProviderResponse } from "./provider";
import { buildImpactAnalysisUserPrompt } from "./prompts/impact-analysis-user";

// Generated once at module load — the schema itself never changes at
// runtime, and z.toJSONSchema() is a pure function of impactAnalysisOutputSchema.
// Per docs/DECISIONS.md, "Live provider JSON schema source": this is
// generated FROM the authoritative Zod schema (never hand-duplicated), and
// the parsed response is always re-validated against that same Zod schema
// afterward — this JSON schema is steering for the API, never the sole
// enforcement.
const OUTPUT_JSON_SCHEMA = z.toJSONSchema(impactAnalysisOutputSchema, {
  target: "draft-2020-12",
});

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
    this.client = options.client ?? new OpenAI({ apiKey: options.apiKey });
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
            schema: OUTPUT_JSON_SCHEMA as Record<string, unknown>,
            strict: true,
          },
        },
        // Never persisted server-side by OpenAI — this app keeps its own
        // record of every attempt (ImpactAnalysis rows), so there's no
        // reason to also retain the raw conversation on the provider side.
        store: false,
      });
    } catch (error) {
      throw toProviderError(error);
    }
    const durationMs = Date.now() - startedAt;

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
