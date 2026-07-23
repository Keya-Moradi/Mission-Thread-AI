import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "../db";
import { DEMO_USER_IDS, ANALYSIS_IDS, MILESTONE_IDS } from "../seed/ids";
import { recordMitigationDecision } from "./record-decision";

// Every test attaches its own uniquely-indexed MitigationOption to the
// seeded successful analysis (ANALYSIS_IDS.supplierDelay), rather than
// mutating one of the 3 real seeded PENDING options — Decision.mitigationOptionId
// is @unique, so reusing a seeded option across tests would leave it
// permanently decided for every later test. Each temp option (and anything
// created under it) is removed in afterEach.
const createdOptionIds: string[] = [];

async function createTempMitigationOption(
  overrides?: Partial<{ status: "PENDING" | "APPROVED" | "REJECTED" | "REVISION_REQUESTED" }>,
): Promise<string> {
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
      status: overrides?.status ?? "PENDING",
    },
  });
  createdOptionIds.push(id);
  return id;
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
});

const rationale = "Reviewed the tradeoffs and this option is acceptable for the program.";

function approve(
  mitigationOptionId: string,
  proposedChanges: unknown[] = [validMilestoneChange()],
) {
  return { verdict: "APPROVED" as const, mitigationOptionId, rationale, proposedChanges };
}
function reject(mitigationOptionId: string) {
  return { verdict: "REJECTED" as const, mitigationOptionId, rationale };
}
function requestRevision(mitigationOptionId: string) {
  return { verdict: "REVISION_REQUESTED" as const, mitigationOptionId, rationale };
}
function validMilestoneChange() {
  return {
    changeType: "MILESTONE_DATE" as const,
    targetRecordId: MILESTONE_IDS[0],
    currentDate: "2026-12-25",
  };
}

