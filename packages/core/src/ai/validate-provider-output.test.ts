import { describe, expect, it } from "vitest";
import type { ModelInputProjection } from "./model-input";
import { generateMockImpactAnalysis } from "./mock-provider";
import {
  MAX_PROVIDER_OUTPUT_BYTES,
  MAX_VALIDATION_ERROR_COUNT,
  MAX_VALIDATION_ERROR_LENGTH,
  MAX_VALIDATION_FEEDBACK_BYTES,
  sanitizeProviderValidationErrors,
  validateProviderOutput,
} from "./validate-provider-output";

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

  it("[invalid source ID identified by path, never echoed] a fabricated source ID is rejected, identified by array index, and never appears in the returned errors", () => {
    const base = generateMockImpactAnalysis(MODEL_INPUT);
    const rawOutput = { ...base, sourceRecordIds: ["FAKE-RECORD-999"] };
    const result = validateProviderOutput(rawOutput, MODEL_INPUT);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.category).toBe("SEMANTIC_VALIDATION_FAILED");
    expect(result.errors).toContain(
      "sourceRecordIds[0] is not in the supplied evidence allowlist.",
    );
    expect(result.errors.some((e) => e.includes("FAKE-RECORD-999"))).toBe(false);
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

  it("[oversized total output rejected] a response over MAX_PROVIDER_OUTPUT_BYTES is rejected before structural validation, with a fixed safe message", () => {
    const base = generateMockImpactAnalysis(MODEL_INPUT);
    // A single field padded well past the byte ceiling — still otherwise
    // shaped like a plausible response, so this exercises the size guard
    // specifically, not just "not an object."
    const rawOutput = { ...base, executiveSummary: "x".repeat(MAX_PROVIDER_OUTPUT_BYTES + 1) };
    const result = validateProviderOutput(rawOutput, MODEL_INPUT);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.category).toBe("INVALID_OUTPUT_SCHEMA");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).not.toContain("x".repeat(100));
  });

  it("[circular object never throws] a raw output containing a circular reference returns a safe invalid result instead of throwing", () => {
    const circular: Record<string, unknown> = { executiveSummary: "test" };
    circular.self = circular;
    expect(() => validateProviderOutput(circular, MODEL_INPUT)).not.toThrow();
    const result = validateProviderOutput(circular, MODEL_INPUT);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.category).toBe("INVALID_OUTPUT_SCHEMA");
  });

  it("[giant fabricated ID never appears in validation errors] an extremely long fabricated source ID is rejected without being echoed back", () => {
    const base = generateMockImpactAnalysis(MODEL_INPUT);
    const giantCanary = "GIANT-CANARY-" + "A".repeat(5000);
    const rawOutput = { ...base, sourceRecordIds: [giantCanary] };
    const result = validateProviderOutput(rawOutput, MODEL_INPUT);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    // Rejected structurally (exceeds maxRecordIdLength) before semantic
    // validation ever runs — either way, the canary must never appear.
    for (const error of result.errors) {
      expect(error).not.toContain(giantCanary);
      expect(error).not.toContain("GIANT-CANARY");
    }
  });

  it("[pure] never mutates its inputs", () => {
    const rawOutput = generateMockImpactAnalysis(MODEL_INPUT);
    const rawOutputCopy = JSON.parse(JSON.stringify(rawOutput));
    const modelInputCopy = JSON.parse(JSON.stringify(MODEL_INPUT));
    validateProviderOutput(rawOutput, MODEL_INPUT);
    expect(rawOutput).toEqual(rawOutputCopy);
    expect(MODEL_INPUT).toEqual(modelInputCopy);
  });

  it("[valid mock output for every scenario shape still passes] a minimal, a maximal-evidence, and a null-exposure model input all still validate", () => {
    const minimal: ModelInputProjection = {
      ...MODEL_INPUT,
      evidenceAllowlist: [MODEL_INPUT.evidenceAllowlist[0]!],
      deterministicResults: {
        ...MODEL_INPUT.deterministicResults,
        affectedRequirementIds: [],
        affectedMilestones: [],
        scheduleExposureDays: null,
        budgetExposureAmount: null,
      },
    };
    const rawOutput = generateMockImpactAnalysis(minimal);
    const result = validateProviderOutput(rawOutput, minimal);
    expect(result.valid).toBe(true);
  });
});

describe("sanitizeProviderValidationErrors", () => {
  it("[count cap] more than MAX_VALIDATION_ERROR_COUNT errors are truncated to exactly that many", () => {
    const errors = Array.from({ length: MAX_VALIDATION_ERROR_COUNT + 50 }, (_, i) => `error ${i}`);
    const sanitized = sanitizeProviderValidationErrors(errors);
    expect(sanitized.length).toBeLessThanOrEqual(MAX_VALIDATION_ERROR_COUNT);
  });

  it("[per-error length cap] a single oversized error is truncated to MAX_VALIDATION_ERROR_LENGTH", () => {
    const sanitized = sanitizeProviderValidationErrors(["x".repeat(10_000)]);
    expect(sanitized[0]?.length).toBeLessThanOrEqual(MAX_VALIDATION_ERROR_LENGTH);
  });

  it("[total byte cap] many moderately-sized errors are cut off once MAX_VALIDATION_FEEDBACK_BYTES would be exceeded", () => {
    const errors = Array.from({ length: MAX_VALIDATION_ERROR_COUNT }, () => "x".repeat(300));
    const sanitized = sanitizeProviderValidationErrors(errors);
    const totalBytes = sanitized.reduce((sum, e) => sum + Buffer.byteLength(e, "utf8"), 0);
    expect(totalBytes).toBeLessThanOrEqual(MAX_VALIDATION_FEEDBACK_BYTES);
  });

  it("[small, safe input passes through unchanged]", () => {
    const errors = ["sourceRecordIds[0] is not in the supplied evidence allowlist."];
    expect(sanitizeProviderValidationErrors(errors)).toEqual(errors);
  });

  it("[empty input] returns an empty array", () => {
    expect(sanitizeProviderValidationErrors([])).toEqual([]);
  });
});
