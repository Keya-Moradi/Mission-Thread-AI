import { describe, expect, it } from "vitest";
import {
  recordDecisionInputSchema,
  proposedChangeInputSchema,
  milestoneDateProposedChangeInputSchema,
  riskUpdateProposedChangeInputSchema,
  budgetUpdateProposedChangeInputSchema,
  newActionProposedChangeInputSchema,
  applyConfirmationSchema,
} from "./schemas";

const validMilestoneChange = {
  changeType: "MILESTONE_DATE" as const,
  targetRecordId: "MS-001",
  currentDate: "2026-12-01",
};

const validRiskChange = {
  changeType: "RISK_UPDATE" as const,
  targetRecordId: "RISK-001",
  status: "MITIGATING" as const,
};

const validBudgetChange = {
  changeType: "BUDGET_UPDATE" as const,
  targetRecordId: "BUDGET-001",
  plannedAmount: "1000.00",
};

const validNewAction = {
  changeType: "NEW_ACTION" as const,
  targetRecordId: null,
  targetRecordType: null,
  title: "Escalate supplier commitment",
  description: "Contact the supplier's account manager for a firm delivery date.",
  dueDate: "2026-12-15",
};

describe("proposedChangeInputSchema — MILESTONE_DATE", () => {
  it("accepts a valid milestone-date change", () => {
    expect(milestoneDateProposedChangeInputSchema.safeParse(validMilestoneChange).success).toBe(
      true,
    );
  });

  it("rejects a malformed date", () => {
    const result = milestoneDateProposedChangeInputSchema.safeParse({
      ...validMilestoneChange,
      currentDate: "12/01/2026",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unrecognized extra field", () => {
    const result = milestoneDateProposedChangeInputSchema.safeParse({
      ...validMilestoneChange,
      oldValue: { currentDate: "2020-01-01" },
    });
    expect(result.success).toBe(false);
  });
});

describe("proposedChangeInputSchema — RISK_UPDATE", () => {
  it("accepts a change with one writable field", () => {
    expect(riskUpdateProposedChangeInputSchema.safeParse(validRiskChange).success).toBe(true);
  });

  it("accepts a change with multiple writable fields", () => {
    const result = riskUpdateProposedChangeInputSchema.safeParse({
      ...validRiskChange,
      severity: "LOW",
      probability: 2,
      impact: 2,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a change with no writable fields at all", () => {
    const result = riskUpdateProposedChangeInputSchema.safeParse({
      changeType: "RISK_UPDATE",
      targetRecordId: "RISK-001",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an out-of-range probability", () => {
    const result = riskUpdateProposedChangeInputSchema.safeParse({
      ...validRiskChange,
      probability: 99,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unwritable field (e.g. title)", () => {
    const result = riskUpdateProposedChangeInputSchema.safeParse({
      ...validRiskChange,
      title: "Renamed risk",
    });
    expect(result.success).toBe(false);
  });
});

describe("proposedChangeInputSchema — BUDGET_UPDATE", () => {
  it("accepts a change with plannedAmount only", () => {
    expect(budgetUpdateProposedChangeInputSchema.safeParse(validBudgetChange).success).toBe(true);
  });

  it("accepts a change with actualAmount only", () => {
    const result = budgetUpdateProposedChangeInputSchema.safeParse({
      changeType: "BUDGET_UPDATE",
      targetRecordId: "BUDGET-001",
      actualAmount: "500.00",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a change with neither amount", () => {
    const result = budgetUpdateProposedChangeInputSchema.safeParse({
      changeType: "BUDGET_UPDATE",
      targetRecordId: "BUDGET-001",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a money string with more than 2 decimals", () => {
    const result = budgetUpdateProposedChangeInputSchema.safeParse({
      ...validBudgetChange,
      plannedAmount: "1000.001",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a currency field (not accepted this phase)", () => {
    const result = budgetUpdateProposedChangeInputSchema.safeParse({
      ...validBudgetChange,
      currency: "EUR",
    });
    expect(result.success).toBe(false);
  });
});

describe("proposedChangeInputSchema — NEW_ACTION", () => {
  it("accepts a valid new action with a due date", () => {
    expect(newActionProposedChangeInputSchema.safeParse(validNewAction).success).toBe(true);
  });

  it("accepts a valid new action with a null due date", () => {
    const result = newActionProposedChangeInputSchema.safeParse({
      ...validNewAction,
      dueDate: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-null targetRecordId", () => {
    const result = newActionProposedChangeInputSchema.safeParse({
      ...validNewAction,
      targetRecordId: "MS-001",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing title", () => {
    const result = newActionProposedChangeInputSchema.safeParse({
      changeType: "NEW_ACTION",
      targetRecordId: null,
      targetRecordType: null,
      description: validNewAction.description,
      dueDate: validNewAction.dueDate,
    });
    expect(result.success).toBe(false);
  });
});

describe("proposedChangeInputSchema — discriminated union", () => {
  it("routes each changeType to its own branch", () => {
    for (const change of [
      validMilestoneChange,
      validRiskChange,
      validBudgetChange,
      validNewAction,
    ]) {
      expect(proposedChangeInputSchema.safeParse(change).success).toBe(true);
    }
  });

  it("rejects an unrecognized changeType", () => {
    const result = proposedChangeInputSchema.safeParse({
      changeType: "SOMETHING_ELSE",
      targetRecordId: "MS-001",
    });
    expect(result.success).toBe(false);
  });
});

describe("recordDecisionInputSchema — APPROVED", () => {
  const base = {
    verdict: "APPROVED" as const,
    mitigationOptionId: "MIT-TEST-001",
    rationale: "This mitigation reduces schedule exposure at an acceptable cost.",
  };

  it("accepts an approval with at least one proposed change", () => {
    const result = recordDecisionInputSchema.safeParse({
      ...base,
      proposedChanges: [validMilestoneChange],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an approval with zero proposed changes", () => {
    const result = recordDecisionInputSchema.safeParse({ ...base, proposedChanges: [] });
    expect(result.success).toBe(false);
  });

  it("rejects an approval missing proposedChanges entirely", () => {
    const result = recordDecisionInputSchema.safeParse(base);
    expect(result.success).toBe(false);
  });

  it("rejects a rationale shorter than the minimum length", () => {
    const result = recordDecisionInputSchema.safeParse({
      ...base,
      rationale: "too short",
      proposedChanges: [validMilestoneChange],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown field (e.g. a client-supplied actorUserId)", () => {
    const result = recordDecisionInputSchema.safeParse({
      ...base,
      proposedChanges: [validMilestoneChange],
      actorUserId: "USER-PM",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a client-supplied oldValue on a proposed change", () => {
    const result = recordDecisionInputSchema.safeParse({
      ...base,
      proposedChanges: [{ ...validMilestoneChange, oldValue: { currentDate: "2020-01-01" } }],
    });
    expect(result.success).toBe(false);
  });
});

describe("recordDecisionInputSchema — REJECTED / REVISION_REQUESTED", () => {
  const rationale = "Cost exceeds what this program can absorb this quarter.";

  it("accepts a valid rejection with no proposedChanges field", () => {
    const result = recordDecisionInputSchema.safeParse({
      verdict: "REJECTED",
      mitigationOptionId: "MIT-TEST-001",
      rationale,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a rejection that includes proposedChanges", () => {
    const result = recordDecisionInputSchema.safeParse({
      verdict: "REJECTED",
      mitigationOptionId: "MIT-TEST-001",
      rationale,
      proposedChanges: [validMilestoneChange],
    });
    expect(result.success).toBe(false);
  });

  it("accepts a valid revision request", () => {
    const result = recordDecisionInputSchema.safeParse({
      verdict: "REVISION_REQUESTED",
      mitigationOptionId: "MIT-TEST-001",
      rationale,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a revision request that includes proposedChanges", () => {
    const result = recordDecisionInputSchema.safeParse({
      verdict: "REVISION_REQUESTED",
      mitigationOptionId: "MIT-TEST-001",
      rationale,
      proposedChanges: [validMilestoneChange],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unrecognized verdict", () => {
    const result = recordDecisionInputSchema.safeParse({
      verdict: "MAYBE",
      mitigationOptionId: "MIT-TEST-001",
      rationale,
    });
    expect(result.success).toBe(false);
  });
});

describe("applyConfirmationSchema", () => {
  it('accepts the exact literal "APPLY"', () => {
    expect(applyConfirmationSchema.safeParse("APPLY").success).toBe(true);
  });

  it("rejects a lowercase variant", () => {
    expect(applyConfirmationSchema.safeParse("apply").success).toBe(false);
  });

  it("rejects a boolean true", () => {
    expect(applyConfirmationSchema.safeParse(true).success).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(applyConfirmationSchema.safeParse("").success).toBe(false);
  });
});
