import { describe, expect, it } from "vitest";
import { prisma } from "../db";
import { PROGRAM_ID, REQUIREMENT_IDS, MILESTONE_IDS, COMPONENT_IDS } from "../seed/ids";
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
