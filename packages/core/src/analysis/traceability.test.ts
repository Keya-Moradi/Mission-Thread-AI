import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../db";
import { PROGRAM_ID } from "../seed/ids";
import { getImpactedRequirements, getImpactedMilestones } from "./traceability";

describe("getImpactedRequirements", () => {
  it("[direct impacts] COMP-EC440 is linked to REQ-001, REQ-002, REQ-006, REQ-008", async () => {
    const result = await getImpactedRequirements("COMP-EC440");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.map((r) => r.requirementId)).toEqual([
      "REQ-001",
      "REQ-002",
      "REQ-006",
      "REQ-008",
    ]);
    expect(result.data.every((r) => r.relationship === "direct")).toBe(true);
  });

  it("[fewer impacts] COMP-BATTERY is linked only to REQ-003", async () => {
    const result = await getImpactedRequirements("COMP-BATTERY");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.map((r) => r.requirementId)).toEqual(["REQ-003"]);
  });

  it("[not found] an unknown component ID returns NOT_FOUND", async () => {
    const result = await getImpactedRequirements("COMP-DOES-NOT-EXIST");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  it("[validation] a whitespace-only component ID returns VALIDATION_ERROR", async () => {
    const result = await getImpactedRequirements("   ");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });

  it("[deterministic ordering] repeated calls return the identical result", async () => {
    const first = await getImpactedRequirements("COMP-EC440");
    const second = await getImpactedRequirements("COMP-EC440");
    expect(first).toEqual(second);
  });
});

describe("getImpactedMilestones", () => {
  it("[direct + dependency-derived] COMP-EC440 has 3 direct milestones and 1 dependency-derived", async () => {
    const result = await getImpactedMilestones("COMP-EC440");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const direct = result.data.filter((m) => m.relationship === "direct").map((m) => m.milestoneId);
    const derived = result.data
      .filter((m) => m.relationship === "dependency-derived")
      .map((m) => m.milestoneId);
    expect(direct.sort()).toEqual(["MS-001", "MS-002", "MS-008"]);
    expect(derived).toEqual(["MS-006"]);
  });

  it("[dependency-derived impacts] COMP-BATTERY's direct MS-004 cascades to dependency-derived MS-008", async () => {
    const result = await getImpactedMilestones("COMP-BATTERY");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.find((m) => m.milestoneId === "MS-004")?.relationship).toBe("direct");
    expect(result.data.find((m) => m.milestoneId === "MS-008")?.relationship).toBe(
      "dependency-derived",
    );
  });

  it("[not found] an unknown component ID returns NOT_FOUND", async () => {
    const result = await getImpactedMilestones("COMP-DOES-NOT-EXIST");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  it("[duplicate elimination] every milestoneId in the result is unique", async () => {
    const result = await getImpactedMilestones("COMP-EC440");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.data.map((m) => m.milestoneId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("no matches — an existing component with no linked requirements or milestones", () => {
  const isolatedComponentId = "COMP-TEST-ISOLATED-NO-LINKS";

  beforeAll(async () => {
    await prisma.component.create({
      data: {
        id: isolatedComponentId,
        programId: PROGRAM_ID,
        name: "Test-only isolated component",
        subsystem: "test fixture",
        description: "Created only for a no-impacts test case; deleted in afterAll.",
      },
    });
  });

  afterAll(async () => {
    await prisma.component.delete({ where: { id: isolatedComponentId } });
  });

  it("getImpactedRequirements returns an empty array, not NOT_FOUND", async () => {
    const result = await getImpactedRequirements(isolatedComponentId);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual([]);
  });

  it("getImpactedMilestones returns an empty array, not NOT_FOUND", async () => {
    const result = await getImpactedMilestones(isolatedComponentId);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual([]);
  });
});
