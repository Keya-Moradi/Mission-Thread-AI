import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../db";
import { DEMO_USER_IDS, ANALYSIS_IDS, PROGRAM_ID } from "../seed/ids";
import { recordMitigationDecision } from "./record-decision";
import { applyApprovedChanges } from "./apply-changes";

// This file creates its own uniquely-IDed Component/Milestone/Risk/BudgetItem
// fixtures rather than mutating or attaching to shared seeded rows (MS-001,
// RISK-001, BUDGET-001, COMP-EC440) — those rows are read (and, in other
// test files, asserted to stay stable, including their exact set of
// attached milestones) throughout a full test run, and Vitest runs test
// files concurrently, so touching shared seed data here would race with
// other files that assume it never changes mid-run.
const testComponentId = `COMP-TEST-APPLY-${randomUUID()}`;

beforeAll(async () => {
  await prisma.component.create({
    data: {
      id: testComponentId,
      programId: PROGRAM_ID,
      name: "Temp apply-changes test component",
      subsystem: "test",
      description: "Created for Phase 5 integration tests; safe to delete.",
    },
  });
});

afterAll(async () => {
  await prisma.component.delete({ where: { id: testComponentId } });
});

const createdOptionIds: string[] = [];
const createdMilestoneIds: string[] = [];
const createdRiskIds: string[] = [];
const createdBudgetItemIds: string[] = [];

async function createTempMitigationOption(): Promise<string> {
  const id = `MIT-TEST-${randomUUID()}`;
  await prisma.mitigationOption.create({
    data: {
      id,
      impactAnalysisId: ANALYSIS_IDS.supplierDelay,
      optionIndex: Math.floor(Math.random() * 1_000_000) + 1000,
      title: "Test mitigation option",
      description: "Created for a Phase 5 integration test; safe to delete.",
      tradeoffs: "None — test fixture.",
      costImpact: null,
      scheduleImpact: null,
      isRecommended: false,
      status: "PENDING",
    },
  });
  createdOptionIds.push(id);
  return id;
}

async function createTempMilestone(): Promise<{ id: string; currentDate: Date }> {
  const id = `MS-TEST-${randomUUID()}`;
  const currentDate = new Date("2026-09-01");
  await prisma.milestone.create({
    data: {
      id,
      programId: PROGRAM_ID,
      componentId: testComponentId,
      name: "Temp test milestone",
      plannedDate: new Date("2026-09-01"),
      currentDate,
      status: "ON_TRACK",
    },
  });
  createdMilestoneIds.push(id);
  return { id, currentDate };
}

async function createTempRisk(): Promise<{
  id: string;
  status: string;
  severity: string;
  probability: number;
  impact: number;
}> {
  const id = `RISK-TEST-${randomUUID()}`;
  const fixture = { status: "OPEN", severity: "HIGH", probability: 3, impact: 4 } as const;
  await prisma.risk.create({
    data: {
      id,
      programId: PROGRAM_ID,
      title: "Temp test risk",
      description: "Created for a Phase 5 integration test; safe to delete.",
      severity: fixture.severity,
      probability: fixture.probability,
      impact: fixture.impact,
      status: fixture.status,
    },
  });
  createdRiskIds.push(id);
  return { id, ...fixture };
}

async function createTempBudgetItem(): Promise<{
  id: string;
  plannedAmount: string;
  actualAmount: string;
}> {
  const id = `BUDGET-TEST-${randomUUID()}`;
  const fixture = { plannedAmount: "10000.00", actualAmount: "8000.00" };
  await prisma.budgetItem.create({
    data: {
      id,
      programId: PROGRAM_ID,
      category: "Test",
      description: "Created for a Phase 5 integration test; safe to delete.",
      plannedAmount: fixture.plannedAmount,
      actualAmount: fixture.actualAmount,
    },
  });
  createdBudgetItemIds.push(id);
  return { id, ...fixture };
}

async function cleanupOption(id: string): Promise<void> {
  await prisma.auditEvent.deleteMany({ where: { targetRecordId: id } });
  await prisma.proposedChange.deleteMany({ where: { mitigationOptionId: id } });
  await prisma.decision.deleteMany({ where: { mitigationOptionId: id } });
  await prisma.mitigationOption.deleteMany({ where: { id } });
}

