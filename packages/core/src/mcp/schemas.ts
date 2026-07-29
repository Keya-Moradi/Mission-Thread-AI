import { z } from "zod";
import { entityIdSchema } from "../analysis/schemas";
import { MCP_LIMITS } from "./types";

// .strict() on every input schema — an MCP tool call with an unrecognized
// field is rejected outright rather than silently ignored, matching §20
// ("all input schemas reject unknown fields").

// MCP-specific bound on top of the shared Phase 2 entityIdSchema — a
// caller-supplied ID reaching an MCP tool over stdio has no other length
// guard before this one, unlike an internal call from apps/web (which only
// ever passes IDs it read back out of the database itself). Deliberately
// does not change entityIdSchema itself, which every other Phase 2/3/4/5
// consumer still uses unbounded — see docs/DECISIONS.md.
export const mcpEntityIdSchema = entityIdSchema.max(
  MCP_LIMITS.maxIdLength,
  "ID exceeds the maximum permitted length",
);

export const programSummaryInputSchema = z.object({ programId: mcpEntityIdSchema }).strict();
export type ProgramSummaryInput = z.infer<typeof programSummaryInputSchema>;

export const requirementInputSchema = z.object({ requirementId: mcpEntityIdSchema }).strict();
export type RequirementInput = z.infer<typeof requirementInputSchema>;

export const scheduleDependenciesInputSchema = z
  .object({
    milestoneId: mcpEntityIdSchema,
    maxDepth: z.number().int().min(1).max(MCP_LIMITS.maxDependencyDepth).optional(),
  })
  .strict();
export type ScheduleDependenciesInput = z.infer<typeof scheduleDependenciesInputSchema>;

export const failedTestsInputSchema = z.object({ programId: mcpEntityIdSchema }).strict();
export type FailedTestsInput = z.infer<typeof failedTestsInputSchema>;

export const budgetVarianceInputSchema = z.object({ programId: mcpEntityIdSchema }).strict();
export type BudgetVarianceInput = z.infer<typeof budgetVarianceInputSchema>;

export const riskRegisterInputSchema = z.object({ programId: mcpEntityIdSchema }).strict();
export type RiskRegisterInput = z.infer<typeof riskRegisterInputSchema>;
