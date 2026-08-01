import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PROGRAM_ID } from "@missionthread/core";

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST_CLI = path.join(PACKAGE_DIR, "dist", "cli.js");
const DIST_CLI_EXISTS = existsSync(DIST_CLI);
// GITHUB_ACTIONS=true (not the generic, loosely-set CI variable — see
// packages/core/src/db-safety.ts's identical discipline) is the one signal
// this repository treats as authoritative for "this is a CI run, not an
// ordinary local `npm test`."
const IS_GITHUB_ACTIONS = process.env.GITHUB_ACTIONS === "true";

// Complements server.test.ts's InMemoryTransport protocol test (which
// exercises the McpServer object directly) by driving the *actual built
// executable* — dist/cli.js, spawned as a real child process over real
// stdio — through the same round trip.
//
// Locally, this is skipped (visibly, as "skipped" in the Vitest summary,
// never silently reported as a pass) when dist/ hasn't been built yet, so
// an ordinary `npm run test`/`test:mcp` never requires a prior build — run
// `npm run build --workspace @missionthread/mcp-server` first for full
// coverage.
//
// In a GitHub Actions run specifically, a missing dist/cli.js is treated as
// a hard failure, not a skip: CI's whole reason for running this suite is
// to prove the emitted, built stdio server actually works end to end, and
// a silently-skipped test here would make a green CI run misleadingly look
// like that proof exists when it doesn't. See docs/DECISIONS.md, "MCP
// build-before-test CI ordering."
describe("built stdio server (dist/cli.js) — real child-process protocol round trip", () => {
  if (!DIST_CLI_EXISTS && IS_GITHUB_ACTIONS) {
    it("fails loudly: dist/cli.js is missing in a GitHub Actions run", () => {
      throw new Error(
        "dist/cli.js does not exist in this GitHub Actions run. CI must run " +
          '"npm run build --workspace @missionthread/mcp-server" before ' +
          '"npm run test:mcp" — otherwise this suite silently proves nothing ' +
          "about the actual built stdio server. See .github/workflows/ci.yml " +
          'and this file\'s "MCP server tests" step ordering.',
      );
    });
    return;
  }

  it.skipIf(!DIST_CLI_EXISTS)(
    "initializes, lists exactly six tools, and calls get_program_summary through the real built executable",
    async () => {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      );
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [DIST_CLI],
        env,
        stderr: "pipe",
      });
      const client = new Client({ name: "built-cli-protocol-test", version: "0.0.1" });

      const run = async () => {
        await client.connect(transport);
        expect(client.getServerVersion()?.name).toBe("missionthread-ai");

        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name).sort()).toEqual(
          [
            "get_budget_variance",
            "get_program_summary",
            "get_requirement",
            "get_risk_register",
            "get_schedule_dependencies",
            "list_failed_tests",
          ].sort(),
        );

        const result = await client.callTool({
          name: "get_program_summary",
          arguments: { programId: PROGRAM_ID },
        });
        expect(result.isError).toBeFalsy();
        const content = result.content as Array<{ type: string; text: string }>;
        const data = JSON.parse(content[0]!.text);
        expect(data.programId).toBe(PROGRAM_ID);
      };

      await Promise.race([
        run(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("built stdio protocol test timed out")), 8000),
        ),
      ]);

      await client.close();
      await transport.close();
    },
    15_000,
  );
});
