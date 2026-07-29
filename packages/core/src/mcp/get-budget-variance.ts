import { prisma } from "../db";
import { validationError, type ServiceResult } from "../analysis/types";
import { calculateBudgetVariance } from "../analysis/budget";
import { budgetVarianceInputSchema } from "./schemas";
import { boundMcpText, MCP_LIMITS } from "./types";
import type { BudgetVarianceSummary } from "./types";

export async function getBudgetVariance(
  input: unknown,
): Promise<ServiceResult<BudgetVarianceSummary>> {
  const parsed = budgetVarianceInputSchema.safeParse(input);
  if (!parsed.success) {
    return validationError(parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  const { programId } = parsed.data;

  const result = await calculateBudgetVariance(programId);
  if (!result.ok) {
    return result;
  }

  const items = await prisma.budgetItem.findMany({
    where: { programId },
    orderBy: { id: "asc" },
    take: MCP_LIMITS.maxRecords,
    select: {
      id: true,
      category: true,
      plannedAmount: true,
      actualAmount: true,
      currency: true,
    },
  });

  return {
    ok: true,
    data: {
      programId,
      currency: result.data.currency,
      plannedTotal: result.data.plannedTotal,
      actualTotal: result.data.actualTotal,
      varianceAmount: result.data.varianceAmount,
      variancePercentage: result.data.variancePercentage,
      itemSummaries: items.map((item) => ({
        budgetItemId: item.id,
        category: boundMcpText(item.category),
        plannedAmount: item.plannedAmount.toFixed(2),
        actualAmount: item.actualAmount.toFixed(2),
        varianceAmount: item.actualAmount.minus(item.plannedAmount).toFixed(2),
        currency: item.currency,
      })),
      missingData: result.data.missingData,
    },
  };
}