describe("recordMitigationDecision — input validation", () => {
  it("rejects malformed input before touching the database", async () => {
    const result = await recordMitigationDecision(
      { verdict: "APPROVED" },
      DEMO_USER_IDS.programManager,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects an invalid session (empty actor id)", async () => {
    const optionId = await createTempMitigationOption();
    const result = await recordMitigationDecision(reject(optionId), "");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");
  });
});

describe("recordMitigationDecision — authorization", () => {
  it("[Program Manager] may approve", async () => {
    const optionId = await createTempMitigationOption();
    const result = await recordMitigationDecision(approve(optionId), DEMO_USER_IDS.programManager);
    expect(result.ok).toBe(true);
  });

  it("[Program Manager] may reject", async () => {
    const optionId = await createTempMitigationOption();
    const result = await recordMitigationDecision(reject(optionId), DEMO_USER_IDS.programManager);
    expect(result.ok).toBe(true);
  });

  it("[Program Manager] may request revision", async () => {
    const optionId = await createTempMitigationOption();
    const result = await recordMitigationDecision(
      requestRevision(optionId),
      DEMO_USER_IDS.programManager,
    );
    expect(result.ok).toBe(true);
  });

  it("[Engineering Lead] may request revision", async () => {
    const optionId = await createTempMitigationOption();
    const result = await recordMitigationDecision(
      requestRevision(optionId),
      DEMO_USER_IDS.engineeringLead,
    );
    expect(result.ok).toBe(true);
  });

  it("[Engineering Lead] may NOT approve", async () => {
    const optionId = await createTempMitigationOption();
    const result = await recordMitigationDecision(approve(optionId), DEMO_USER_IDS.engineeringLead);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");
  });

  it("[Engineering Lead] may NOT reject", async () => {
    const optionId = await createTempMitigationOption();
    const result = await recordMitigationDecision(reject(optionId), DEMO_USER_IDS.engineeringLead);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");
  });

  it("[Executive Viewer] may not mutate at all", async () => {
    const optionId = await createTempMitigationOption();
    const result = await recordMitigationDecision(
      requestRevision(optionId),
      DEMO_USER_IDS.executiveViewer,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");
  });

  it("[missing/deleted actor] is rejected", async () => {
    const optionId = await createTempMitigationOption();
    const result = await recordMitigationDecision(reject(optionId), "USER-DOES-NOT-EXIST");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");
  });

  it("role is revalidated from the database, not cached", async () => {
    const tempUserId = `USER-TEST-${randomUUID()}`;
    await prisma.user.create({
      data: {
        id: tempUserId,
        email: `${tempUserId}@example.test`,
        name: "Temp Eng Lead",
        role: "ENGINEERING_LEAD",
        passwordHash: "unused",
      },
    });
    try {
      const optionId = await createTempMitigationOption();
      const before = await recordMitigationDecision(approve(optionId), tempUserId);
      expect(before.ok).toBe(false);

      await prisma.user.update({ where: { id: tempUserId }, data: { role: "PROGRAM_MANAGER" } });
      const after = await recordMitigationDecision(approve(optionId), tempUserId);
      expect(after.ok).toBe(true);
    } finally {
      await prisma.auditEvent.deleteMany({ where: { actorUserId: tempUserId } });
      await prisma.decision.deleteMany({ where: { actorUserId: tempUserId } });
      await prisma.user.delete({ where: { id: tempUserId } });
    }
  });
});

describe("recordMitigationDecision — state machine", () => {
  it.each(["APPROVED", "REJECTED", "REVISION_REQUESTED"] as const)(
    "PENDING -> %s succeeds",
    async (verdict) => {
      const optionId = await createTempMitigationOption();
      const input =
        verdict === "APPROVED"
          ? approve(optionId)
          : verdict === "REJECTED"
            ? reject(optionId)
            : requestRevision(optionId);
      const result = await recordMitigationDecision(input, DEMO_USER_IDS.programManager);
      expect(result.ok).toBe(true);

      const option = await prisma.mitigationOption.findUnique({ where: { id: optionId } });
      expect(option?.status).toBe(verdict);
    },
  );

  it.each(["APPROVED", "REJECTED", "REVISION_REQUESTED"] as const)(
    "a terminal status (%s) never accepts a second decision",
    async (firstVerdict) => {
      const optionId = await createTempMitigationOption();
      const firstInput =
        firstVerdict === "APPROVED"
          ? approve(optionId)
          : firstVerdict === "REJECTED"
            ? reject(optionId)
            : requestRevision(optionId);
      const first = await recordMitigationDecision(firstInput, DEMO_USER_IDS.programManager);
      expect(first.ok).toBe(true);

      const second = await recordMitigationDecision(reject(optionId), DEMO_USER_IDS.programManager);
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.error.code).toBe("CONFLICT");
    },
  );

  it("an unknown mitigation option ID is NOT_FOUND", async () => {
    const result = await recordMitigationDecision(
      reject("MIT-DOES-NOT-EXIST"),
      DEMO_USER_IDS.programManager,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  it("concurrent decision attempts on the same option produce exactly one decision", async () => {
    const optionId = await createTempMitigationOption();
    const [first, second] = await Promise.all([
      recordMitigationDecision(reject(optionId), DEMO_USER_IDS.programManager),
      recordMitigationDecision(requestRevision(optionId), DEMO_USER_IDS.programManager),
    ]);

    const outcomes = [first, second];
    const succeeded = outcomes.filter((r) => r.ok);
    const failed = outcomes.filter((r) => !r.ok);
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    if (!failed[0]?.ok) expect(failed[0]?.error.code).toBe("CONFLICT");

    const decisions = await prisma.decision.findMany({ where: { mitigationOptionId: optionId } });
    expect(decisions).toHaveLength(1);
  });
});

describe("recordMitigationDecision — proposed changes", () => {
  it("server-generated oldValue matches the current database row, not client input", async () => {
    const optionId = await createTempMitigationOption();
    const milestone = await prisma.milestone.findUniqueOrThrow({ where: { id: MILESTONE_IDS[0] } });
    const currentDateString = milestone.currentDate.toISOString().slice(0, 10);

    const result = await recordMitigationDecision(
      approve(optionId, [
        {
          changeType: "MILESTONE_DATE",
          targetRecordId: MILESTONE_IDS[0],
          currentDate: "2027-01-15",
        },
      ]),
      DEMO_USER_IDS.programManager,
    );
    expect(result.ok).toBe(true);

    const proposedChanges = await prisma.proposedChange.findMany({
      where: { mitigationOptionId: optionId },
    });
    expect(proposedChanges).toHaveLength(1);
    expect(proposedChanges[0]?.oldValue).toEqual({ currentDate: currentDateString });
    expect(proposedChanges[0]?.newValue).toEqual({ currentDate: "2027-01-15" });
    expect(proposedChanges[0]?.targetRecordType).toBe("MILESTONE");
    expect(proposedChanges[0]?.status).toBe("PENDING");
  });

  it("a target from a different program is NOT_FOUND", async () => {
    const otherProgramId = `PROGRAM-TEST-OTHER-${randomUUID()}`;
    const otherMilestoneId = `MS-TEST-OTHER-${randomUUID()}`;
    const otherComponentId = `COMP-TEST-OTHER-${randomUUID()}`;
    await prisma.program.create({
      data: { id: otherProgramId, name: "Other program", description: "temp" },
    });
    await prisma.component.create({
      data: {
        id: otherComponentId,
        programId: otherProgramId,
        name: "c",
        subsystem: "s",
        description: "d",
      },
    });
    await prisma.milestone.create({
      data: {
        id: otherMilestoneId,
        programId: otherProgramId,
        componentId: otherComponentId,
        name: "Other-program milestone",
        plannedDate: new Date("2026-01-01"),
        currentDate: new Date("2026-01-01"),
        status: "NOT_STARTED",
      },
    });

    try {
      const optionId = await createTempMitigationOption();
      const result = await recordMitigationDecision(
        approve(optionId, [
          {
            changeType: "MILESTONE_DATE",
            targetRecordId: otherMilestoneId,
            currentDate: "2027-01-15",
          },
        ]),
        DEMO_USER_IDS.programManager,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
    } finally {
      await prisma.milestone.deleteMany({ where: { programId: otherProgramId } });
      await prisma.component.deleteMany({ where: { programId: otherProgramId } });
      await prisma.program.deleteMany({ where: { id: otherProgramId } });
    }
  });

  it("an unknown target ID is NOT_FOUND", async () => {
    const optionId = await createTempMitigationOption();
    const result = await recordMitigationDecision(
      approve(optionId, [
        {
          changeType: "MILESTONE_DATE",
          targetRecordId: "MS-DOES-NOT-EXIST",
          currentDate: "2027-01-15",
        },
      ]),
      DEMO_USER_IDS.programManager,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  it("REJECTED never creates proposed changes even if extra fields are stripped by the schema", async () => {
    const optionId = await createTempMitigationOption();
    const result = await recordMitigationDecision(reject(optionId), DEMO_USER_IDS.programManager);
    expect(result.ok).toBe(true);
    const proposedChanges = await prisma.proposedChange.findMany({
      where: { mitigationOptionId: optionId },
    });
    expect(proposedChanges).toHaveLength(0);
  });
});

describe("recordMitigationDecision — transaction and audit", () => {
  it("creates exactly one Decision, updates option status, and one DECISION_RECORDED audit event, atomically", async () => {
    const optionId = await createTempMitigationOption();
    const result = await recordMitigationDecision(approve(optionId), DEMO_USER_IDS.programManager);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const decisions = await prisma.decision.findMany({ where: { mitigationOptionId: optionId } });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.traceId).toBe(result.data.traceId);

    const option = await prisma.mitigationOption.findUnique({ where: { id: optionId } });
    expect(option?.status).toBe("APPROVED");

    const auditEvents = await prisma.auditEvent.findMany({ where: { targetRecordId: optionId } });
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]?.action).toBe("DECISION_RECORDED");
    expect(auditEvents[0]?.decisionId).toBe(result.data.decisionId);
    expect(auditEvents[0]?.traceId).toBe(result.data.traceId);
  });

  it("the audit payload never contains the full rationale text", async () => {
    const optionId = await createTempMitigationOption();
    const secretRationale = "SECRET-SHAPED-RATIONALE-TEXT-1234";
    const result = await recordMitigationDecision(
      {
        verdict: "REJECTED",
        mitigationOptionId: optionId,
        rationale: `${secretRationale} padded to length`,
      },
      DEMO_USER_IDS.programManager,
    );
    expect(result.ok).toBe(true);

    const auditEvent = await prisma.auditEvent.findFirst({ where: { targetRecordId: optionId } });
    const payload = JSON.stringify(auditEvent?.afterValue);
    expect(payload).not.toContain(secretRationale);

    const decision = await prisma.decision.findUnique({ where: { mitigationOptionId: optionId } });
    expect(decision?.rationale).toContain(secretRationale);
  });

  it("a forced proposed-change failure rolls back the Decision and the option status", async () => {
    const optionId = await createTempMitigationOption();
    const result = await recordMitigationDecision(
      approve(optionId, [
        validMilestoneChange(),
        {
          changeType: "MILESTONE_DATE",
          targetRecordId: "MS-DOES-NOT-EXIST",
          currentDate: "2027-01-15",
        },
      ]),
      DEMO_USER_IDS.programManager,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");

    const decisions = await prisma.decision.findMany({ where: { mitigationOptionId: optionId } });
    expect(decisions).toHaveLength(0);
    const option = await prisma.mitigationOption.findUnique({ where: { id: optionId } });
    expect(option?.status).toBe("PENDING");
    const proposedChanges = await prisma.proposedChange.findMany({
      where: { mitigationOptionId: optionId },
    });
    expect(proposedChanges).toHaveLength(0);
  });
});
