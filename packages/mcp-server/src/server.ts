import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerGetProgramSummary } from "./tools/get-program-summary.js";
import { registerGetRequirement } from "./tools/get-requirement.js";
import { registerGetScheduleDependencies } from "./tools/get-schedule-dependencies.js";
import { registerListFailedTests } from "./tools/list-failed-tests.js";
import { registerGetBudgetVariance } from "./tools/get-budget-variance.js";
import { registerGetRiskRegister } from "./tools/get-risk-register.js";

/**
 * Constructs a MissionThread AI MCP server with exactly the six read-only
 * tools in SPEC.md §15 registered. Deliberately does not connect any
 * transport — importing or calling this function must have zero side
 * effects beyond building the in-memory server object (§15: "Importing the
 * package in a test must NOT: connect a transport; write to stdout; open a
 * provider connection; mutate the database."). Only src/index.ts, the
 * executable entry point, ever connects a transport.
 */
export function createMissionThreadMcpServer(): McpServer {
  const server = new McpServer(
    { name: "missionthread-ai", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Local, read-only access to fictional MissionThread AI program data. Six tools only; no write capability.",
    },
  );

  registerGetProgramSummary(server);
  registerGetRequirement(server);
  registerGetScheduleDependencies(server);
  registerListFailedTests(server);
  registerGetBudgetVariance(server);
  registerGetRiskRegister(server);

  return server;
}
