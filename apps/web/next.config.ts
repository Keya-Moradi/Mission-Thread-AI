import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @missionthread/core ships its TypeScript source directly (npm workspace,
  // no build step), so Next needs to transpile it like it does apps/web itself.
  transpilePackages: ["@missionthread/core"],
  // Pin the workspace root to this monorepo. Without this, Turbopack's
  // auto-detection can pick a stray package-lock.json elsewhere on the
  // machine (e.g. in the user's home directory) as the root.
  turbopack: {
    root: path.join(__dirname, "..", ".."),
  },
  // Produces .next/standalone: a minimal, self-contained server bundle with
  // only the node_modules this app actually needs (traced from its actual
  // imports, including the @missionthread/core workspace package), instead
  // of requiring the full monorepo node_modules tree in the runtime image.
  output: "standalone",
  // Output file tracing defaults to this app's own directory in a monorepo,
  // which would miss the sibling @missionthread/core workspace package and
  // the root lockfile. Point it at the monorepo root instead.
  outputFileTracingRoot: path.join(__dirname, "..", ".."),
};

export default nextConfig;
