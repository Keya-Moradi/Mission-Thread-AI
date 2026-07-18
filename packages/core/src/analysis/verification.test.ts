import { describe, expect, it } from "vitest";
import { classifyGap, getVerificationGaps } from "./verification";

describe("classifyGap — pure, DB-free classification", () => {
  it("no tests at all classifies as NO_COVERAGE", () => {
    expect(classifyGap([])).toBe("NO_COVERAGE");
  });

  it("all PASSED classifies as NONE (no gap)", () => {
    expect(classifyGap(["PASSED"])).toBe("NONE");
    expect(classifyGap(["PASSED", "PASSED"])).toBe("NONE");
  });

  it("any FAILED wins over a PASSED sibling", () => {
    expect(classifyGap(["PASSED", "FAILED"])).toBe("FAILED");
  });

  it("BLOCKED outranks NOT_RUN when both are present", () => {
    expect(classifyGap(["NOT_RUN", "BLOCKED"])).toBe("BLOCKED");
  });

  it("a lone NOT_RUN classifies as NOT_RUN", () => {
    expect(classifyGap(["NOT_RUN"])).toBe("NOT_RUN");
  });
});

describe("getVerificationGaps — DB-backed, against the seeded test database", () => {
  it("[mixed outcomes] REQ-001 (FAILED), REQ-003 (fully verified), REQ-008 (no coverage)", async () => {
    const result = await getVerificationGaps(["REQ-001", "REQ-003", "REQ-008"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byId = new Map(result.data.results.map((r) => [r.requirementId, r]));
    expect(byId.get("REQ-001")?.gapCategory).toBe("FAILED");
    expect(byId.get("REQ-003")?.gapCategory).toBe("NONE");
    expect(byId.get("REQ-008")?.gapCategory).toBe("NO_COVERAGE");
    expect(byId.get("REQ-008")?.testIds).toEqual([]);
    expect(result.data.missingRequirementIds).toEqual([]);
  });

  it("[requirement with no tests] REQ-008 has zero associated tests", async () => {
    const result = await getVerificationGaps(["REQ-008"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.results[0]?.gapCategory).toBe("NO_COVERAGE");
  });

  it("[missing data] an unknown requirement ID is reported in missingRequirementIds, not silently dropped", async () => {
    const result = await getVerificationGaps(["REQ-001", "REQ-DOES-NOT-EXIST"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.missingRequirementIds).toEqual(["REQ-DOES-NOT-EXIST"]);
    expect(result.data.results.map((r) => r.requirementId)).toEqual(["REQ-001"]);
  });

  it("[empty input] an empty array returns an empty result, not an error", async () => {
    const result = await getVerificationGaps([]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ results: [], missingRequirementIds: [] });
  });

  it("[validation] duplicate requirement IDs are rejected", async () => {
    const result = await getVerificationGaps(["REQ-001", "REQ-001"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });
});
