import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getBudgetVariance, budgetVarianceInputSchema } from "@missionthread/core";
import { runTool } from "../tool-result.js";

export function registerGetBudgetVariance(server: McpServer): void {
  server.registerTool(
    "get_budget_variance",
    {
      title: "Get budget variance",
      description:
        "Returns one program's budget totals (planned, actual, variance, as fixed two-decimal amounts) and a bounded per-item breakdown, with explicit missing-data warnings when a total cannot be computed. Read-only.",
      inputSchema: budgetVarianceInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => runTool(() => getBudgetVariance(input)),
  );
}
