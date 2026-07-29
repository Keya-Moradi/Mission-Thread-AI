import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getRequirement, requirementInputSchema } from "@missionthread/core";
import { runTool } from "../tool-result.js";

export function registerGetRequirement(server: McpServer): void {
  server.registerTool(
    "get_requirement",
    {
      title: "Get requirement",
      description:
        "Returns one requirement's safe fields, linked components, linked tests and their outcomes, related defects, and whether a current verification gap exists. Read-only.",
      inputSchema: requirementInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => runTool(() => getRequirement(input)),
  );
}
