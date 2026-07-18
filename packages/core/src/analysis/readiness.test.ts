import { describe, expect, it } from "vitest";
import { prisma } from "../db";
import { PROGRAM_ID } from "../seed/ids";
import { calculateReadinessScore } from "./readiness";

describe("calculateReadinessScore — DB-backed, against the seeded test database", () => {
  it("[not found] an unknown program ID returns NOT_FOUND", async () => {
    const result = await calculateReadinessScore("PROGRAM-DOES-NOT-EXIST");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  it("[the seeded program's exact expected score] EdgeLink-X scores exactly 56/100", async () => {
    const result = await calculateReadinessScore(PROGRAM_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.totalScore).toBe(56);
  });

  it("[factor breakdown] every factor score matches the documented formula for this seed data", async () => {
    const result = await calculateReadinessScore(PROGRAM_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byLabel = new Map(result.data.factors.map((f) => [f.label, f.score]));
    // 3/8 requirements fully verified (REQ-003, REQ-004, REQ-007) x 20
    expect(byLabel.get("Verification coverage")).toBeCloseTo(7.5, 5);
    // 4/8 tests PASSED x 20
    expect(byLabel.get("Test health")).toBeCloseTo(10, 5);
    // 7/8 milestones not AT_RISK/DELAYED (only MS-001 is AT_RISK) x 20
    expect(byLabel.get("Milestone health")).toBeCloseTo(17.5, 5);
    // 1/3 defects not OPEN/IN_PROGRESS (only DEF-003 is CLOSED) x 20
    expect(byLabel.get("Defect health")).toBeCloseTo(6.6667, 3);
    // 4 active risks (RISK-001..004), average score 6.5/25 x 20
    expect(byLabel.get("Risk health")).toBeCloseTo(14.8, 5);
  });

  it("[deterministic repeatability] repeated calls return the identical result", async () => {
    const first = await calculateReadinessScore(PROGRAM_ID);
    const second = await calculateReadinessScore(PROGRAM_ID);
    expect(first).toEqual(second);
  });

  it("[range] the total score always stays within [0, 100]", async () => {
    const result = await calculateReadinessScore(PROGRAM_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.totalScore).toBeGreaterThanOrEqual(0);
    expect(result.data.totalScore).toBeLessThanOrEqual(100);
  });

  describe("[missing data] an isolated program with no tests, budget items, requirements, milestones, defects, or risks", () => {
    const emptyProgramId = "PROGRAM-TEST-EMPTY-READINESS";

    it("every factor scores neutral (full 20 points) with an explanatory warning", async () => {
      await prisma.program.create({
        data: {
          id: emptyProgramId,
          name: "Temp empty program",
          description: "Deleted after this test.",
        },
      });
      try {
        const result = await calculateReadinessScore(emptyProgramId);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.data.totalScore).toBe(100);
        expect(result.data.factors.every((f) => f.score === 20)).toBe(true);
        expect(result.data.warnings.length).toBe(5);
      } finally {
        await prisma.program.delete({ where: { id: emptyProgramId } });
      }
    });
  });
});
