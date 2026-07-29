import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { prisma } from "@missionthread/core";
import { createMissionThreadMcpServer } from "./server.js";

// MCP stdio reserves stdout for protocol messages (§17) — this file must
// never call console.log. Diagnostics use console.error (stderr) only, and
// must never contain a tool result, database URL, credential, or complete
// database error.

/**
 * Builds the server and connects it to stdio. This is the only function in
 * this package that ever constructs a transport — see server.ts.
 */
export async function startMissionThreadStdioServer(): Promise<void> {
  const server = createMissionThreadMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function shutdown(): Promise<void> {
  try {
    await prisma.$disconnect();
  } catch {
    // Best-effort on shutdown — never let a disconnect failure change the
    // process's exit behavior or print anything beyond this safe path.
  }
}

process.on("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});

startMissionThreadStdioServer().catch(async (error: unknown) => {
  console.error(
    "MissionThread AI MCP server failed to start:",
    error instanceof Error ? error.message : "unknown error",
  );
  await shutdown();
  process.exit(1);
});
