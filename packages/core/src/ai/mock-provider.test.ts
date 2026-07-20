import { describe, expect, it } from "vitest";
import { buildAnalysisEvidence } from "../analysis/evidence";
import { EVENT_IDS } from "../seed/ids";
import { buildModelInputProjection } from "./model-input";
import { generateMockImpactAnalysis, MockLLMProvider } from "./mock-provider";
import { impactAnalysisOutputSchema } from "./output-schema";
import { validateImpactAnalysisSemantics } from "./output-validation";

async function seededModelInput() {
  const evidenceResult = await buildAnalysisEvidence(EVENT_IDS.supplierDelay);
  if (!evidenceResult.ok) throw new Error("seed evidence unavailable");
  return buildModelInputProjection(evidenceResult.data);
}

describe("generateMockImpactAnalysis — structural and semantic validity", () => {
  it("produces output that passes the production output schema", async () => {
    const modelInput = await seededModelInput();
    const output = generateMockImpactAnalysis(modelInput);
    const parsed = impactAnalysisOutputSchema.safeParse(output);
    expect(parsed.success).toBe(true);
  });

  it("produces output that passes semantic validation against its own model input", async () => {
    const modelInput = await seededModelInput();
    const output = generateMockImpactAnalysis(modelInput);
    const parsed = impactAnalysisOutputSchema.parse(output);
    const semantic = validateImpactAnalysisSemantics(parsed, modelInput);
    expect(semantic.valid).toBe(true);
    expect(semantic.errors).toEqual([]);
  });

  it("[exactly 3 options, exactly 1 recommended]", async () => {
    const modelInput = await seededModelInput();
    const output = generateMockImpactAnalysis(modelInput);
    expect(output.mitigationOptions).toHaveLength(3);
    expect(output.mitigationOptions.filter((o) => o.isRecommended)).toHaveLength(1);
  });

  it("[no invented monetary/date values] scheduleExposureDays and budgetExposureAmount exactly echo the deterministic input", async () => {
    const modelInput = await seededModelInput();
    const output = generateMockImpactAnalysis(modelInput);
    expect(output.scheduleExposureDays).toBe(modelInput.deterministicResults.scheduleExposureDays);
    expect(output.budgetExposureAmount).toBe(modelInput.deterministicResults.budgetExposureAmount);
    // Every option's costImpact is either null or a value already present
    // in the deterministic input — never an invented number.
    for (const option of output.mitigationOptions) {
      if (option.costImpact !== null) {
        expect(option.costImpact).toBe(modelInput.deterministicResults.budgetExposureAmount);
      }
      if (option.scheduleImpact !== null) {
        expect(option.scheduleImpact).toBe(modelInput.deterministicResults.scheduleExposureDays);
      }
    }
  });

  it("[deterministic repeatability] identical model input produces byte-identical output", async () => {
    const modelInput = await seededModelInput();
    const first = generateMockImpactAnalysis(modelInput);
    const second = generateMockImpactAnalysis(modelInput);
    expect(first).toEqual(second);
  });

  it("[valid citations only] every cited source ID exists in the evidence allowlist", async () => {
    const modelInput = await seededModelInput();
    const output = generateMockImpactAnalysis(modelInput);
    const allowlistIds = new Set(modelInput.evidenceAllowlist.map((item) => item.recordId));
    for (const id of output.sourceRecordIds) {
      expect(allowlistIds.has(id)).toBe(true);
    }
    for (const option of output.mitigationOptions) {
      for (const id of option.sourceRecordIds) {
        expect(allowlistIds.has(id)).toBe(true);
      }
    }
  });
});

describe("MockLLMProvider", () => {
  it("[no network] generateImpactAnalysis resolves purely from the supplied modelInput", async () => {
    const modelInput = await seededModelInput();
    const provider = new MockLLMProvider();
    const response = await provider.generateImpactAnalysis({
      traceId: "trace-1",
      analysisRunId: "run-1",
      attempt: 1,
      systemPrompt: "unused by the mock provider",
      modelInput,
    });
    expect(response.provider).toBe("mock");
    expect(impactAnalysisOutputSchema.safeParse(response.rawOutput).success).toBe(true);
  });

  it("[trace/run/attempt never affect content] two calls with different trace IDs produce identical rawOutput", async () => {
    const modelInput = await seededModelInput();
    const provider = new MockLLMProvider();
    const first = await provider.generateImpactAnalysis({
      traceId: "trace-a",
      analysisRunId: "run-a",
      attempt: 1,
      systemPrompt: "x",
      modelInput,
    });
    const second = await provider.generateImpactAnalysis({
      traceId: "trace-b",
      analysisRunId: "run-b",
      attempt: 2,
      systemPrompt: "x",
      modelInput,
    });
    expect(first.rawOutput).toEqual(second.rawOutput);
  });
});
