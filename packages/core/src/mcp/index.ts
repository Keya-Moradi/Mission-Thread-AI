// Framework-independent MCP read services (Phase 7, PART B, §13). This
// module must never import the MCP SDK — packages/mcp-server wraps these
// ServiceResult<T> functions into MCP tools.
export { MCP_LIMITS } from "./types";
export type {
  RecordCounts,
  ProgramSummary,
  RequirementDetail,
  DependencyNode,
  ScheduleDependencies,
  FailedTest,
  BudgetVarianceSummary,
  RiskRegisterEntry,
} from "./types";

export {
  programSummaryInputSchema,
  requirementInputSchema,
  scheduleDependenciesInputSchema,
  failedTestsInputSchema,
  budgetVarianceInputSchema,
  riskRegisterInputSchema,
} from "./schemas";
export type {
  ProgramSummaryInput,
  RequirementInput,
  ScheduleDependenciesInput,
  FailedTestsInput,
  BudgetVarianceInput,
  RiskRegisterInput,
} from "./schemas";

export { getProgramSummary } from "./get-program-summary";
export { getRequirement } from "./get-requirement";
export { getScheduleDependencies } from "./get-schedule-dependencies";
export { listFailedTests } from "./list-failed-tests";
export { getBudgetVariance } from "./get-budget-variance";
export { getRiskRegister } from "./get-risk-register";