afterEach(async () => {
  for (const id of createdOptionIds.splice(0)) {
    await cleanupOption(id);
  }
  if (createdMilestoneIds.length > 0) {
    await prisma.milestone.deleteMany({ where: { id: { in: createdMilestoneIds.splice(0) } } });
  }
  if (createdRiskIds.length > 0) {
    await prisma.risk.deleteMany({ where: { id: { in: createdRiskIds.splice(0) } } });
  }
  if (createdBudgetItemIds.length > 0) {
    await prisma.budgetItem.deleteMany({ where: { id: { in: createdBudgetItemIds.splice(0) } } });
  }
});

const rationale = "Reviewed the tradeoffs and this option is acceptable for the program.";

async function createApprovedOption(
  proposedChanges: unknown[],
): Promise<{ optionId: string; decisionId: string }> {
  const optionId = await createTempMitigationOption();
  const result = await recordMitigationDecision(
    { verdict: "APPROVED" as const, mitigationOptionId: optionId, rationale, proposedChanges },
    DEMO_USER_IDS.programManager,
  );
  if (!result.ok) throw new Error(`fixture setup failed: ${result.error.message}`);
  return { optionId, decisionId: result.data.decisionId };
}

describe("applyApprovedChanges — validation and preconditions", () => {
  it("rejects a missing/incorrect confirmation string", async () => {
    const milestone = await createTempMilestone();
    const { optionId } = await createApprovedOption([
      {
        changeType: "MILESTONE_DATE" as const,
        targetRecordId: milestone.id,
        currentDate: "2027-02-01",
      },
    ]);
    const result = await applyApprovedChanges(optionId, DEMO_USER_IDS.programManager, "yes");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });

  it("an unknown mitigation option ID is NOT_FOUND", async () => {
    const result = await applyApprovedChanges(
      "MIT-DOES-NOT-EXIST",
      DEMO_USER_IDS.programManager,
      "APPLY",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  it("a PENDING (not yet approved) option cannot be applied", async () => {
    const optionId = await createTempMitigationOption();
    const result = await applyApprovedChanges(optionId, DEMO_USER_IDS.programManager, "APPLY");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("applyApprovedChanges — authorization", () => {
  it("[Program Manager] may apply", async () => {
    const milestone = await createTempMilestone();
    const { optionId } = await createApprovedOption([
      {
        changeType: "MILESTONE_DATE" as const,
        targetRecordId: milestone.id,
        currentDate: "2027-02-01",
      },
    ]);
    const result = await applyApprovedChanges(optionId, DEMO_USER_IDS.programManager, "APPLY");
    expect(result.ok).toBe(true);
  });

  it("[Engineering Lead] may NOT apply", async () => {
    const milestone = await createTempMilestone();
    const { optionId } = await createApprovedOption([
      {
        changeType: "MILESTONE_DATE" as const,
        targetRecordId: milestone.id,
        currentDate: "2027-02-01",
      },
    ]);
    const result = await applyApprovedChanges(optionId, DEMO_USER_IDS.engineeringLead, "APPLY");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");
  });

  it("[Executive Viewer] may NOT apply", async () => {
    const milestone = await createTempMilestone();
    const { optionId } = await createApprovedOption([
      {
        changeType: "MILESTONE_DATE" as const,
        targetRecordId: milestone.id,
        currentDate: "2027-02-01",
      },
    ]);
    const result = await applyApprovedChanges(optionId, DEMO_USER_IDS.executiveViewer, "APPLY");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");
  });
});

describe("applyApprovedChanges — stale-data conflict detection", () => {
  it("a fresh, unmodified proposal applies successfully", async () => {
    const milestone = await createTempMilestone();
    const { optionId } = await createApprovedOption([
      {
        changeType: "MILESTONE_DATE" as const,
        targetRecordId: milestone.id,
        currentDate: "2027-02-01",
      },
    ]);
    const result = await applyApprovedChanges(optionId, DEMO_USER_IDS.programManager, "APPLY");
    expect(result.ok).toBe(true);
  });

  it("a milestone changed after approval is blocked as stale", async () => {
    const milestone = await createTempMilestone();
    const { optionId } = await createApprovedOption([
      {
        changeType: "MILESTONE_DATE" as const,
        targetRecordId: milestone.id,
        currentDate: "2027-02-01",
      },
    ]);
    // Simulate an unrelated edit to the milestone after the decision was approved.
    await prisma.milestone.update({
      where: { id: milestone.id },
      data: { currentDate: new Date("2026-06-01") },
    });

    const result = await applyApprovedChanges(optionId, DEMO_USER_IDS.programManager, "APPLY");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CONFLICT");

    const proposedChanges = await prisma.proposedChange.findMany({
      where: { mitigationOptionId: optionId },
    });
    expect(proposedChanges[0]?.status).toBe("PENDING");
  });

  it("a risk changed after approval is blocked as stale", async () => {
    const risk = await createTempRisk();
    const { optionId } = await createApprovedOption([
      {
        changeType: "RISK_UPDATE" as const,
        targetRecordId: risk.id,
        status: "MITIGATING" as const,
      },
    ]);
    await prisma.risk.update({ where: { id: risk.id }, data: { status: "CLOSED" } });

    const result = await applyApprovedChanges(optionId, DEMO_USER_IDS.programManager, "APPLY");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CONFLICT");
  });

  it("a budget item changed after approval is blocked as stale", async () => {
    const budgetItem = await createTempBudgetItem();
    const { optionId } = await createApprovedOption([
      {
        changeType: "BUDGET_UPDATE" as const,
        targetRecordId: budgetItem.id,
        plannedAmount: "9999.00",
      },
    ]);
    await prisma.budgetItem.update({
      where: { id: budgetItem.id },
      data: { plannedAmount: "1234.56" },
    });

    const result = await applyApprovedChanges(optionId, DEMO_USER_IDS.programManager, "APPLY");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CONFLICT");
  });

  it("one stale proposed change blocks the entire batch — no partial apply", async () => {
    const milestone = await createTempMilestone();
    const risk = await createTempRisk();
    const { optionId } = await createApprovedOption([
      {
        changeType: "MILESTONE_DATE" as const,
        targetRecordId: milestone.id,
        currentDate: "2027-02-01",
      },
      {
        changeType: "RISK_UPDATE" as const,
        targetRecordId: risk.id,
        status: "MITIGATING" as const,
      },
    ]);
    // Make only the risk stale; the milestone proposal is still fresh.
    await prisma.risk.update({ where: { id: risk.id }, data: { status: "CLOSED" } });

    const result = await applyApprovedChanges(optionId, DEMO_USER_IDS.programManager, "APPLY");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CONFLICT");

    const currentMilestone = await prisma.milestone.findUniqueOrThrow({
      where: { id: milestone.id },
    });
    expect(currentMilestone.currentDate.toISOString().slice(0, 10)).toBe(
      milestone.currentDate.toISOString().slice(0, 10),
    );
    const proposedChanges = await prisma.proposedChange.findMany({
      where: { mitigationOptionId: optionId },
    });
    expect(proposedChanges.every((change) => change.status === "PENDING")).toBe(true);
  });
});

describe("applyApprovedChanges — defensive persisted-row revalidation", () => {
  // Every test in this block directly corrupts an already-approved,
  // already-persisted ProposedChange row (never possible through the
  // public recordMitigationDecision()/schemas.ts input contract — this
  // simulates a stored row that's malformed or inconsistent for some
  // other reason: a future migration gap, a direct database edit, a bug
  // in an earlier version of this code) and proves applyApprovedChanges()
  // fails closed before any domain mutation, rather than trusting a
  // TypeScript type or a non-null assertion. See docs/DECISIONS.md, "Phase
  // 5 correction: apply-time persisted-snapshot revalidation".

  it("wrong targetRecordType is rejected before mutation", async () => {
    const milestone = await createTempMilestone();
    const { optionId } = await createApprovedOption([
      {
        changeType: "MILESTONE_DATE" as const,
        targetRecordId: milestone.id,
        currentDate: "2027-02-01",
      },
    ]);
    const change = await prisma.proposedChange.findFirstOrThrow({
      where: { mitigationOptionId: optionId },
    });
    await prisma.proposedChange.update({
      where: { id: change.id },
      data: { targetRecordType: "RISK" },
    });

    const result = await applyApprovedChanges(optionId, DEMO_USER_IDS.programManager, "APPLY");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");

    const updated = await prisma.milestone.findUniqueOrThrow({ where: { id: milestone.id } });
    expect(updated.currentDate.toISOString().slice(0, 10)).toBe(
      milestone.currentDate.toISOString().slice(0, 10),
    );
  });

  it("malformed oldValue is rejected", async () => {
    const milestone = await createTempMilestone();
    const { optionId } = await createApprovedOption([
      {
        changeType: "MILESTONE_DATE" as const,
        targetRecordId: milestone.id,
        currentDate: "2027-02-01",
      },
    ]);
    const change = await prisma.proposedChange.findFirstOrThrow({
      where: { mitigationOptionId: optionId },
    });
    await prisma.proposedChange.update({
      where: { id: change.id },
      data: { oldValue: { currentDate: "not-a-date" } },
    });

    const result = await applyApprovedChanges(optionId, DEMO_USER_IDS.programManager, "APPLY");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");

    const updated = await prisma.milestone.findUniqueOrThrow({ where: { id: milestone.id } });
    expect(updated.currentDate.toISOString().slice(0, 10)).toBe(
      milestone.currentDate.toISOString().slice(0, 10),
    );
  });

  it("malformed newValue is rejected", async () => {
    const milestone = await createTempMilestone();
    const { optionId } = await createApprovedOption([
      {
        changeType: "MILESTONE_DATE" as const,
        targetRecordId: milestone.id,
        currentDate: "2027-02-01",
      },
    ]);
    const change = await prisma.proposedChange.findFirstOrThrow({
      where: { mitigationOptionId: optionId },
    });
    await prisma.proposedChange.update({
      where: { id: change.id },
      data: { newValue: { currentDate: "2027-13-40" } },
    });

    const result = await applyApprovedChanges(optionId, DEMO_USER_IDS.programManager, "APPLY");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");

    const updated = await prisma.milestone.findUniqueOrThrow({ where: { id: milestone.id } });
    expect(updated.currentDate.toISOString().slice(0, 10)).toBe(
      milestone.currentDate.toISOString().slice(0, 10),
    );
  });

  it("an oldValue/newValue key-set mismatch is rejected", async () => {
    const risk = await createTempRisk();
    const { optionId } = await createApprovedOption([
      {
        changeType: "RISK_UPDATE" as const,
        targetRecordId: risk.id,
        status: "MITIGATING" as const,
      },
    ]);
    const change = await prisma.proposedChange.findFirstOrThrow({
      where: { mitigationOptionId: optionId },
    });
    // oldValue now carries an extra "severity" key newValue doesn't have.
    await prisma.proposedChange.update({
      where: { id: change.id },
      data: { oldValue: { status: risk.status, severity: risk.severity } },
    });

    const result = await applyApprovedChanges(optionId, DEMO_USER_IDS.programManager, "APPLY");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");

    const updated = await prisma.risk.findUniqueOrThrow({ where: { id: risk.id } });
    expect(updated.status).toBe(risk.status);
    expect(updated.severity).toBe(risk.severity);
  });

  it("directly inserted overlapping stored proposals are rejected", async () => {
    const risk = await createTempRisk();
    const { optionId } = await createApprovedOption([
      {
        changeType: "RISK_UPDATE" as const,
        targetRecordId: risk.id,
        status: "MITIGATING" as const,
      },
      { changeType: "RISK_UPDATE" as const, targetRecordId: risk.id, severity: "LOW" as const },
    ]);

    // Both rows are individually valid, and this pair was non-overlapping
    // (disjoint fields) when recordMitigationDecision() created them —
    // directly rewrite the second row so it now writes "status" too,
    // producing a stored-batch overlap only apply-time revalidation can
    // catch (recordMitigationDecision()'s own overlap check already ran
    // and passed, before this row was corrupted).
    const changes = await prisma.proposedChange.findMany({
      where: { mitigationOptionId: optionId },
      orderBy: { id: "asc" },
    });
    expect(changes).toHaveLength(2);
    await prisma.proposedChange.update({
      where: { id: changes[1]!.id },
      data: { oldValue: { status: risk.status }, newValue: { status: "CLOSED" } },
    });

    const result = await applyApprovedChanges(optionId, DEMO_USER_IDS.programManager, "APPLY");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");

    const updated = await prisma.risk.findUniqueOrThrow({ where: { id: risk.id } });
    expect(updated.status).toBe(risk.status);
    expect(updated.severity).toBe(risk.severity);
  });

  it("one malformed proposed change blocks the entire batch — no partial apply", async () => {
    const milestone = await createTempMilestone();
    const risk = await createTempRisk();
    const { optionId } = await createApprovedOption([
      {
        changeType: "MILESTONE_DATE" as const,
        targetRecordId: milestone.id,
        currentDate: "2027-02-01",
      },
      {
        changeType: "RISK_UPDATE" as const,
        targetRecordId: risk.id,
        status: "MITIGATING" as const,
      },
    ]);
    const riskChange = await prisma.proposedChange.findFirstOrThrow({
      where: { mitigationOptionId: optionId, changeType: "RISK_UPDATE" },
    });
    await prisma.proposedChange.update({
      where: { id: riskChange.id },
      data: { targetRecordType: "BUDGET_ITEM" },
    });

    const result = await applyApprovedChanges(optionId, DEMO_USER_IDS.programManager, "APPLY");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");

    // Neither the well-formed milestone change nor the malformed risk
    // change actually mutated anything — the whole batch was refused
    // before the domain-mutation loop ever ran.
    const updatedMilestone = await prisma.milestone.findUniqueOrThrow({
      where: { id: milestone.id },
    });
    expect(updatedMilestone.currentDate.toISOString().slice(0, 10)).toBe(
      milestone.currentDate.toISOString().slice(0, 10),
    );
    const updatedRisk = await prisma.risk.findUniqueOrThrow({ where: { id: risk.id } });
    expect(updatedRisk.status).toBe(risk.status);

    const proposedChanges = await prisma.proposedChange.findMany({
      where: { mitigationOptionId: optionId },
    });
    expect(proposedChanges.every((change) => change.status === "PENDING")).toBe(true);
  });
});

describe("applyApprovedChanges — apply transaction", () => {
  it("applies an approved milestone-date change to the real Milestone row", async () => {
    const milestone = await createTempMilestone();
    const { optionId } = await createApprovedOption([
      {
        changeType: "MILESTONE_DATE" as const,
        targetRecordId: milestone.id,
        currentDate: "2027-02-01",
      },
    ]);
    const result = await applyApprovedChanges(optionId, DEMO_USER_IDS.programManager, "APPLY");
    expect(result.ok).toBe(true);

    const updated = await prisma.milestone.findUniqueOrThrow({ where: { id: milestone.id } });
    expect(updated.currentDate.toISOString().slice(0, 10)).toBe("2027-02-01");
  });

  it("applies an approved risk-field change to the real Risk row", async () => {
    const risk = await createTempRisk();
    const { optionId } = await createApprovedOption([
      {
        changeType: "RISK_UPDATE" as const,
        targetRecordId: risk.id,
        severity: "LOW" as const,
        probability: 1,
      },
    ]);
    const result = await applyApprovedChanges(optionId, DEMO_USER_IDS.programManager, "APPLY");
    expect(result.ok).toBe(true);

    const updated = await prisma.risk.findUniqueOrThrow({ where: { id: risk.id } });
    expect(updated.severity).toBe("LOW");
    expect(updated.probability).toBe(1);
    // A field never proposed must be left untouched.
    expect(updated.impact).toBe(risk.impact);
  });

  it("applies an approved budget change to the real BudgetItem row", async () => {
    const budgetItem = await createTempBudgetItem();
    const { optionId } = await createApprovedOption([
      {
        changeType: "BUDGET_UPDATE" as const,
        targetRecordId: budgetItem.id,
        plannedAmount: "5555.00",
      },
    ]);
    const result = await applyApprovedChanges(optionId, DEMO_USER_IDS.programManager, "APPLY");
    expect(result.ok).toBe(true);

    const updated = await prisma.budgetItem.findUniqueOrThrow({ where: { id: budgetItem.id } });
    expect(updated.plannedAmount.toFixed(2)).toBe("5555.00");
    expect(updated.actualAmount.toFixed(2)).toBe(budgetItem.actualAmount);
  });

  it("an approved NEW_ACTION mutates no domain table but becomes APPLIED with its payload intact", async () => {
    const { optionId } = await createApprovedOption([
      {
        changeType: "NEW_ACTION" as const,
        targetRecordId: null,
        targetRecordType: null,
        title: "Escalate to supplier account manager",
        description: "Request a firm commitment date in writing.",
        dueDate: "2026-08-01",
      },
    ]);
    const result = await applyApprovedChanges(optionId, DEMO_USER_IDS.programManager, "APPLY");
    expect(result.ok).toBe(true);

    const proposedChange = await prisma.proposedChange.findFirstOrThrow({
      where: { mitigationOptionId: optionId },
    });
    expect(proposedChange.status).toBe("APPLIED");
    expect(proposedChange.newValue).toMatchObject({
      title: "Escalate to supplier account manager",
    });
  });

  it("all proposed changes in one apply receive the identical appliedAt timestamp", async () => {
    const milestone = await createTempMilestone();
    const risk = await createTempRisk();
    const { optionId } = await createApprovedOption([
      {
        changeType: "MILESTONE_DATE" as const,
        targetRecordId: milestone.id,
        currentDate: "2027-02-01",
      },
      { changeType: "RISK_UPDATE" as const, targetRecordId: risk.id, probability: 3 },
    ]);
    const result = await applyApprovedChanges(optionId, DEMO_USER_IDS.programManager, "APPLY");
    expect(result.ok).toBe(true);

    const proposedChanges = await prisma.proposedChange.findMany({
      where: { mitigationOptionId: optionId },
    });
    expect(proposedChanges).toHaveLength(2);
    const timestamps = new Set(proposedChanges.map((c) => c.appliedAt?.getTime()));
    expect(timestamps.size).toBe(1);
  });

  it("creates exactly one CHANGES_APPLIED audit event linked to the decision", async () => {
    const milestone = await createTempMilestone();
    const { optionId, decisionId } = await createApprovedOption([
      {
        changeType: "MILESTONE_DATE" as const,
        targetRecordId: milestone.id,
        currentDate: "2027-02-01",
      },
    ]);
    const result = await applyApprovedChanges(optionId, DEMO_USER_IDS.programManager, "APPLY");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const auditEvents = await prisma.auditEvent.findMany({
      where: { targetRecordId: optionId, action: "CHANGES_APPLIED" },
    });
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]?.decisionId).toBe(decisionId);
    expect(auditEvents[0]?.traceId).toBe(result.data.traceId);
  });

  it("no AI provider is invoked — AI_MODE stays mock throughout", () => {
    expect(process.env.AI_MODE).toBe("mock");
  });
});

describe("applyApprovedChanges — idempotency and concurrency", () => {
  it("a repeated apply request is rejected and applies nothing a second time", async () => {
    const milestone = await createTempMilestone();
    const { optionId } = await createApprovedOption([
      {
        changeType: "MILESTONE_DATE" as const,
        targetRecordId: milestone.id,
        currentDate: "2027-02-01",
      },
    ]);
    const first = await applyApprovedChanges(optionId, DEMO_USER_IDS.programManager, "APPLY");
    expect(first.ok).toBe(true);

    const second = await applyApprovedChanges(optionId, DEMO_USER_IDS.programManager, "APPLY");
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("VALIDATION_ERROR");

    const auditEvents = await prisma.auditEvent.findMany({
      where: { targetRecordId: optionId, action: "CHANGES_APPLIED" },
    });
    expect(auditEvents).toHaveLength(1);
  });

  it("two concurrent apply requests produce at most one successful apply", async () => {
    const milestone = await createTempMilestone();
    const { optionId } = await createApprovedOption([
      {
        changeType: "MILESTONE_DATE" as const,
        targetRecordId: milestone.id,
        currentDate: "2027-02-01",
      },
    ]);
    const [first, second] = await Promise.all([
      applyApprovedChanges(optionId, DEMO_USER_IDS.programManager, "APPLY"),
      applyApprovedChanges(optionId, DEMO_USER_IDS.programManager, "APPLY"),
    ]);
    const succeeded = [first, second].filter((r) => r.ok);
    expect(succeeded).toHaveLength(1);

    const auditEvents = await prisma.auditEvent.findMany({
      where: { targetRecordId: optionId, action: "CHANGES_APPLIED" },
    });
    expect(auditEvents).toHaveLength(1);
  });
});
