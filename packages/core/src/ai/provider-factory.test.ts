import { describe, expect, it } from "vitest";
import { AiConfigurationError } from "./errors";
import { MockLLMProvider } from "./mock-provider";
import { OpenAiImpactAnalysisProvider } from "./openai-provider";
import { createProviderFromEnv, resolveAiMode } from "./provider-factory";

describe("resolveAiMode — strict rejection", () => {
  it("accepts exactly 'mock'", () => {
    expect(resolveAiMode("mock")).toBe("mock");
  });

  it("accepts exactly 'live'", () => {
    expect(resolveAiMode("live")).toBe("live");
  });

  it("[missing] rejects undefined", () => {
    expect(() => resolveAiMode(undefined)).toThrow(AiConfigurationError);
  });

  it("[unknown value] rejects an unrecognized string", () => {
    expect(() => resolveAiMode("production")).toThrow(AiConfigurationError);
  });

  it("[uppercase] rejects 'MOCK'", () => {
    expect(() => resolveAiMode("MOCK")).toThrow(AiConfigurationError);
  });

  it("[whitespace] rejects ' mock' and 'mock '", () => {
    expect(() => resolveAiMode(" mock")).toThrow(AiConfigurationError);
    expect(() => resolveAiMode("mock ")).toThrow(AiConfigurationError);
  });

  it("[empty string] rejects ''", () => {
    expect(() => resolveAiMode("")).toThrow(AiConfigurationError);
  });
});

describe("createProviderFromEnv", () => {
  it("[mock mode] returns a MockLLMProvider, no API key required", () => {
    const provider = createProviderFromEnv({ AI_MODE: "mock" } as NodeJS.ProcessEnv);
    expect(provider).toBeInstanceOf(MockLLMProvider);
  });

  it("[live mode, missing key] throws AiConfigurationError without constructing a provider", () => {
    expect(() =>
      createProviderFromEnv({ AI_MODE: "live", OPENAI_MODEL: "gpt-test" } as NodeJS.ProcessEnv),
    ).toThrow(AiConfigurationError);
  });

  it("[live mode, missing model] throws AiConfigurationError", () => {
    expect(() =>
      createProviderFromEnv({ AI_MODE: "live", OPENAI_API_KEY: "sk-test" } as NodeJS.ProcessEnv),
    ).toThrow(AiConfigurationError);
  });

  it("[live mode, fully configured] constructs an OpenAiImpactAnalysisProvider — never makes a network call to do so", () => {
    const provider = createProviderFromEnv({
      AI_MODE: "live",
      OPENAI_API_KEY: "sk-test",
      OPENAI_MODEL: "gpt-test",
    } as NodeJS.ProcessEnv);
    expect(provider).toBeInstanceOf(OpenAiImpactAnalysisProvider);
  });

  it("[unset AI_MODE] throws AiConfigurationError", () => {
    expect(() => createProviderFromEnv({} as NodeJS.ProcessEnv)).toThrow(AiConfigurationError);
  });
});
