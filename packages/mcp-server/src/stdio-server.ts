import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { prisma } from "@missionthread/core";
import { createMissionThreadMcpServer } from "./server.js";

// MCP stdio reserves stdout for protocol messages (§17) — nothing in this
// file may ever call console.log. Connecting stdio happens only when
// startMissionThreadStdioServer() is explicitly called — importing this
// module constructs no transport and registers no process handler; those
// belong to cli.ts, the executable entry point, alone.

/**
 * Builds the server and connects it to stdio. This is the only function in
 * this package that ever constructs a transport.
 */
export async function startMissionThreadStdioServer(): Promise<void> {
  const server = createMissionThreadMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * Best-effort clean Prisma shutdown, shared by cli.ts's signal handlers and
 * its startup-failure path. Never throws, never logs — a disconnect
 * failure must not change the process's exit behavior or print anything.
 */
export async function disconnectDatabase(): Promise<void> {
  try {
    await prisma.$disconnect();
  } catch {
    // Best-effort — see doc comment above.
  }
}
