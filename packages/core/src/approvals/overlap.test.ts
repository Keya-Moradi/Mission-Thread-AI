import { describe, expect, it } from "vitest";
import { getProposedChangeWriteKeys, validateNoOverlappingProposedChanges } from "./overlap";
import type { ProposedChangeInput } from "./schemas";

const milestoneChange = (
  targetRecordId: string,
  currentDate = "2027-01-01",
): ProposedChangeInput => ({
  changeType: "MILESTONE_DATE",
  targetRecordId,
  currentDate,
});

const riskChange = (
  targetRecordId: string,
  fields: Partial<{
    status: "OPEN" | "MITIGATING" | "CLOSED";
    severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
    probability: number;
    impact: number;
  }>,
): ProposedChangeInput => ({
  changeType: "RISK_UPDATE",
  targetRecordId,
  ...fields,
});

const budgetChange = (
  targetRecordId: string,
  fields: Partial<{ plannedAmount: string; actualAmount: string }>,
): ProposedChangeInput => ({
  changeType: "BUDGET_UPDATE",
  targetRecordId,
  ...fields,
});

const newAction = (title: string): ProposedChangeInput => ({
  changeType: "NEW_ACTION",
  targetRecordId: null,
  targetRecordType: null,
  title,
  description: "test action",
  dueDate: null,
});

describe("getProposedChangeWriteKeys", () => {
  it("returns one key for a milestone-date change", () => {
    expect(getProposedChangeWriteKeys(milestoneChange("MS-001"))).toEqual([
      "MILESTONE:MS-001:currentDate",
    ]);
  });

  it("returns only keys for fields actually supplied on a risk update", () => {
    expect(getProposedChangeWriteKeys(riskChange("RISK-001", { status: "MITIGATING" }))).toEqual([
      "RISK:RISK-001:status",
    ]);
    expect(
      getProposedChangeWriteKeys(riskChange("RISK-001", { status: "MITIGATING", severity: "LOW" })),
    ).toEqual(["RISK:RISK-001:status", "RISK:RISK-001:severity"]);
  });

  it("returns only keys for fields actually supplied on a budget update", () => {
    expect(
      getProposedChangeWriteKeys(budgetChange("BUDGET-001", { plannedAmount: "1.00" })),
    ).toEqual(["BUDGET_ITEM:BUDGET-001:plannedAmount"]);
  });

  it("returns no keys for NEW_ACTION — it creates a new record, never overwrites one", () => {
    expect(getProposedChangeWriteKeys(newAction("Do something"))).toEqual([]);
  });
});

describe("validateNoOverlappingProposedChanges — rejections", () => {
  it("rejects two milestone-date changes for the same milestone", () => {
    const result = validateNoOverlappingProposedChanges([
      milestoneChange("MS-001", "2027-01-01"),
      milestoneChange("MS-001", "2027-02-01"),
    ]);
    expect(result.ok).toBe(false);
  });

  it("rejects two risk updates writing the same field", () => {
    const result = validateNoOverlappingProposedChanges([
      riskChange("RISK-001", { status: "MITIGATING" }),
      riskChange("RISK-001", { status: "CLOSED" }),
    ]);
    expect(result.ok).toBe(false);
  });

  it("rejects two risk updates writing the same probability field", () => {
    const result = validateNoOverlappingProposedChanges([
      riskChange("RISK-001", { probability: 2 }),
      riskChange("RISK-001", { probability: 4 }),
    ]);
    expect(result.ok).toBe(false);
  });

  it("rejects two budget updates writing the same field", () => {
    const result = validateNoOverlappingProposedChanges([
      budgetChange("BUDGET-001", { plannedAmount: "1.00" }),
      budgetChange("BUDGET-001", { plannedAmount: "2.00" }),
    ]);
    expect(result.ok).toBe(false);
  });

  it("rejects two budget updates writing the same actualAmount field", () => {
    const result = validateNoOverlappingProposedChanges([
      budgetChange("BUDGET-001", { actualAmount: "1.00" }),
      budgetChange("BUDGET-001", { actualAmount: "2.00" }),
    ]);
    expect(result.ok).toBe(false);
  });

  it("rejects duplicate identical proposals", () => {
    const change = milestoneChange("MS-001");
    const result = validateNoOverlappingProposedChanges([change, { ...change }]);
    expect(result.ok).toBe(false);
  });

  it("a rejection message identifies the target and field, not arbitrary text", () => {
    const result = validateNoOverlappingProposedChanges([
      riskChange("RISK-001", { status: "MITIGATING" }),
      riskChange("RISK-001", { status: "CLOSED" }),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("RISK-001");
      expect(result.error.message).toContain("status");
    }
  });
});

describe("validateNoOverlappingProposedChanges — allowed combinations", () => {
  it("allows disjoint fields on one risk", () => {
    const result = validateNoOverlappingProposedChanges([
      riskChange("RISK-001", { status: "MITIGATING" }),
      riskChange("RISK-001", { severity: "LOW" }),
    ]);
    expect(result.ok).toBe(true);
  });

  it("allows disjoint fields on one budget item", () => {
    const result = validateNoOverlappingProposedChanges([
      budgetChange("BUDGET-001", { plannedAmount: "1.00" }),
      budgetChange("BUDGET-001", { actualAmount: "1.00" }),
    ]);
    expect(result.ok).toBe(true);
  });

  it("allows updates to different records", () => {
    const result = validateNoOverlappingProposedChanges([
      riskChange("RISK-001", { status: "MITIGATING" }),
      riskChange("RISK-002", { status: "MITIGATING" }),
    ]);
    expect(result.ok).toBe(true);
  });

  it("allows multiple NEW_ACTION entries", () => {
    const result = validateNoOverlappingProposedChanges([
      newAction("First action"),
      newAction("Second action"),
      newAction("Third action"),
    ]);
    expect(result.ok).toBe(true);
  });

  it("allows a mix of disjoint risk fields, budget fields, and new actions in one batch", () => {
    const result = validateNoOverlappingProposedChanges([
      riskChange("RISK-001", { status: "MITIGATING" }),
      riskChange("RISK-001", { impact: 2 }),
      budgetChange("BUDGET-001", { plannedAmount: "1.00" }),
      newAction("Follow up"),
    ]);
    expect(result.ok).toBe(true);
  });

  it("allows an empty batch", () => {
    const result = validateNoOverlappingProposedChanges([]);
    expect(result.ok).toBe(true);
  });
});
