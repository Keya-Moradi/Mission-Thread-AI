// Shared output bounds for every MCP read service (Phase 7, PART B, §13).
// These are framework-independent (no MCP SDK import here) — packages/mcp-server
// wraps this module's ServiceResult<T> outputs into the MCP content format
// and additionally enforces the wire-level byte ceiling on the final
// serialized tool result (see packages/mcp-server/src/tool-result.ts).
export const MCP_LIMITS = {
  /** Maximum records returned by any list-shaped tool (list_failed_tests, get_risk_register, budget item summaries). */
  maxRecords: 100,
  /** Maximum dependency-chain hop depth get_schedule_dependencies will ever traverse, regardless of the caller-supplied maxDepth. */
  maxDependencyDepth: 10,
  /** Default dependency-chain depth when the caller omits maxDepth. */
  defaultDependencyDepth: 5,
  /** Maximum length of any free-text-ish field this module emits (names, titles — never raw notes/rationale, which are never emitted at all). */
  maxTextLength: 300,
} as const;

export interface RecordCounts {
  components: number;
  requirements: number;
  milestones: number;
  risks: number;
  suppliers: number;
  testCases: number;
  defects: number;
  budgetItems: number;
  events: number;
}

export interface ProgramSummary {
  programId: string;
  name: string;
  description: string;
  counts: RecordCounts;
  milestoneStatusCounts: Record<string, number>;
  testOutcomeCounts: Record<string, number>;
  openRiskCount: number;
  budgetVariance: {
    currency: string | null;
    plannedTotal: string | null;
    actualTotal: string | null;
    varianceAmount: string | null;
    variancePercentage: number | null;
  };
  readinessScore: {
    totalScore: number;
    warningCount: number;
  } | null;
  mostRecentEvent: {
    eventId: string;
    eventType: string;
    createdAt: string;
  } | null;
  mostRecentAnalysisRun: {
    analysisRunId: string;
    terminalStatus: string;
    terminalTraceId: string;
    createdAt: string;
  } | null;
}

export interface RequirementDetail {
  requirementId: string;
  title: string;
  priority: string;
  status: string;
  linkedComponents: Array<{ componentId: string; name: string }>;
  linkedTests: Array<{ testCaseId: string; name: string; outcome: string }>;
  relatedDefects: Array<{ defectId: string; severity: string; status: string }>;
  hasVerificationGap: boolean;
  verificationGapCategory: string;
}

export interface DependencyNode {
  milestoneId: string;
  name: string;
  status: string;
  plannedDate: string;
  depth: number;
  viaDependencyId: string;
}

export interface ScheduleDependencies {
  milestoneId: string;
  maxDepth: number;
  upstream: DependencyNode[];
  downstream: DependencyNode[];
  truncatedByMaxDepth: boolean;
  missingData: string[];
}

export interface FailedTest {
  testCaseId: string;
  name: string;
  outcome: "FAILED";
  lastRunAt: string | null;
  requirementIds: string[];
  relatedDefects: Array<{ defectId: string; severity: string }>;
}

export interface BudgetVarianceSummary {
  programId: string;
  currency: string | null;
  plannedTotal: string | null;
  actualTotal: string | null;
  varianceAmount: string | null;
  variancePercentage: number | null;
  itemSummaries: Array<{
    budgetItemId: string;
    category: string;
    plannedAmount: string;
    actualAmount: string;
    varianceAmount: string;
    currency: string;
  }>;
  missingData: string[];
}

export interface RiskRegisterEntry {
  riskId: string;
  title: string;
  severity: string;
  probability: number;
  impact: number;
  status: string;
  componentId: string | null;
  score: number;
}
