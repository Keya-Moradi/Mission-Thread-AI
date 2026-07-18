import { describe, expect, it } from "vitest";
import { getRelatedDefects, groupRelatedDefects } from "./defects";

describe("groupRelatedDefects — pure, DB-free grouping", () => {
  it("[one defect, multiple requirements] a defect whose test case verifies two requirements lists both", () => {
    const result = groupRelatedDefects(
      [
        {
          defectId: "DEF-X",
          title: "Synthetic defect",
          severity: "HIGH",
          status: "OPEN",
          testCaseId: "TEST-X",
        },
      ],
      [
        { testCaseId: "TEST-X", requirementId: "REQ-A" },
        { testCaseId: "TEST-X", requirementId: "REQ-B" },
      ],
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.requirementIds).toEqual(["REQ-A", "REQ-B"]);
    expect(result[0]?.relationshipPath).toBe("REQ-A -> TEST-X -> DEF-X; REQ-B -> TEST-X -> DEF-X");
  });

  it("[closed vs open] status is reported as-is for both open and closed defects, never filtered out", () => {
    const result = groupRelatedDefects(
      [
        {
          defectId: "DEF-OPEN",
          title: "Open one",
          severity: "HIGH",
          status: "OPEN",
          testCaseId: "TEST-A",
        },
        {
          defectId: "DEF-CLOSED",
          title: "Closed one",
          severity: "LOW",
          status: "CLOSED",
          testCaseId: "TEST-B",
        },
      ],
      [
        { testCaseId: "TEST-A", requirementId: "REQ-A" },
        { testCaseId: "TEST-B", requirementId: "REQ-B" },
      ],
    );
    expect(result.find((d) => d.defectId === "DEF-OPEN")?.status).toBe("OPEN");
    expect(result.find((d) => d.defectId === "DEF-CLOSED")?.status).toBe("CLOSED");
  });

  it("[duplicate protection] a duplicate test-requirement link never duplicates a requirement ID", () => {
    const result = groupRelatedDefects(
      [
        {
          defectId: "DEF-X",
          title: "Synthetic defect",
          severity: "HIGH",
          status: "OPEN",
          testCaseId: "TEST-X",
        },
      ],
      [
        { testCaseId: "TEST-X", requirementId: "REQ-A" },
        { testCaseId: "TEST-X", requirementId: "REQ-A" },
      ],
    );
    expect(result[0]?.requirementIds).toEqual(["REQ-A"]);
  });

  it("[no defects] an empty defect list returns an empty result", () => {
    expect(groupRelatedDefects([], [])).toEqual([]);
  });
});

describe("getRelatedDefects — DB-backed, against the seeded test database", () => {
  it("[defect through a failed test] REQ-001 -> TEST-001 -> DEF-001", async () => {
    const result = await getRelatedDefects(["REQ-001"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.results).toHaveLength(1);
    expect(result.data.results[0]).toMatchObject({
      defectId: "DEF-001",
      testCaseId: "TEST-001",
      severity: "HIGH",
      status: "OPEN",
      requirementIds: ["REQ-001"],
    });
  });

  it("[no defects] REQ-003 (a fully-passing requirement) has no related defects", async () => {
    const result = await getRelatedDefects(["REQ-003"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.results).toEqual([]);
  });

  it("[multiple requirements] REQ-001 and REQ-006 each surface their own defect", async () => {
    const result = await getRelatedDefects(["REQ-001", "REQ-006"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.results.map((d) => d.defectId)).toEqual(["DEF-001", "DEF-002"]);
  });

  it("[missing data] an unknown requirement ID is reported in missingRequirementIds", async () => {
    const result = await getRelatedDefects(["REQ-DOES-NOT-EXIST"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.missingRequirementIds).toEqual(["REQ-DOES-NOT-EXIST"]);
  });

  it("[validation] duplicate requirement IDs are rejected", async () => {
    const result = await getRelatedDefects(["REQ-001", "REQ-001"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });
});
