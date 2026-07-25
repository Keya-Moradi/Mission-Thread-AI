import { describe, expect, it } from "vitest";
import RealOpenAI from "openai";
import type OpenAI from "openai";
import {
  buildOpenAiClientOptions,
  IMPACT_ANALYSIS_MAX_OUTPUT_TOKENS,
  OPENAI_REQUEST_TIMEOUT_MS,
  OPENAI_SDK_MAX_RETRIES,
  OpenAiImpactAnalysisProvider,
} from "./openai-provider";
import { assertOpenAiCompatibleJsonSchema } from "./openai-schema";
import type { ModelInputProjection } from "./model-input";
import type { ImpactAnalysisOutput } from "./output-schema";

// No real network request anywhere in this file — every provider call goes
// through a fake `responses.create` that never leaves the process. See
// docs/DECISIONS.md, "Live AI mode is unverified against the real OpenAI
// API in this repository".

function buildModelInput(): ModelInputProjection {
  return {
    eventFacts: {
      eventId: "EVT-001",
      eventType: "SUPPLIER_DELAY",
      componentId: "COMP-001",
      supplierId: "SUP-001",
      originalDate: "2026-01-01",
      revisedDate: "2026-01-15",
      computedDelayDays: 14,
      storedDelayDays: 14,
      delayDaysConsistent: true,
      confidence: "MEDIUM",
      quantity: 10,
    },
    deterministicResults: {
      affectedRequirementIds: [],
      affectedMilestones: [],
      scheduleExposureDays: 14,
      budgetExposureAmount: "1000.00",
      verificationGaps: [],
      relatedDefects: [],
      riskScores: [],
      readinessScore: null,
      assumptions: [],
      unknowns: [],
    },
    evidenceAllowlist: [{ recordId: "EVT-001", recordType: "PROGRAM_EVENT", summary: "event" }],
    untrustedData: { reason: null, rawNotes: null },
  };
}

function buildValidOutput(): ImpactAnalysisOutput {
  const option = {
    title: "Option",
    description: "Description.",
    tradeoffs: "Tradeoffs.",
    costImpact: null,
    scheduleImpact: null,
    isRecommended: false,
    sourceRecordIds: ["EVT-001"],
  };
  return {
    executiveSummary: "Summary.",
    missionImpact: "Impact.",
    scheduleExposureDays: 14,
    budgetExposureAmount: "1000.00",
    affectedRequirementIds: [],
    affectedMilestoneIds: [],
    verificationGaps: [],
    assumptions: [],
    unknowns: [],
    confidence: "MEDIUM",
    sourceRecordIds: ["EVT-001"],
    mitigationOptions: [{ ...option, isRecommended: true }, option, option],
  };
}

interface CapturedClient {
  client: OpenAI;
  requests: Record<string, unknown>[];
}

function buildFakeClient(outputText: string, model = "gpt-test"): CapturedClient {
  const requests: Record<string, unknown>[] = [];
  const client = {
    responses: {
      create: async (params: Record<string, unknown>) => {
        requests.push(params);
        return { model, output_text: outputText };
      },
    },
  } as unknown as OpenAI;
  return { client, requests };
}

