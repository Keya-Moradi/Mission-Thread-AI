// Public Phase 2 deterministic-service API — see SPEC.md §8 and
// docs/DECISIONS.md for the error strategy and formulas. Internal helpers
// (pure calculation functions, DB fetch helpers) are exported individually
// by each module for direct unit testing, but this file is the surface
// packages/core/src/index.ts re-exports from.

export type { ServiceResult, DomainError, DomainErrorCode, ImpactRelationship } from "./types";
export { ok, notFound, validationError } from "./types";

export { getImpactedRequirements, getImpactedMilestones } from "./traceability";
export type { ImpactedRequirement, ImpactedMilestone } from "./traceability";

export { getDependencyChain, traverseDependencyChain } from "./dependencies";
export type { DependencyChainResult, DependencyChainNode, DependencyEdge } from "./dependencies";

export { getVerificationGaps, classifyGap } from "./verification";
export type {
  VerificationGapResult,
  VerificationGapsResponse,
  VerificationGapCategory,
} from "./verification";

export { getRelatedDefects, groupRelatedDefects } from "./defects";
export type { RelatedDefect, RelatedDefectsResponse } from "./defects";

export { calculateBudgetVariance, calculateBudgetExposure, sumCurrencyGroup } from "./budget";
export type {
  BudgetVarianceResult,
  BudgetExposureResult,
  CurrencyBudgetTotals,
  ExposedBudgetItem,
  BudgetItemLike,
} from "./budget";

export { calculateScheduleExposure, utcDayDifference, addUtcDays } from "./schedule";
export type { ScheduleExposureResult } from "./schedule";

export { calculateRiskScore, computeRiskScore, bandForScore, MAX_RISK_SCORE } from "./risk";
export type { RiskScoreResult, RiskScoreCalculation, RiskBand } from "./risk";

export { calculateReadinessScore } from "./readiness";
export type { ReadinessScoreResult, ReadinessFactorResult } from "./readiness";

export { buildAnalysisEvidence } from "./evidence";
export type { AnalysisEvidence, EvidenceItem } from "./evidence";
