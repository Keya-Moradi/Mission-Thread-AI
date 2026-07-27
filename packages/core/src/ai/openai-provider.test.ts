import { afterEach, describe, expect, it } from "vitest";
import RealOpenAI from "openai";
import type OpenAI from "openai";
import {
  assertOpenAiResponseCompleted,
  buildOpenAiClientOptions,
  IMPACT_ANALYSIS_MAX_OUTPUT_TOKENS,
  OPENAI_REQUEST_TIMEOUT_MS,
  OPENAI_SDK_LOG_LEVEL,
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

// Every fake "success" response includes status: "completed" and
// incomplete_details: null explicitly — a production response from the
// real API always sets these; a fake that omits them is exactly the
// under-specified shape assertOpenAiResponseCompleted() is designed to
// reject rather than silently treat as usable. See docs/DECISIONS.md,
// "Phase 6 correction: provider-terminal-state and validation-error
// safety".
function buildFakeClient(outputText: string, model = "gpt-test"): CapturedClient {
  const requests: Record<string, unknown>[] = [];
  const client = {
    responses: {
      create: async (params: Record<string, unknown>) => {
        requests.push(params);
        return {
          model,
          output_text: outputText,
          status: "completed",
          incomplete_details: null,
          output: [],
        };
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

// ---------------------------------------------------------------------------
// Phase 6 correction (provider-terminal-state pass): a response is only
// ever eligible for JSON parsing when it is genuinely "completed" — every
// other terminal state (incomplete for any reason, an explicit refusal,
// failed/cancelled/non-terminal) is rejected before output_text is ever
// read. See assertOpenAiResponseCompleted() in openai-provider.ts and
// docs/DECISIONS.md, "Phase 6 correction: provider-terminal-state and
// validation-error safety".
// ---------------------------------------------------------------------------

function buildCompletedResponse(overrides: Record<string, unknown> = {}) {
  return {
    model: "gpt-test",
    output_text: JSON.stringify(buildValidOutput()),
    status: "completed",
    incomplete_details: null,
    output: [],
    ...overrides,
  };
}

function buildRefusalOutputItem(refusalText: string) {
  return {
    type: "message",
    id: "msg_1",
    role: "assistant",
    status: "completed",
    content: [{ type: "refusal", refusal: refusalText }],
  };
}

async function expectProviderError(
  client: OpenAI,
  expected: { category: string; forbiddenText: string[] },
) {
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
  expect(error.category).toBe(expected.category);
  for (const forbidden of expected.forbiddenText) {
    expect(error.message).not.toContain(forbidden);
  }
  return error;
}

describe("assertOpenAiResponseCompleted — terminal-state gate (Phase 6 correction)", () => {
  it("[completed] a genuinely completed response with valid JSON is accepted", () => {
    expect(() => assertOpenAiResponseCompleted(buildCompletedResponse() as never)).not.toThrow();
  });

  it("[max_output_tokens] throws INCOMPLETE_OUTPUT", () => {
    const response = buildCompletedResponse({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
    });
    try {
      assertOpenAiResponseCompleted(response as never);
      expect.unreachable("expected assertOpenAiResponseCompleted to throw");
    } catch (error) {
      expect((error as { category?: string }).category).toBe("INCOMPLETE_OUTPUT");
    }
  });

  it("[content_filter] throws PROVIDER_REFUSAL", () => {
    const response = buildCompletedResponse({
      status: "incomplete",
      incomplete_details: { reason: "content_filter" },
    });
    try {
      assertOpenAiResponseCompleted(response as never);
      expect.unreachable("expected assertOpenAiResponseCompleted to throw");
    } catch (error) {
      expect((error as { category?: string }).category).toBe("PROVIDER_REFUSAL");
    }
  });

  it("[unknown incomplete reason] never accepted — thrown as a safe, documented category", () => {
    const response = buildCompletedResponse({
      status: "incomplete",
      incomplete_details: { reason: "something_new_and_unrecognized" },
    });
    try {
      assertOpenAiResponseCompleted(response as never);
      expect.unreachable("expected assertOpenAiResponseCompleted to throw");
    } catch (error) {
      // Documented choice: treated as retryable rather than a permanent
      // refusal — see the doc comment on assertOpenAiResponseCompleted().
      expect((error as { category?: string }).category).toBe("TRANSIENT_PROVIDER_FAILURE");
    }
  });

  it("[incomplete with no reason at all] never accepted", () => {
    const response = buildCompletedResponse({ status: "incomplete", incomplete_details: {} });
    expect(() => assertOpenAiResponseCompleted(response as never)).toThrow();
  });

  it.each(["failed", "cancelled", "in_progress", "queued", "something_else_entirely", undefined])(
    "[non-terminal/unexpected status %s] never accepted, even with otherwise-valid JSON output_text",
    (status) => {
      const response = buildCompletedResponse({ status });
      let caught: unknown;
      try {
        assertOpenAiResponseCompleted(response as never);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as { category?: string }).category).toBe("TRANSIENT_PROVIDER_FAILURE");
    },
  );

  it("[explicit refusal, status completed] a completed response whose sole output content is a refusal is rejected as PROVIDER_REFUSAL, never parsed", () => {
    const response = buildCompletedResponse({
      output: [buildRefusalOutputItem("I can't help with that.")],
    });
    try {
      assertOpenAiResponseCompleted(response as never);
      expect.unreachable("expected assertOpenAiResponseCompleted to throw");
    } catch (error) {
      expect((error as { category?: string }).category).toBe("PROVIDER_REFUSAL");
    }
  });

  it("[undefined status, no incomplete_details] a bare/under-specified response (e.g. an older test fake) is never silently accepted", () => {
    const response = { model: "gpt-test", output_text: JSON.stringify(buildValidOutput()) };
    expect(() => assertOpenAiResponseCompleted(response as never)).toThrow();
  });
});

describe("OpenAiImpactAnalysisProvider — terminal-state handling end-to-end, no leaked text (Phase 6 correction)", () => {
  it("[max-output-token incomplete response] is retried exactly once by the orchestrator-facing contract: the provider throws INCOMPLETE_OUTPUT, never the truncated text", async () => {
    const TRUNCATED_FRAGMENT = '{"executiveSummary": "cut off mid-sentence and never repeated';
    const client = {
      responses: {
        create: async () =>
          buildCompletedResponse({
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
            output_text: TRUNCATED_FRAGMENT,
          }),
      },
    } as unknown as OpenAI;
    await expectProviderError(client, {
      category: "INCOMPLETE_OUTPUT",
      forbiddenText: [TRUNCATED_FRAGMENT, "cut off mid-sentence"],
    });
  });

  it("[content-filter incomplete response] throws PROVIDER_REFUSAL, exactly one responses.create() call, no leaked text", async () => {
    let callCount = 0;
    const client = {
      responses: {
        create: async () => {
          callCount += 1;
          return buildCompletedResponse({
            status: "incomplete",
            incomplete_details: { reason: "content_filter" },
            output_text: "irrelevant, never read",
          });
        },
      },
    } as unknown as OpenAI;
    await expectProviderError(client, {
      category: "PROVIDER_REFUSAL",
      forbiddenText: ["irrelevant, never read"],
    });
    expect(callCount).toBe(1);
  });

  it("[explicit refusal item] throws PROVIDER_REFUSAL, exactly one responses.create() call, refusal text never appears in the thrown error", async () => {
    const REFUSAL_TEXT = "I won't help apply unapproved program changes.";
    let callCount = 0;
    const client = {
      responses: {
        create: async () => {
          callCount += 1;
          return buildCompletedResponse({ output: [buildRefusalOutputItem(REFUSAL_TEXT)] });
        },
      },
    } as unknown as OpenAI;
    await expectProviderError(client, {
      category: "PROVIDER_REFUSAL",
      forbiddenText: [REFUSAL_TEXT, "apply unapproved"],
    });
    expect(callCount).toBe(1);
  });

  it("[failed status] never accepted even though output_text happens to contain otherwise-valid JSON", async () => {
    const client = {
      responses: {
        create: async () => buildCompletedResponse({ status: "failed" }),
      },
    } as unknown as OpenAI;
    const error = await expectProviderError(client, {
      category: "TRANSIENT_PROVIDER_FAILURE",
      forbiddenText: [],
    });
    // The valid-looking JSON body must never leak into the error either,
    // even though this particular case doesn't derive its message from it.
    expect(error.message).not.toContain("executiveSummary");
  });
});

describe("OpenAiImpactAnalysisProvider — SDK request/response logging disabled (Phase 6 correction)", () => {
  const ORIGINAL_OPENAI_LOG = process.env.OPENAI_LOG;

  afterEach(() => {
    if (ORIGINAL_OPENAI_LOG === undefined) {
      delete process.env.OPENAI_LOG;
    } else {
      process.env.OPENAI_LOG = ORIGINAL_OPENAI_LOG;
    }
  });

  it('[buildOpenAiClientOptions] logLevel is exactly "off"', () => {
    const options = buildOpenAiClientOptions("sk-test");
    expect(options.logLevel).toBe(OPENAI_SDK_LOG_LEVEL);
    expect(options.logLevel).toBe("off");
  });

  it('[real client, no network call] a real OpenAI client built from buildOpenAiClientOptions() reports its resolved logLevel as "off"', () => {
    const client = new RealOpenAI(buildOpenAiClientOptions("sk-test"));
    expect(client.logLevel).toBe("off");
  });

  it("[OPENAI_LOG=debug does not override the client option] the explicit logLevel option wins even when the ambient environment requests verbose logging", () => {
    process.env.OPENAI_LOG = "debug";
    const client = new RealOpenAI(buildOpenAiClientOptions("sk-test"));
    expect(client.logLevel).toBe("off");
  });

  it("[no explicit logLevel] the SDK falls back to OPENAI_LOG (or its own default) — confirms the override above is load-bearing, not redundant", () => {
    process.env.OPENAI_LOG = "debug";
    const client = new RealOpenAI({ apiKey: "sk-test" });
    expect(client.logLevel).toBe("debug");
  });

  it("[no request/response body reaches an injected logger] with logLevel: off and a fake client, no log line generated by the SDK's own logger contains prompt or output content — smoke-level guard against a future regression", async () => {
    const capturedLogLines: string[] = [];
    const capturingLogger = {
      error: (...args: unknown[]) => capturedLogLines.push(String(args)),
      warn: (...args: unknown[]) => capturedLogLines.push(String(args)),
      info: (...args: unknown[]) => capturedLogLines.push(String(args)),
      debug: (...args: unknown[]) => capturedLogLines.push(String(args)),
    };
    // A real client, configured exactly like production (logLevel: off,
    // plus an injected logger so anything that *did* get through would be
    // captured here instead of printed to the real console) — but its
    // network layer is never exercised (no request is actually made), so
    // this only proves the logger receives nothing at construction time,
    // matching the "off" contract.
    void new RealOpenAI({ ...buildOpenAiClientOptions("sk-test"), logger: capturingLogger });
    expect(capturedLogLines).toHaveLength(0);
  });

  it("[maxRetries, timeout, and logLevel are all set together] confirms this correction pass didn't disturb the existing Phase 6 SDK configuration", () => {
    const options = buildOpenAiClientOptions("sk-test");
    expect(options.maxRetries).toBe(OPENAI_SDK_MAX_RETRIES);
    expect(options.timeout).toBe(OPENAI_REQUEST_TIMEOUT_MS);
    expect(options.logLevel).toBe(OPENAI_SDK_LOG_LEVEL);
  });

  it("[max_output_tokens, strict schema, store:false unchanged] a normal successful request still carries every previously-established Phase 6 control", async () => {
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
    expect(request.max_output_tokens).toBe(IMPACT_ANALYSIS_MAX_OUTPUT_TOKENS);
    expect(request.store).toBe(false);
    const format = request.text as { format: { strict: boolean } };
    expect(format.format.strict).toBe(true);
  });
});
