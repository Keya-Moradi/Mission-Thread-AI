// Package root — a library module only. Importing this file must never
// construct a transport, call either exported function, register a
// SIGINT/SIGTERM handler, call process.exit, or write to stdout/stderr.
// The executable entry point is cli.ts; see docs/ARCHITECTURE.md.
export { createMissionThreadMcpServer } from "./server.js";
export { startMissionThreadStdioServer } from "./stdio-server.js";