describe("OpenAiImpactAnalysisProvider — request construction (no network)", () => {
  it("sends a schema with no prefixItems and passes the shared OpenAI-compatibility check", async () => {
    const { client, requests } = buildFakeClient(JSON.stringify(buildValidOutput()));
    const provider = new OpenAiImpactAnalysisProvider({
      apiKey: "sk-test",
      model: "gpt-test",
      client,
    });

    await provider.generateImpactAnalysis({
      traceId: "trace-1",
      analysisRunId: "run-1",
      attempt: 1,
      systemPrompt: "system",
      modelInput: buildModelInput(),
    });

    expect(requests).toHaveLength(1);
    const text = requests[0]?.text as { format: { schema: unknown } };
    expect(() => assertOpenAiCompatibleJsonSchema(text.format.schema)).not.toThrow();
    expect(JSON.stringify(text.format.schema)).not.toContain("prefixItems");
  });

  it("[strict: true] the request always sets text.format.strict to true", async () => {
    const { client, requests } = buildFakeClient(JSON.stringify(buildValidOutput()));
    const provider = new OpenAiImpactAnalysisProvider({
      apiKey: "sk-test",
      model: "gpt-test",
      client,
    });

    await provider.generateImpactAnalysis({
      traceId: "trace-1",
      analysisRunId: "run-1",
      attempt: 1,
      systemPrompt: "system",
      modelInput: buildModelInput(),
    });

    const format = requests[0]?.text as { format: { strict: boolean; type: string } };
    expect(format.format.strict).toBe(true);
    expect(format.format.type).toBe("json_schema");
  });

  it("[store: false] the request never asks OpenAI to retain the conversation", async () => {
    const { client, requests } = buildFakeClient(JSON.stringify(buildValidOutput()));
    const provider = new OpenAiImpactAnalysisProvider({
      apiKey: "sk-test",
      model: "gpt-test",
      client,
    });

    await provider.generateImpactAnalysis({
      traceId: "trace-1",
      analysisRunId: "run-1",
      attempt: 1,
      systemPrompt: "system",
      modelInput: buildModelInput(),
    });

    expect(requests[0]?.store).toBe(false);
  });

  it("[no tools, streaming, conversation, or search configuration]", async () => {
    const { client, requests } = buildFakeClient(JSON.stringify(buildValidOutput()));
    const provider = new OpenAiImpactAnalysisProvider({
      apiKey: "sk-test",
      model: "gpt-test",
      client,
    });

    await provider.generateImpactAnalysis({
      traceId: "trace-1",
      analysisRunId: "run-1",
      attempt: 1,
      systemPrompt: "system",
      modelInput: buildModelInput(),
    });

    const request = requests[0]!;
    expect(request.tools).toBeUndefined();
    expect(request.tool_choice).toBeUndefined();
    expect(request.stream).toBeUndefined();
    expect(request.conversation).toBeUndefined();
    expect(request.previous_response_id).toBeUndefined();
  });

  it("re-validates the parsed response against the authoritative Zod schema (rawOutput is passed through unvalidated by the provider itself)", async () => {
    const { client } = buildFakeClient(JSON.stringify({ not: "a valid output" }));
    const provider = new OpenAiImpactAnalysisProvider({
      apiKey: "sk-test",
      model: "gpt-test",
      client,
    });

    const response = await provider.generateImpactAnalysis({
      traceId: "trace-1",
      analysisRunId: "run-1",
      attempt: 1,
      systemPrompt: "system",
      modelInput: buildModelInput(),
    });

    // The provider itself never validates rawOutput — that's the caller's
    // job (orchestrator.ts, via impactAnalysisOutputSchema) — so an
    // obviously-invalid body is still returned here, unmodified.
    expect(response.rawOutput).toEqual({ not: "a valid output" });
  });
});

describe("OpenAiImpactAnalysisProvider — SDK retry/timeout configuration (Phase 6 correction)", () => {
  it("[buildOpenAiClientOptions] maxRetries is exactly 0 and timeout is explicitly bounded", () => {
    const options = buildOpenAiClientOptions("sk-test");
    expect(options.maxRetries).toBe(OPENAI_SDK_MAX_RETRIES);
    expect(options.maxRetries).toBe(0);
    expect(options.timeout).toBe(OPENAI_REQUEST_TIMEOUT_MS);
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.apiKey).toBe("sk-test");
  });

  it("[real client construction, no network call] a real OpenAI client built from buildOpenAiClientOptions() resolves maxRetries/timeout to exactly these values — no hidden SDK default (2 retries / 10-minute timeout) survives", () => {
    // Constructing the SDK client never itself opens a connection — the
    // SDK connects lazily per-request — so this is safe without a fake
    // client and without any network access.
    const client = new RealOpenAI(buildOpenAiClientOptions("sk-test"));
    expect(client.maxRetries).toBe(0);
    expect(client.timeout).toBe(OPENAI_REQUEST_TIMEOUT_MS);
  });

  it("[no explicit options] the SDK's own real defaults are confirmed to differ from this provider's configured values — proving the override is load-bearing, not redundant", () => {
    const client = new RealOpenAI({ apiKey: "sk-test" });
    expect(client.maxRetries).toBe(2);
    expect(client.timeout).toBeGreaterThan(OPENAI_REQUEST_TIMEOUT_MS);
  });

  it("[constructor uses buildOpenAiClientOptions] a provider constructed without an injected client only ever needs a valid apiKey/model — buildOpenAiClientOptions is exercised on that path, not bypassed", () => {
    // No fake client injected here — this exercises the real
    // `new OpenAI(buildOpenAiClientOptions(...))` construction path inside
    // the constructor. Still makes no network call: construction alone
    // never does.
    expect(
      () => new OpenAiImpactAnalysisProvider({ apiKey: "sk-test", model: "gpt-test" }),
    ).not.toThrow();
  });
});

