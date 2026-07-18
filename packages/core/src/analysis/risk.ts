import { prisma } from "../db";
import { entityIdSchema } from "./schemas";
import { notFound, ok, validationError, type ServiceResult } from "./types";

export type RiskBand = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

/** Theoretical max score (5x5), used as the fixed denominator for readiness's risk factor. */
export const MAX_RISK_SCORE = 25;

// Documented in docs/DECISIONS.md, "Risk score formula, band mapping, and a
// genuine seeded inconsistency": 1-4 LOW, 5-9 MEDIUM, 10-14 HIGH, 15-25
// CRITICAL, over a probability x impact range conventionally 1-5 each.
export function bandForScore(score: number): RiskBand {
  if (score >= 15) return "CRITICAL";
  if (score >= 10) return "HIGH";
  if (score >= 5) return "MEDIUM";
  return "LOW";
}

export interface RiskScoreCalculation {
  probability: number;
  impact: number;
  score: number;
  computedBand: RiskBand;
  storedSeverity: string;
  /** False when the stored text label disagrees with the computed band — never silently overridden. */
  severityConsistent: boolean;
  warnings: string[];
}

/**
 * Pure, DB-free — unit-testable directly with fabricated (including
 * out-of-range) probability/impact values without seeding bad data.
 */
export function computeRiskScore(
  probability: number,
  impact: number,
  storedSeverity: string,
): RiskScoreCalculation {
  const score = probability * impact;
  const computedBand = bandForScore(score);
  const severityConsistent = computedBand === storedSeverity;
  const warnings: string[] = [];
  if (probability < 1 || probability > 5) {
    warnings.push(`probability ${probability} is outside the expected 1-5 range.`);
  }
  if (impact < 1 || impact > 5) {
    warnings.push(`impact ${impact} is outside the expected 1-5 range.`);
  }
  if (!severityConsistent) {
    warnings.push(
      `stored severity "${storedSeverity}" disagrees with the computed band "${computedBand}".`,
    );
  }
  return { probability, impact, score, computedBand, storedSeverity, severityConsistent, warnings };
}

export interface RiskScoreResult extends RiskScoreCalculation {
  riskId: string;
  status: string;
}

export async function calculateRiskScore(riskId: string): Promise<ServiceResult<RiskScoreResult>> {
  const parsed = entityIdSchema.safeParse(riskId);
  if (!parsed.success) {
    return validationError(parsed.error.issues.map((issue) => issue.message).join("; "));
  }

  const risk = await prisma.risk.findUnique({
    where: { id: parsed.data },
    select: { id: true, probability: true, impact: true, severity: true, status: true },
  });
  if (!risk) {
    return notFound("RISK", parsed.data);
  }

  const calculation = computeRiskScore(risk.probability, risk.impact, risk.severity);
  return ok({ riskId: risk.id, status: risk.status, ...calculation });
}
