import { describe, expect, it } from "vitest";
import {
  impactAnalysisOutputSchema,
  MAX_DECIMAL_12_2_INTEGER_DIGITS,
  MAX_MITIGATION_SCHEDULE_IMPACT_DAYS,
  MIN_MITIGATION_SCHEDULE_IMPACT_DAYS,
  persistedMoneyStringSchema,
} from "./output-schema";

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

describe("persistedMoneyStringSchema — Decimal(12,2) database-safe bound", () => {
  it(`[boundary: max integer digits (${MAX_DECIMAL_12_2_INTEGER_DIGITS})] a 10-digit integer portion passes`, () => {
    expect(persistedMoneyStringSchema.safeParse("9999999999.99").success).toBe(true);
  });

  it("[boundary: zero] 0.00 passes", () => {
    expect(persistedMoneyStringSchema.safeParse("0.00").success).toBe(true);
  });

  it("[over boundary] an 11-digit integer portion fails", () => {
    expect(persistedMoneyStringSchema.safeParse("10000000000.00").success).toBe(false);
  });

  it("[well over boundary] a 12-digit integer portion fails", () => {
    expect(persistedMoneyStringSchema.safeParse("999999999999.99").success).toBe(false);
  });

  it("[single decimal digit] 1.0 fails — exactly two decimal digits are required", () => {
    expect(persistedMoneyStringSchema.safeParse("1.0").success).toBe(false);
  });

  it("[currency symbol] $1.00 fails", () => {
    expect(persistedMoneyStringSchema.safeParse("$1.00").success).toBe(false);
  });

  it("[applied at the output-schema boundary] budgetExposureAmount rejects an eleven-digit value", () => {
    const result = impactAnalysisOutputSchema.safeParse(
      validOutput({ budgetExposureAmount: "10000000000.00" }),
    );
    expect(result.success).toBe(false);
  });

  it("[applied at the output-schema boundary] a mitigation option's costImpact rejects an eleven-digit value", () => {
    const result = impactAnalysisOutputSchema.safeParse(
      validOutput({
        mitigationOptions: [
          validOption({ isRecommended: true, costImpact: "10000000000.00" }),
          validOption(),
          validOption(),
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it("[applied at the output-schema boundary] budgetExposureAmount accepts the maximum 10-digit value", () => {
    const result = impactAnalysisOutputSchema.safeParse(
      validOutput({ budgetExposureAmount: "9999999999.99" }),
    );
    expect(result.success).toBe(true);
  });
});

describe("mitigationOptions[*].scheduleImpact — documented business range", () => {
  it(`[boundary: min] ${MIN_MITIGATION_SCHEDULE_IMPACT_DAYS} passes`, () => {
    const result = impactAnalysisOutputSchema.safeParse(
      validOutput({
        mitigationOptions: [
          validOption({ isRecommended: true, scheduleImpact: MIN_MITIGATION_SCHEDULE_IMPACT_DAYS }),
          validOption(),
          validOption(),
        ],
      }),
    );
    expect(result.success).toBe(true);
  });

  it(`[boundary: max] ${MAX_MITIGATION_SCHEDULE_IMPACT_DAYS} passes`, () => {
    const result = impactAnalysisOutputSchema.safeParse(
      validOutput({
        mitigationOptions: [
          validOption({ isRecommended: true, scheduleImpact: MAX_MITIGATION_SCHEDULE_IMPACT_DAYS }),
          validOption(),
          validOption(),
        ],
      }),
    );
    expect(result.success).toBe(true);
  });

  it("[over boundary: min - 1] fails", () => {
    const result = impactAnalysisOutputSchema.safeParse(
      validOutput({
        mitigationOptions: [
          validOption({
            isRecommended: true,
            scheduleImpact: MIN_MITIGATION_SCHEDULE_IMPACT_DAYS - 1,
          }),
          validOption(),
          validOption(),
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it("[over boundary: max + 1] fails", () => {
    const result = impactAnalysisOutputSchema.safeParse(
      validOutput({
        mitigationOptions: [
          validOption({
            isRecommended: true,
            scheduleImpact: MAX_MITIGATION_SCHEDULE_IMPACT_DAYS + 1,
          }),
          validOption(),
          validOption(),
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it("[non-integer] fails", () => {
    const result = impactAnalysisOutputSchema.safeParse(
      validOutput({
        mitigationOptions: [
          validOption({ isRecommended: true, scheduleImpact: 12.5 }),
          validOption(),
          validOption(),
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it("[null is still allowed] a mitigation option may omit a proposed schedule impact", () => {
    const result = impactAnalysisOutputSchema.safeParse(
      validOutput({
        mitigationOptions: [
          validOption({ isRecommended: true, scheduleImpact: null }),
          validOption(),
          validOption(),
        ],
      }),
    );
    expect(result.success).toBe(true);
  });
});
