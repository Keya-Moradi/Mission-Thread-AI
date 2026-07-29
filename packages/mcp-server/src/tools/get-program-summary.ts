import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getProgramSummary, programSummaryInputSchema } from "@missionthread/core";
import { runTool } from "../tool-result.js";

export function registerGetProgramSummary(server: McpServer): void {
  server.registerTool(
    "get_program_summary",
    {
      title: "Get program summary",
      description:
        "Returns a bounded summary of one program: record counts, milestone and test status counts, open risk count, budget variance, readiness score, and the most recent event and analysis run. Read-only.",
      inputSchema: programSummaryInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => runTool(() => getProgramSummary(input)),
  );
}
