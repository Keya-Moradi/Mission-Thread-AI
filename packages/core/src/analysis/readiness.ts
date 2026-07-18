import { prisma } from "../db";
import { entityIdSchema } from "./schemas";
import { notFound, ok, validationError, type ServiceResult } from "./types";
import { getVerificationGaps } from "./verification";
import { computeRiskScore, MAX_RISK_SCORE } from "./risk";

export interface ReadinessFactorResult {
  label: string;
  /** Out of 20 — see docs/DECISIONS.md for why five equal-weighted factors. */
  score: number;
  detail: string;
  warning: string | null;
}

export interface ReadinessScoreResult {
  programId: string;
  /** Sum of the five factor scores, rounded to the nearest integer and clamped to [0, 100]. */
  totalScore: number;
  factors: ReadinessFactorResult[];
  warnings: string[];
  sourceRecordIds: {
    requirementIds: string[];
    testCaseIds: string[];
    milestoneIds: string[];
    defectIds: string[];
    riskIds: string[];
  };
}

// Missing-data policy (docs/DECISIONS.md): a factor with no records to
// evaluate scores its full 20 points (neutral, not penalized) and surfaces
// a warning, rather than being scored zero or redistributing other weights.
function ratioFactor(
  label: string,
  healthyCount: number,
  totalCount: number,
  noDataNoun: string,
): ReadinessFactorResult {
  if (totalCount === 0) {
    return {
      label,
      score: 20,
      detail: `0/0 ${noDataNoun}`,
      warning: `No ${noDataNoun} found; "${label}" scored as neutral.`,
    };
  }
  const score = (healthyCount / totalCount) * 20;
  return {
    label,
    score,
    detail: `${healthyCount}/${totalCount} ${noDataNoun} healthy`,
    warning: null,
  };
}

function riskHealthFactor(activeRiskScores: readonly number[]): ReadinessFactorResult {
  if (activeRiskScores.length === 0) {
    return {
      label: "Risk health",
      score: 20,
      detail: "0 active risks",
      warning: 'No open or mitigating risks found; "Risk health" scored as neutral.',
    };
  }
  const average = activeRiskScores.reduce((sum, score) => sum + score, 0) / activeRiskScores.length;
  const score = (1 - average / MAX_RISK_SCORE) * 20;
  return {
    label: "Risk health",
    score,
    detail: `${activeRiskScores.length} active risk(s), average score ${average.toFixed(2)}/${MAX_RISK_SCORE}`,
    warning: null,
  };
}

export async function calculateReadinessScore(
  programId: string,
): Promise<ServiceResult<ReadinessScoreResult>> {
  const parsed = entityIdSchema.safeParse(programId);
  if (!parsed.success) {
    return validationError(parsed.error.issues.map((issue) => issue.message).join("; "));
  }

  const program = await prisma.program.findUnique({
    where: { id: parsed.data },
    select: { id: true },
  });
  if (!program) {
    return notFound("PROGRAM", parsed.data);
  }

  const [requirements, testCases, milestones, defects, risks] = await Promise.all([
    prisma.requirement.findMany({ where: { programId: parsed.data }, select: { id: true } }),
    prisma.testCase.findMany({
      where: { programId: parsed.data },
      select: { id: true, outcome: true },
    }),
    prisma.milestone.findMany({
      where: { programId: parsed.data },
      select: { id: true, status: true },
    }),
    prisma.defect.findMany({
      where: { programId: parsed.data },
      select: { id: true, status: true },
    }),
    prisma.risk.findMany({
      where: { programId: parsed.data },
      select: { id: true, probability: true, impact: true, severity: true, status: true },
    }),
  ]);

  const warnings: string[] = [];

  const requirementIds = requirements.map((r) => r.id).sort();
  let verifiedCount = 0;
  if (requirementIds.length > 0) {
    const gaps = await getVerificationGaps(requirementIds);
    if (gaps.ok) {
      verifiedCount = gaps.data.results.filter((r) => r.gapCategory === "NONE").length;
    } else {
      warnings.push(`Could not compute verification coverage: ${gaps.error.message}`);
    }
  }
  const verificationFactor = ratioFactor(
    "Verification coverage",
    verifiedCount,
    requirementIds.length,
    "requirements",
  );

  const testHealthFactor = ratioFactor(
    "Test health",
    testCases.filter((t) => t.outcome === "PASSED").length,
    testCases.length,
    "tests",
  );

  const milestoneHealthFactor = ratioFactor(
    "Milestone health",
    milestones.filter((m) => m.status !== "AT_RISK" && m.status !== "DELAYED").length,
    milestones.length,
    "milestones",
  );

  const defectHealthFactor = ratioFactor(
    "Defect health",
    defects.filter((d) => d.status !== "OPEN" && d.status !== "IN_PROGRESS").length,
    defects.length,
    "defects",
  );

  const activeRiskScores = risks
    .filter((r) => r.status === "OPEN" || r.status === "MITIGATING")
    .map((r) => computeRiskScore(r.probability, r.impact, r.severity).score);
  const riskFactor = riskHealthFactor(activeRiskScores);

  const factors = [
    verificationFactor,
    testHealthFactor,
    milestoneHealthFactor,
    defectHealthFactor,
    riskFactor,
  ];
  for (const factor of factors) {
    if (factor.warning) warnings.push(factor.warning);
  }

  const totalScore = Math.min(
    100,
    Math.max(0, Math.round(factors.reduce((sum, f) => sum + f.score, 0))),
  );

  return ok({
    programId: parsed.data,
    totalScore,
    factors,
    warnings,
    sourceRecordIds: {
      requirementIds,
      testCaseIds: testCases.map((t) => t.id).sort(),
      milestoneIds: milestones.map((m) => m.id).sort(),
      defectIds: defects.map((d) => d.id).sort(),
      riskIds: risks.map((r) => r.id).sort(),
    },
  });
}
