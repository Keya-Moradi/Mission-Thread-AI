import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getScheduleDependencies, scheduleDependenciesInputSchema } from "@missionthread/core";
import { runTool } from "../tool-result.js";

export function registerGetScheduleDependencies(server: McpServer): void {
  server.registerTool(
    "get_schedule_dependencies",
    {
      title: "Get schedule dependencies",
      description:
        "Returns the upstream (prerequisite) and downstream (dependent) milestones for one milestone, up to a bounded depth. Preserves the database's dependency direction and reports whether the result was truncated by the depth limit. Read-only.",
      inputSchema: scheduleDependenciesInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => runTool(() => getScheduleDependencies(input)),
  );
}
