import { describe, expect, it } from "vitest";
import type { ModelInputProjection } from "./model-input";
import type { ImpactAnalysisOutput } from "./output-schema";
import { validateImpactAnalysisSemantics } from "./output-validation";

function buildModelInput(overrides: Partial<ModelInputProjection> = {}): ModelInputProjection {
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
      affectedRequirementIds: ["REQ-001"],
      affectedMilestones: [{ milestoneId: "MS-001", status: "AT_RISK", relationship: "direct" }],
      scheduleExposureDays: 14,
      budgetExposureAmount: "1000.00",
      verificationGaps: [{ requirementId: "REQ-001", gapCategory: "FAILED" }],
      relatedDefects: [],
      riskScores: [],
      readinessScore: null,
      assumptions: [],
      unknowns: [],
    },
    evidenceAllowlist: [
      { recordId: "EVT-001", recordType: "PROGRAM_EVENT", summary: "event" },
      { recordId: "REQ-001", recordType: "REQUIREMENT", summary: "requirement" },
      { recordId: "MS-001", recordType: "MILESTONE", summary: "milestone" },
    ],
    untrustedData: { reason: null, rawNotes: null },
    ...overrides,
  };
}

function buildOption(overrides: Partial<ImpactAnalysisOutput["mitigationOptions"][number]> = {}) {
  return {
    title: "Option",
    description: "Description.",
    tradeoffs: "Tradeoffs.",
    costImpact: null,
    scheduleImpact: null,
    isRecommended: false,
    sourceRecordIds: ["EVT-001"],
    ...overrides,
  };
}

function buildOutput(overrides: Partial<ImpactAnalysisOutput> = {}): ImpactAnalysisOutput {
  return {
    executiveSummary: "Summary.",
    missionImpact: "Impact.",
    scheduleExposureDays: 14,
    budgetExposureAmount: "1000.00",
    affectedRequirementIds: ["REQ-001"],
    affectedMilestoneIds: ["MS-001"],
    verificationGaps: [{ requirementId: "REQ-001", category: "FAILED", summary: "gap" }],
    assumptions: [],
    unknowns: [],
    confidence: "MEDIUM",
    sourceRecordIds: ["EVT-001"],
    mitigationOptions: [buildOption({ isRecommended: true }), buildOption(), buildOption()],
    ...overrides,
  };
}

describe("validateImpactAnalysisSemantics — valid input", () => {
  it("passes when every claim matches the model input", () => {
    const result = validateImpactAnalysisSemantics(buildOutput(), buildModelInput());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

describe("validateImpactAnalysisSemantics — source-ID allowlisting", () => {
  it("[fabricated top-level source ID] rejects an ID not in the evidence allowlist", () => {
    const result = validateImpactAnalysisSemantics(
      buildOutput({ sourceRecordIds: ["EVT-001", "REQ-FABRICATED"] }),
      buildModelInput(),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("REQ-FABRICATED"))).toBe(true);
  });

  it("[fabricated per-option source ID] rejects an ID not in the evidence allowlist", () => {
    const result = validateImpactAnalysisSemantics(
      buildOutput({
        mitigationOptions: [
          buildOption({ isRecommended: true, sourceRecordIds: ["MS-FABRICATED"] }),
          buildOption(),
          buildOption(),
        ],
      }),
      buildModelInput(),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("MS-FABRICATED"))).toBe(true);
  });

  it("[valid citations] a citation that matches a real allowlisted ID is accepted", () => {
    const result = validateImpactAnalysisSemantics(
      buildOutput({ sourceRecordIds: ["EVT-001", "REQ-001", "MS-001"] }),
      buildModelInput(),
    );
    expect(result.valid).toBe(true);
  });
});

describe("validateImpactAnalysisSemantics — record-type correctness", () => {
  it("[wrong record type] rejects a MILESTONE ID used as an affected requirement", () => {
    const result = validateImpactAnalysisSemantics(
      buildOutput({ affectedRequirementIds: ["MS-001"] }),
      buildModelInput(),
    );
    expect(result.valid).toBe(false);
  });

  it("[fabricated requirement ID] rejects an affected requirement ID absent from the allowlist entirely", () => {
    const result = validateImpactAnalysisSemantics(
      buildOutput({ affectedRequirementIds: ["REQ-FABRICATED"] }),
      buildModelInput(),
    );
    expect(result.valid).toBe(false);
  });

  it("[fabricated milestone ID] rejects an affected milestone ID absent from the allowlist entirely", () => {
    const result = validateImpactAnalysisSemantics(
      buildOutput({ affectedMilestoneIds: ["MS-FABRICATED"] }),
      buildModelInput(),
    );
    expect(result.valid).toBe(false);
  });

  it("[verification gap references an unlisted requirement] rejected", () => {
    const result = validateImpactAnalysisSemantics(
      buildOutput({
        verificationGaps: [{ requirementId: "REQ-FABRICATED", category: "FAILED", summary: "gap" }],
      }),
      buildModelInput(),
    );
    expect(result.valid).toBe(false);
  });
});

describe("validateImpactAnalysisSemantics — deterministic equality", () => {
  it("[schedule mismatch] rejects a scheduleExposureDays that disagrees with the deterministic value", () => {
    const result = validateImpactAnalysisSemantics(
      buildOutput({ scheduleExposureDays: 999 }),
      buildModelInput(),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("scheduleExposureDays"))).toBe(true);
  });

  it("[budget mismatch] rejects a budgetExposureAmount that disagrees with the deterministic value", () => {
    const result = validateImpactAnalysisSemantics(
      buildOutput({ budgetExposureAmount: "9999.99" }),
      buildModelInput(),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("budgetExposureAmount"))).toBe(true);
  });

  it("[null vs a deterministic non-null value] is also a mismatch, not silently accepted", () => {
    const result = validateImpactAnalysisSemantics(
      buildOutput({ scheduleExposureDays: null }),
      buildModelInput(),
    );
    expect(result.valid).toBe(false);
  });
});

describe("validateImpactAnalysisSemantics — duplicate IDs", () => {
  it("[duplicate top-level source IDs] rejected", () => {
    const result = validateImpactAnalysisSemantics(
      buildOutput({ sourceRecordIds: ["EVT-001", "EVT-001"] }),
      buildModelInput(),
    );
    expect(result.valid).toBe(false);
  });

  it("[duplicate affected requirement IDs] rejected", () => {
    const result = validateImpactAnalysisSemantics(
      buildOutput({ affectedRequirementIds: ["REQ-001", "REQ-001"] }),
      buildModelInput(),
    );
    expect(result.valid).toBe(false);
  });

  it("[duplicate per-option source IDs] rejected", () => {
    const result = validateImpactAnalysisSemantics(
      buildOutput({
        mitigationOptions: [
          buildOption({ isRecommended: true, sourceRecordIds: ["EVT-001", "EVT-001"] }),
          buildOption(),
          buildOption(),
        ],
      }),
      buildModelInput(),
    );
    expect(result.valid).toBe(false);
  });
});
