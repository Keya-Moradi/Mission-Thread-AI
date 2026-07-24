import { describe, expect, it } from "vitest";
import type { ModelInputProjection } from "./model-input";
import { generateMockImpactAnalysis } from "./mock-provider";
import { validateProviderOutput } from "./validate-provider-output";

// A small, self-contained, schema-valid ModelInputProjection — this file
// tests validateProviderOutput() in isolation, so it deliberately never
// touches the database (unlike orchestrator.test.ts, which exercises the
// same rules through the full live orchestration path).
const MODEL_INPUT: ModelInputProjection = {
  eventFacts: {
    eventId: "EVT-UNIT-TEST",
    eventType: "SUPPLIER_DELAY",
    componentId: "COMP-UNIT-TEST",
    supplierId: null,
    originalDate: "2026-01-01",
    revisedDate: "2026-01-08",
    computedDelayDays: 7,
    storedDelayDays: 7,
    delayDaysConsistent: true,
    confidence: "MEDIUM",
    quantity: 1,
  },
  deterministicResults: {
    affectedRequirementIds: ["REQ-UNIT-TEST"],
    affectedMilestones: [
      { milestoneId: "MS-UNIT-TEST", status: "AT_RISK", relationship: "direct" },
    ],
    scheduleExposureDays: 7,
    budgetExposureAmount: "1000.00",
    verificationGaps: [],
    relatedDefects: [],
    riskScores: [],
    readinessScore: null,
    assumptions: [],
    unknowns: [],
  },
  evidenceAllowlist: [
    { recordId: "EVT-UNIT-TEST", recordType: "PROGRAM_EVENT", summary: "Unit-test event." },
    { recordId: "COMP-UNIT-TEST", recordType: "COMPONENT", summary: "Unit-test component." },
    { recordId: "REQ-UNIT-TEST", recordType: "REQUIREMENT", summary: "Unit-test requirement." },
    { recordId: "MS-UNIT-TEST", recordType: "MILESTONE", summary: "Unit-test milestone." },
  ],
  untrustedData: { reason: null, rawNotes: null },
};

describe("validateProviderOutput", () => {
  it("[valid] a real mock-generated output validates and returns the parsed output", () => {
    const rawOutput = generateMockImpactAnalysis(MODEL_INPUT);
    const result = validateProviderOutput(rawOutput, MODEL_INPUT);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.output.mitigationOptions).toHaveLength(3);
  });

  it("[never throws] completely malformed input (not even an object) is reported, not thrown", () => {
    expect(() => validateProviderOutput("not an object at all", MODEL_INPUT)).not.toThrow();
    expect(() => validateProviderOutput(null, MODEL_INPUT)).not.toThrow();
    expect(() => validateProviderOutput(undefined, MODEL_INPUT)).not.toThrow();
    expect(() => validateProviderOutput(42, MODEL_INPUT)).not.toThrow();
    const result = validateProviderOutput(null, MODEL_INPUT);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.category).toBe("INVALID_OUTPUT_SCHEMA");
  });

  it("[extra fields rejected] approved/applyNow/decision/toolCall/sql/mutation are all rejected by the strict schema", () => {
    const base = generateMockImpactAnalysis(MODEL_INPUT);
    const rawOutput = {
      ...base,
      approved: true,
      applyNow: true,
      decision: "APPROVED",
      toolCall: { name: "applyApprovedChanges" },
      sql: 'DROP TABLE "MitigationOption"',
      mutation: "APPLY_ALL",
    };
    const result = validateProviderOutput(rawOutput, MODEL_INPUT);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.category).toBe("INVALID_OUTPUT_SCHEMA");
  });

  it("[invalid source ID named in errors] a fabricated source ID is rejected and named in the returned errors", () => {
    const base = generateMockImpactAnalysis(MODEL_INPUT);
    const rawOutput = { ...base, sourceRecordIds: ["FAKE-RECORD-999"] };
    const result = validateProviderOutput(rawOutput, MODEL_INPUT);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.category).toBe("SEMANTIC_VALIDATION_FAILED");
    expect(result.errors.some((e) => e.includes("FAKE-RECORD-999"))).toBe(true);
  });

  it("[wrong record type rejected] a milestone ID placed in affectedRequirementIds is rejected", () => {
    const base = generateMockImpactAnalysis(MODEL_INPUT);
    const rawOutput = { ...base, affectedRequirementIds: ["MS-UNIT-TEST"] };
    const result = validateProviderOutput(rawOutput, MODEL_INPUT);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.category).toBe("SEMANTIC_VALIDATION_FAILED");
  });

  it("[wrong option count rejected] two mitigation options instead of exactly three", () => {
    const base = generateMockImpactAnalysis(MODEL_INPUT);
    const rawOutput = { ...base, mitigationOptions: base.mitigationOptions.slice(0, 2) };
    const result = validateProviderOutput(rawOutput, MODEL_INPUT);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.category).toBe("INVALID_OUTPUT_SCHEMA");
  });

  it("[deterministic-value tampering rejected] a schedule exposure that disagrees with the deterministic input", () => {
    const base = generateMockImpactAnalysis(MODEL_INPUT);
    const rawOutput = { ...base, scheduleExposureDays: 999 };
    const result = validateProviderOutput(rawOutput, MODEL_INPUT);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.category).toBe("SEMANTIC_VALIDATION_FAILED");
  });

  it("[pure] never mutates its inputs", () => {
    const rawOutput = generateMockImpactAnalysis(MODEL_INPUT);
    const rawOutputCopy = JSON.parse(JSON.stringify(rawOutput));
    const modelInputCopy = JSON.parse(JSON.stringify(MODEL_INPUT));
    validateProviderOutput(rawOutput, MODEL_INPUT);
    expect(rawOutput).toEqual(rawOutputCopy);
    expect(MODEL_INPUT).toEqual(modelInputCopy);
  });
});
