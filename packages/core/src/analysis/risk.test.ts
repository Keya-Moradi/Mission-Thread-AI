import { describe, expect, it } from "vitest";
import { bandForScore, calculateRiskScore, computeRiskScore } from "./risk";

describe("computeRiskScore / bandForScore — pure, DB-free scoring", () => {
  it("[minimum] probability 1 x impact 1 = score 1, band LOW", () => {
    expect(bandForScore(1)).toBe("LOW");
    const result = computeRiskScore(1, 1, "LOW");
    expect(result.score).toBe(1);
    expect(result.computedBand).toBe("LOW");
    expect(result.severityConsistent).toBe(true);
  });

  it("[maximum] probability 5 x impact 5 = score 25, band CRITICAL", () => {
    expect(bandForScore(25)).toBe("CRITICAL");
    const result = computeRiskScore(5, 5, "CRITICAL");
    expect(result.score).toBe(25);
    expect(result.computedBand).toBe("CRITICAL");
  });

  it("band boundaries: 4->LOW, 5->MEDIUM, 9->MEDIUM, 10->HIGH, 14->HIGH, 15->CRITICAL", () => {
    expect(bandForScore(4)).toBe("LOW");
    expect(bandForScore(5)).toBe("MEDIUM");
    expect(bandForScore(9)).toBe("MEDIUM");
    expect(bandForScore(10)).toBe("HIGH");
    expect(bandForScore(14)).toBe("HIGH");
    expect(bandForScore(15)).toBe("CRITICAL");
  });

  it("[invalid ranges] out-of-range probability/impact are computed anyway, flagged via warnings", () => {
    const tooLow = computeRiskScore(0, 3, "LOW");
    expect(tooLow.warnings.some((w) => w.includes("probability"))).toBe(true);

    const tooHigh = computeRiskScore(3, 6, "HIGH");
    expect(tooHigh.warnings.some((w) => w.includes("impact"))).toBe(true);
  });

  it("[inconsistency] a stored severity that disagrees with the computed band is reported, not overridden", () => {
    const result = computeRiskScore(2, 2, "MEDIUM"); // score 4 -> LOW, but stored says MEDIUM
    expect(result.computedBand).toBe("LOW");
    expect(result.storedSeverity).toBe("MEDIUM");
    expect(result.severityConsistent).toBe(false);
    expect(result.warnings.some((w) => w.includes("disagrees"))).toBe(true);
  });

  it("[consistent case] a stored severity matching the computed band has no warnings", () => {
    const result = computeRiskScore(3, 4, "HIGH"); // score 12 -> HIGH
    expect(result.severityConsistent).toBe(true);
    expect(result.warnings).toEqual([]);
  });
});

describe("calculateRiskScore — DB-backed, against the seeded test database", () => {
  it("[not found] an unknown risk ID returns NOT_FOUND", async () => {
    const result = await calculateRiskScore("RISK-DOES-NOT-EXIST");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  it("[validation] an empty risk ID returns VALIDATION_ERROR", async () => {
    const result = await calculateRiskScore("");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });

  it("RISK-001: probability 3 x impact 4 = 12, band HIGH, consistent with stored HIGH severity", async () => {
    const result = await calculateRiskScore("RISK-001");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      probability: 3,
      impact: 4,
      score: 12,
      computedBand: "HIGH",
      storedSeverity: "HIGH",
      severityConsistent: true,
      status: "OPEN",
    });
  });

  it("[genuine seeded inconsistency] RISK-003 scores LOW but is stored as MEDIUM severity", async () => {
    const result = await calculateRiskScore("RISK-003");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.score).toBe(4);
    expect(result.data.computedBand).toBe("LOW");
    expect(result.data.storedSeverity).toBe("MEDIUM");
    expect(result.data.severityConsistent).toBe(false);
  });
});