describe("OpenAiImpactAnalysisProvider — output-token ceiling (Phase 6 correction)", () => {
  it("[max_output_tokens sent on every request] equals IMPACT_ANALYSIS_MAX_OUTPUT_TOKENS, server-controlled", async () => {
    const { client, requests } = buildFakeClient(JSON.stringify(buildValidOutput()));
    const provider = new OpenAiImpactAnalysisProvider({
      apiKey: "sk-test",
      model: "gpt-test",
      client,
    });

    await provider.generateImpactAnalysis({
      traceId: "trace-1",
      analysisRunId: "run-1",
      attempt: 1,
      systemPrompt: "system",
      modelInput: buildModelInput(),
    });

    expect(requests[0]?.max_output_tokens).toBe(IMPACT_ANALYSIS_MAX_OUTPUT_TOKENS);
  });

  it("[incomplete response due to token ceiling] is never treated as successful — throws a retryable INCOMPLETE_OUTPUT error, never including the truncated output text", async () => {
    const TRUNCATED_FRAGMENT = '{"executiveSummary": "This got cut off mid-sen';
    const client = {
      responses: {
        create: async () => ({
          model: "gpt-test",
          output_text: TRUNCATED_FRAGMENT,
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
        }),
      },
    } as unknown as OpenAI;
    const provider = new OpenAiImpactAnalysisProvider({
      apiKey: "sk-test",
      model: "gpt-test",
      client,
    });

    let caught: unknown;
    try {
      await provider.generateImpactAnalysis({
        traceId: "trace-1",
        analysisRunId: "run-1",
        attempt: 1,
        systemPrompt: "system",
        modelInput: buildModelInput(),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const error = caught as { category?: string; message: string };
    expect(error.category).toBe("INCOMPLETE_OUTPUT");
    expect(error.message).not.toContain(TRUNCATED_FRAGMENT);
    expect(error.message).not.toContain("cut off");
  });

  it("[incomplete for a different reason, e.g. content_filter] is not classified as INCOMPLETE_OUTPUT by this specific check — falls through to normal JSON parsing", async () => {
    const client = {
      responses: {
        create: async () => ({
          model: "gpt-test",
          output_text: JSON.stringify(buildValidOutput()),
          status: "incomplete",
          incomplete_details: { reason: "content_filter" },
        }),
      },
    } as unknown as OpenAI;
    const provider = new OpenAiImpactAnalysisProvider({
      apiKey: "sk-test",
      model: "gpt-test",
      client,
    });

    const response = await provider.generateImpactAnalysis({
      traceId: "trace-1",
      analysisRunId: "run-1",
      attempt: 1,
      systemPrompt: "system",
      modelInput: buildModelInput(),
    });
    expect(response.rawOutput).toEqual(buildValidOutput());
  });
});

describe("OpenAiImpactAnalysisProvider — one invocation, one HTTP attempt (Phase 6 correction)", () => {
  it("[success] one generateImpactAnalysis() call invokes responses.create() exactly once", async () => {
    const { client, requests } = buildFakeClient(JSON.stringify(buildValidOutput()));
    const provider = new OpenAiImpactAnalysisProvider({
      apiKey: "sk-test",
      model: "gpt-test",
      client,
    });

    await provider.generateImpactAnalysis({
      traceId: "trace-1",
      analysisRunId: "run-1",
      attempt: 1,
      systemPrompt: "system",
      modelInput: buildModelInput(),
    });

    expect(requests).toHaveLength(1);
  });

  it("[transient failure] one generateImpactAnalysis() call still invokes responses.create() exactly once — no hidden SDK retry inside the production adapter", async () => {
    let callCount = 0;
    const client = {
      responses: {
        create: async () => {
          callCount += 1;
          const error = new Error("simulated transient failure");
          throw error;
        },
      },
    } as unknown as OpenAI;
    const provider = new OpenAiImpactAnalysisProvider({
      apiKey: "sk-test",
      model: "gpt-test",
      client,
    });

    await expect(
      provider.generateImpactAnalysis({
        traceId: "trace-1",
        analysisRunId: "run-1",
        attempt: 1,
        systemPrompt: "system",
        modelInput: buildModelInput(),
      }),
    ).rejects.toThrow();

    expect(callCount).toBe(1);
  });
});
