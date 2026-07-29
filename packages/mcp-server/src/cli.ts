import { disconnectDatabase, startMissionThreadStdioServer } from "./stdio-server.js";

// The executable entry point — the only file in this package permitted to
// register process-level signal handlers, call process.exit, or write to
// stderr. MCP stdio reserves stdout for protocol messages (§17): nothing
// here may ever call console.log.

process.on("SIGINT", () => {
  void disconnectDatabase().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void disconnectDatabase().finally(() => process.exit(0));
});

startMissionThreadStdioServer().catch(async () => {
  // Exactly one fixed, safe message — never error.message, a stack trace,
  // a database URL, a transport error, a credential, or raw
  // Prisma/SDK error text. See docs/THREAT_MODEL.md.
  console.error("MissionThread AI MCP server failed to start.");
  await disconnectDatabase();
  // Prefer setting the exit code and letting the process end naturally
  // once the disconnect above has settled, rather than calling
  // process.exit() immediately — avoids ever truncating the cleanup
  // above mid-flight.
  process.exitCode = 1;
});
