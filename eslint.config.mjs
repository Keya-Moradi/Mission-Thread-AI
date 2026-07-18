// Root ESLint flat config for packages/core and packages/mcp-server.
// apps/web keeps its own eslint.config.mjs (Next.js-specific rules); ESLint's
// flat config resolves the nearest config file, so the two never conflict.
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "apps/web/**"],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
);
