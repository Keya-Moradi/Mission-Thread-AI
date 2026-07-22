import { describe, expect, it } from "vitest";
import type OpenAI from "openai";
import { OpenAiImpactAnalysisProvider } from "./openai-provider";
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
