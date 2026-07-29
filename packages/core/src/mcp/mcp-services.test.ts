import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "../db";
import { PROGRAM_ID, REQUIREMENT_IDS, MILESTONE_IDS, COMPONENT_IDS, TEST_IDS } from "../seed/ids";
import { getProgramSummary } from "./get-program-summary";
import { getRequirement } from "./get-requirement";
import { getScheduleDependencies } from "./get-schedule-dependencies";
import { listFailedTests } from "./list-failed-tests";
import { getBudgetVariance } from "./get-budget-variance";
import { getRiskRegister } from "./get-risk-register";
import { computeRiskScore } from "../analysis/risk";
import { MCP_LIMITS } from "./types";

describe("getProgramSummary", () => {
  it("[not found] an unknown program ID returns NOT_FOUND", async () => {
    const result = await getProgramSummary({ programId: "PROGRAM-DOES-NOT-EXIST" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  it("[unknown field] rejects an input with an extra field", async () => {
    const result = await getProgramSummary({ programId: PROGRAM_ID, extra: "nope" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });

  it("[seeded totals] matches the seeded EdgeLink-X record counts", async () => {
    const result = await getProgramSummary({ programId: PROGRAM_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.counts.requirements).toBe(8);
    expect(result.data.counts.milestones).toBe(8);
    expect(result.data.counts.risks).toBe(4);
    expect(result.data.counts.suppliers).toBe(3);
    expect(result.data.counts.testCases).toBe(8);
    expect(result.data.counts.budgetItems).toBe(5);
    expect(result.data.budgetVariance.plannedTotal).toBe("964000.00");
    expect(result.data.readinessScore).not.toBeNull();
    expect(result.data.mostRecentEvent).not.toBeNull();
    expect(result.data.mostRecentAnalysisRun).not.toBeNull();
  });

  it("[no unsafe fields] never exposes raw notes or a password hash", async () => {
    const result = await getProgramSummary({ programId: PROGRAM_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const serialized = JSON.stringify(result.data);
    expect(serialized).not.toContain("passwordHash");
    expect(serialized).not.toContain("rawNotes");
  });
});

describe("getRequirement", () => {
  it("[not found] an unknown requirement ID returns NOT_FOUND", async () => {
    const result = await getRequirement({ requirementId: "REQ-DOES-NOT-EXIST" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  it("[padded ID] rejects a padded requirement ID", async () => {
    const result = await getRequirement({ requirementId: ` ${REQUIREMENT_IDS[0]} ` });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });

  it("[seeded requirement] REQ-001 links to COMP-EC440 and reports its verification gap", async () => {
    const result = await getRequirement({ requirementId: REQUIREMENT_IDS[0] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.linkedComponents.some((c) => c.componentId === COMPONENT_IDS.ec440)).toBe(
      true,
    );
    expect(result.data.linkedTests.length).toBeGreaterThan(0);
    // REQ-001 has a FAILED test (TEST-001) among its verifying tests, so it
    // has a genuine, non-NONE verification gap.
    expect(result.data.hasVerificationGap).toBe(true);
  });
});

describe("getScheduleDependencies", () => {
  it("[not found] an unknown milestone ID returns NOT_FOUND", async () => {
    const result = await getScheduleDependencies({ milestoneId: "MS-DOES-NOT-EXIST" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  it("[maxDepth ceiling] rejects a maxDepth above MCP_LIMITS.maxDependencyDepth", async () => {
    const result = await getScheduleDependencies({
      milestoneId: MILESTONE_IDS[0],
      maxDepth: MCP_LIMITS.maxDependencyDepth + 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });

  it("[default depth] omitting maxDepth uses the documented default", async () => {
    const result = await getScheduleDependencies({ milestoneId: MILESTONE_IDS[7] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.maxDepth).toBe(MCP_LIMITS.defaultDependencyDepth);
    expect(result.data.upstream.every((n) => n.depth <= result.data.maxDepth)).toBe(true);
  });

  it("[direction preserved] MS-001 has MS-002 as a downstream dependent", async () => {
    const result = await getScheduleDependencies({ milestoneId: MILESTONE_IDS[0], maxDepth: 3 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.downstream.some((n) => n.milestoneId === MILESTONE_IDS[1])).toBe(true);
  });
});

describe("listFailedTests", () => {
  it("[not found] an unknown program ID returns NOT_FOUND", async () => {
    const result = await listFailedTests({ programId: "PROGRAM-DOES-NOT-EXIST" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  it("[only FAILED] every returned test has outcome FAILED — BLOCKED and NOT_RUN are excluded", async () => {
    const result = await listFailedTests({ programId: PROGRAM_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.length).toBe(2);
    for (const test of result.data) {
      expect(test.outcome).toBe("FAILED");
    }
    const dbFailedCount = await prisma.testCase.count({
      where: { programId: PROGRAM_ID, outcome: "FAILED" },
    });
    expect(result.data.length).toBe(dbFailedCount);
  });

  it("[linked defects] a failed test with a related defect reports it", async () => {
    const result = await listFailedTests({ programId: PROGRAM_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.some((test) => test.relatedDefects.length > 0)).toBe(true);
  });
});

describe("listFailedTests — active-defect filtering (correction pass §4)", () => {
  const createdDefectIds: string[] = [];

  afterEach(async () => {
    for (const id of createdDefectIds.splice(0)) {
      await prisma.defect.deleteMany({ where: { id } });
    }
  });

  async function createFixtureDefect(status: "OPEN" | "IN_PROGRESS" | "RESOLVED" | "CLOSED") {
    const id = `DEF-TEST-${randomUUID()}`;
    await prisma.defect.create({
      data: {
        id,
        programId: PROGRAM_ID,
        title: `Fixture defect (${status})`,
        description: "Created for a Phase 7 correction-pass test; safe to delete.",
        severity: "LOW",
        status,
        relatedTestCaseId: TEST_IDS[0],
      },
    });
    createdDefectIds.push(id);
    return id;
  }

  it("OPEN and IN_PROGRESS defects are returned; RESOLVED and CLOSED are excluded", async () => {
    const [openId, inProgressId, resolvedId, closedId] = await Promise.all([
      createFixtureDefect("OPEN"),
      createFixtureDefect("IN_PROGRESS"),
      createFixtureDefect("RESOLVED"),
      createFixtureDefect("CLOSED"),
    ]);

    const before = await prisma.defect.count();
    const result = await listFailedTests({ programId: PROGRAM_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const test001 = result.data.find((t) => t.testCaseId === TEST_IDS[0]);
    expect(test001).toBeDefined();
    const defectIds = new Set(test001?.relatedDefects.map((d) => d.defectId));
    expect(defectIds.has(openId)).toBe(true);
    expect(defectIds.has(inProgressId)).toBe(true);
    expect(defectIds.has(resolvedId)).toBe(false);
    expect(defectIds.has(closedId)).toBe(false);

    // No mutation occurred during an ordinary tool call.
    const after = await prisma.defect.count();
    expect(after).toBe(before);
  });

  it("relatedDefects stay deterministically sorted by defectId", async () => {
    const ids = await Promise.all([
      createFixtureDefect("OPEN"),
      createFixtureDefect("IN_PROGRESS"),
      createFixtureDefect("OPEN"),
    ]);

    const result = await listFailedTests({ programId: PROGRAM_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const test001 = result.data.find((t) => t.testCaseId === TEST_IDS[0]);
    const relevant = (test001?.relatedDefects ?? []).filter((d) => ids.includes(d.defectId));
    const sorted = [...relevant].sort((a, b) => a.defectId.localeCompare(b.defectId));
    expect(relevant).toEqual(sorted);
  });
});

describe("getBudgetVariance", () => {
  it("[seeded totals] matches calculateBudgetVariance's totals with fixed-two-decimal strings", async () => {
    const result = await getBudgetVariance({ programId: PROGRAM_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.plannedTotal).toBe("964000.00");
    expect(result.data.actualTotal).toBe("971500.00");
    expect(result.data.varianceAmount).toBe("7500.00");
    expect(result.data.itemSummaries.length).toBe(5);
    for (const item of result.data.itemSummaries) {
      expect(item.plannedAmount).toMatch(/^\d+\.\d{2}$/);
    }
  });
});

describe("getRiskRegister", () => {
  it("[not found] an unknown program ID returns NOT_FOUND", async () => {
    const result = await getRiskRegister({ programId: "PROGRAM-DOES-NOT-EXIST" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  it("[seeded risks] returns all 4 seeded risks with scores matching computeRiskScore", async () => {
    const result = await getRiskRegister({ programId: PROGRAM_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.length).toBe(4);
    for (const risk of result.data) {
      const dbRisk = await prisma.risk.findUniqueOrThrow({ where: { id: risk.riskId } });
      const expected = computeRiskScore(dbRisk.probability, dbRisk.impact, dbRisk.severity);
      expect(risk.score).toBe(expected.score);
    }
  });

  it("[deterministic sort] open risks sort before closed risks", async () => {
    const result = await getRiskRegister({ programId: PROGRAM_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const statuses = result.data.map((r) => r.status);
    const firstClosedIndex = statuses.indexOf("CLOSED");
    if (firstClosedIndex === -1) return;
    expect(statuses.slice(0, firstClosedIndex).every((s) => s !== "CLOSED")).toBe(true);
  });
});
