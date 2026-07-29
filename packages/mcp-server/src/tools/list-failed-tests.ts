import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listFailedTests, failedTestsInputSchema } from "@missionthread/core";
import { runTool } from "../tool-result.js";

export function registerListFailedTests(server: McpServer): void {
  server.registerTool(
    "list_failed_tests",
    {
      title: "List failed tests",
      description:
        "Returns every test case with outcome FAILED for one program — never BLOCKED or NOT_RUN — with each test's linked requirement IDs and related open defect IDs and severities. Read-only.",
      inputSchema: failedTestsInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => runTool(() => listFailedTests(input)),
  );
}
