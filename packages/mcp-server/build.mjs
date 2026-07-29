// Bundles this package's own source *and* @missionthread/core's source
// (which uses extensionless relative imports under TypeScript's "bundler"
// module resolution — not natively loadable by plain `node`) into two
// self-contained, independent outputs: dist/index.js (the side-effect-free
// library entry — createMissionThreadMcpServer/startMissionThreadStdioServer
// only) and dist/cli.js (the executable that actually connects stdio and
// registers process signal handlers). Genuine npm dependencies stay
// external so Node resolves them normally from node_modules at runtime
// instead of being inlined — critical for @prisma/client, which loads
// native query-engine binaries and cannot be bundled. See
// docs/DECISIONS.md, "Phase 7 MCP server build".
import { build } from "esbuild";

const external = [
  "@prisma/client",
  "@prisma/adapter-pg",
  "pg",
  "pg-cloudflare",
  "cloudflare:sockets",
  "openai",
  "@modelcontextprotocol/sdk",
  "@modelcontextprotocol/sdk/*",
  "zod",
];

// Two independent build() calls (not one multi-entry build with a shared
// outdir) so dist/index.js and dist/cli.js are each fully self-contained —
// neither depends on the other at runtime, and importing dist/index.js
// alone never pulls in cli.js's process-handler-registering code.
await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist/index.js",
  sourcemap: false,
  external,
});

await build({
  entryPoints: ["src/cli.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist/cli.js",
  sourcemap: false,
  external,
});

console.log("Built dist/index.js and dist/cli.js");
