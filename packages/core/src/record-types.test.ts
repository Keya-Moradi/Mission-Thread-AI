import { describe, expect, it } from "vitest";
import {
  auditTargetTypeSchema,
  evidenceRecordTypeSchema,
  proposedChangeTargetTypeSchema,
} from "./record-types";

describe("evidenceRecordTypeSchema", () => {
  it("accepts domain record kinds", () => {
    expect(evidenceRecordTypeSchema.safeParse("DEPENDENCY").success).toBe(true);
    expect(evidenceRecordTypeSchema.safeParse("REQUIREMENT").success).toBe(true);
  });

  it("rejects workflow-entity kinds — evidence cites program data, not other analyses", () => {
    expect(evidenceRecordTypeSchema.safeParse("IMPACT_ANALYSIS").success).toBe(false);
    expect(evidenceRecordTypeSchema.safeParse("DECISION").success).toBe(false);
  });
});

describe("proposedChangeTargetTypeSchema", () => {
  it("accepts only the mutable records the approved workflow may change", () => {
    for (const type of ["MILESTONE", "RISK", "BUDGET_ITEM"]) {
      expect(proposedChangeTargetTypeSchema.safeParse(type).success).toBe(true);
    }
  });

  it("rejects records a mitigation option must never be able to target", () => {
    for (const type of [
      "PROGRAM",
      "SUPPLIER",
      "TEST_CASE",
      "PROGRAM_EVENT",
      "DECISION",
      "AUDIT_EVENT",
    ]) {
      expect(proposedChangeTargetTypeSchema.safeParse(type).success).toBe(false);
    }
  });
});

describe("auditTargetTypeSchema", () => {
  it("accepts both domain records and workflow entities", () => {
    expect(auditTargetTypeSchema.safeParse("PROGRAM_EVENT").success).toBe(true);
    expect(auditTargetTypeSchema.safeParse("DECISION").success).toBe(true);
    expect(auditTargetTypeSchema.safeParse("SOURCE_REFERENCE").success).toBe(true);
  });

  it("rejects values outside the record-type superset", () => {
    expect(auditTargetTypeSchema.safeParse("NOT_A_RECORD_TYPE").success).toBe(false);
  });
});
