import { z } from "zod";
import { entityIdSchema } from "../analysis/schemas";
import { MCP_LIMITS } from "./types";

// .strict() on every input schema — an MCP tool call with an unrecognized
// field is rejected outright rather than silently ignored, matching §20
// ("all input schemas reject unknown fields").

export const programSummaryInputSchema = z.object({ programId: entityIdSchema }).strict();
export type ProgramSummaryInput = z.infer<typeof programSummaryInputSchema>;

export const requirementInputSchema = z.object({ requirementId: entityIdSchema }).strict();
export type RequirementInput = z.infer<typeof requirementInputSchema>;

export const scheduleDependenciesInputSchema = z
  .object({
    milestoneId: entityIdSchema,
    maxDepth: z.number().int().min(1).max(MCP_LIMITS.maxDependencyDepth).optional(),
  })
  .strict();
export type ScheduleDependenciesInput = z.infer<typeof scheduleDependenciesInputSchema>;

export const failedTestsInputSchema = z.object({ programId: entityIdSchema }).strict();
export type FailedTestsInput = z.infer<typeof failedTestsInputSchema>;

export const budgetVarianceInputSchema = z.object({ programId: entityIdSchema }).strict();
export type BudgetVarianceInput = z.infer<typeof budgetVarianceInputSchema>;

export const riskRegisterInputSchema = z.object({ programId: entityIdSchema }).strict();
export type RiskRegisterInput = z.infer<typeof riskRegisterInputSchema>;
