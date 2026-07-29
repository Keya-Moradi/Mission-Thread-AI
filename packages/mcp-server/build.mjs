// Bundles this package's own source *and* @missionthread/core's source
// (which uses extensionless relative imports under TypeScript's "bundler"
// module resolution — not natively loadable by plain `node`) into one
// self-contained dist/index.js. Genuine npm dependencies stay external so
// Node resolves them normally from node_modules at runtime instead of being
// inlined — critical for @prisma/client, which loads native query-engine
// binaries and cannot be bundled. See docs/DECISIONS.md, "Phase 7 MCP
// server build".
import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist/index.js",
  sourcemap: false,
  external: [
    "@prisma/client",
    "@prisma/adapter-pg",
    "pg",
    "pg-cloudflare",
    "cloudflare:sockets",
    "openai",
    "@modelcontextprotocol/sdk",
    "@modelcontextprotocol/sdk/*",
    "zod",
  ],
});

console.log("Built dist/index.js");
