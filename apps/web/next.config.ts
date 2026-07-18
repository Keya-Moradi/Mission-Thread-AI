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
};

export default nextConfig;
