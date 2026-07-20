import { AiConfigurationError } from "./errors";
import { MockLLMProvider } from "./mock-provider";
import { OpenAiImpactAnalysisProvider } from "./openai-provider";
import type { LLMProvider } from "./provider";

export const AI_MODES = ["mock", "live"] as const;
export type AiMode = (typeof AI_MODES)[number];

/**
 * Strict AI_MODE resolution — exactly "mock" or "live", nothing else.
 * Missing, unknown, uppercase, and whitespace-padded values are all
 * rejected rather than silently defaulted, so a misconfigured deployment
 * fails loudly instead of quietly running in an unintended mode. CI and the
 * documented local default are both explicit "mock" in .env.example /
 * .env.test.example / ci.yml — this function itself has no implicit
 * fallback.
 */
export function resolveAiMode(rawValue: string | undefined): AiMode {
  if (rawValue === "mock" || rawValue === "live") {
    return rawValue;
  }
  if (rawValue === undefined) {
    throw new AiConfigurationError('AI_MODE is not set; expected exactly "mock" or "live".');
  }
  throw new AiConfigurationError(
    `AI_MODE is set to an unrecognized value; expected exactly "mock" or "live".`,
  );
}

/**
 * Resolves AI_MODE and constructs the matching provider. Thrown
 * AiConfigurationError propagates to the orchestrator, which returns it as a
 * safe ServiceResult error without creating any ImpactAnalysis row — a
 * configuration failure isn't a real attempt. Live-mode credentials
 * (OPENAI_API_KEY/OPENAI_MODEL) are read here, once, at the orchestration
 * boundary — never inside the provider's own module scope, so a mock-mode
 * process never even attempts to read them.
 */
export function createProviderFromEnv(env: NodeJS.ProcessEnv = process.env): LLMProvider {
  const mode = resolveAiMode(env.AI_MODE);
  if (mode === "mock") {
    return new MockLLMProvider();
  }
  const apiKey = env.OPENAI_API_KEY;
  const model = env.OPENAI_MODEL;
  if (!apiKey) {
    throw new AiConfigurationError("OPENAI_API_KEY is required when AI_MODE=live.");
  }
  if (!model) {
    throw new AiConfigurationError("OPENAI_MODEL is required when AI_MODE=live.");
  }
  return new OpenAiImpactAnalysisProvider({ apiKey, model });
}
