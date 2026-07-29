import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getRiskRegister, riskRegisterInputSchema } from "@missionthread/core";
import { runTool } from "../tool-result.js";

export function registerGetRiskRegister(server: McpServer): void {
  server.registerTool(
    "get_risk_register",
    {
      title: "Get risk register",
      description:
        "Returns one program's risks (title, severity, probability, impact, status, linked component ID, deterministic risk score), sorted by open status, then severity, then score, then risk ID. Read-only.",
      inputSchema: riskRegisterInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => runTool(() => getRiskRegister(input)),
  );
}
