import { describe, expect, it } from "vitest";
import { impactAnalysisOutputSchema } from "./output-schema";

function validOption(overrides: Record<string, unknown> = {}) {
  return {
    title: "Option title",
    description: "Option description.",
    tradeoffs: "Some tradeoffs.",
    costImpact: null,
    scheduleImpact: null,
    isRecommended: false,
    sourceRecordIds: ["EVT-001"],
    ...overrides,
  };
}

function validOutput(overrides: Record<string, unknown> = {}) {
  return {
    executiveSummary: "A summary.",
    missionImpact: "An impact statement.",
    scheduleExposureDays: 28,
    budgetExposureAmount: "480000.00",
    affectedRequirementIds: ["REQ-001"],
    affectedMilestoneIds: ["MS-001"],
    verificationGaps: [],
    assumptions: ["An assumption."],
    unknowns: ["An unknown."],
    confidence: "MEDIUM",
    sourceRecordIds: ["EVT-001"],
    mitigationOptions: [validOption({ isRecommended: true }), validOption(), validOption()],
    ...overrides,
  };
}

describe("impactAnalysisOutputSchema — valid input", () => {
  it("accepts a well-formed output", () => {
    const result = impactAnalysisOutputSchema.safeParse(validOutput());
    expect(result.success).toBe(true);
  });

  it("accepts null scheduleExposureDays/budgetExposureAmount", () => {
    const result = impactAnalysisOutputSchema.safeParse(
      validOutput({ scheduleExposureDays: null, budgetExposureAmount: null }),
    );
    expect(result.success).toBe(true);
  });
});

describe("impactAnalysisOutputSchema — mitigation option count and recommendation", () => {
  it("[wrong option count, too few] rejects 2 options", () => {
    const result = impactAnalysisOutputSchema.safeParse(
      validOutput({ mitigationOptions: [validOption({ isRecommended: true }), validOption()] }),
    );
    expect(result.success).toBe(false);
  });

  it("[wrong option count, too many] rejects 4 options", () => {
    const result = impactAnalysisOutputSchema.safeParse(
      validOutput({
        mitigationOptions: [
          validOption({ isRecommended: true }),
          validOption(),
          validOption(),
          validOption(),
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it("[zero recommended] rejects when no option is recommended", () => {
    const result = impactAnalysisOutputSchema.safeParse(
      validOutput({ mitigationOptions: [validOption(), validOption(), validOption()] }),
    );
    expect(result.success).toBe(false);
  });

  it("[multiple recommended] rejects when more than one option is recommended", () => {
    const result = impactAnalysisOutputSchema.safeParse(
      validOutput({
        mitigationOptions: [
          validOption({ isRecommended: true }),
          validOption({ isRecommended: true }),
          validOption(),
        ],
      }),
    );
    expect(result.success).toBe(false);
  });
});

describe("impactAnalysisOutputSchema — field constraints", () => {
  it("[oversized text] rejects an executiveSummary beyond the documented max length", () => {
    const result = impactAnalysisOutputSchema.safeParse(
      validOutput({ executiveSummary: "x".repeat(1001) }),
    );
    expect(result.success).toBe(false);
  });

  it("[malformed monetary value] rejects a budgetExposureAmount without two decimal places", () => {
    const result = impactAnalysisOutputSchema.safeParse(
      validOutput({ budgetExposureAmount: "480000" }),
    );
    expect(result.success).toBe(false);
  });

  it("[malformed monetary value] rejects a currency-symbol-prefixed budgetExposureAmount", () => {
    const result = impactAnalysisOutputSchema.safeParse(
      validOutput({ budgetExposureAmount: "$480000.00" }),
    );
    expect(result.success).toBe(false);
  });

  it("[malformed monetary value] rejects a non-2-decimal option costImpact", () => {
    const result = impactAnalysisOutputSchema.safeParse(
      validOutput({
        mitigationOptions: [
          validOption({ isRecommended: true, costImpact: "100.5" }),
          validOption(),
          validOption(),
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it("[unexpected keys] rejects an extra top-level property", () => {
    const result = impactAnalysisOutputSchema.safeParse({ ...validOutput(), extra: "not allowed" });
    expect(result.success).toBe(false);
  });

  it("[unexpected keys] rejects an extra mitigation-option property", () => {
    const result = impactAnalysisOutputSchema.safeParse(
      validOutput({
        mitigationOptions: [
          validOption({ isRecommended: true, extra: "not allowed" }),
          validOption(),
          validOption(),
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it("[empty source IDs] rejects an option with zero sourceRecordIds", () => {
    const result = impactAnalysisOutputSchema.safeParse(
      validOutput({
        mitigationOptions: [
          validOption({ isRecommended: true, sourceRecordIds: [] }),
          validOption(),
          validOption(),
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it("[empty top-level source IDs] rejects a top-level sourceRecordIds of zero length", () => {
    const result = impactAnalysisOutputSchema.safeParse(validOutput({ sourceRecordIds: [] }));
    expect(result.success).toBe(false);
  });

  it("[invalid confidence] rejects a value outside LOW/MEDIUM/HIGH", () => {
    const result = impactAnalysisOutputSchema.safeParse(validOutput({ confidence: "VERY_HIGH" }));
    expect(result.success).toBe(false);
  });
});
