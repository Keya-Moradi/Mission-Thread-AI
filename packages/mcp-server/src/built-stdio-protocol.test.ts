import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PROGRAM_ID } from "@missionthread/core";

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST_CLI = path.join(PACKAGE_DIR, "dist", "cli.js");

// Complements server.test.ts's InMemoryTransport protocol test (which
// exercises the McpServer object directly) by driving the *actual built
// executable* — dist/cli.js, spawned as a real child process over real
// stdio — through the same round trip. Skipped cleanly (not failed) when
// dist/ hasn't been built yet, so the ordinary `npm run test`/`test:mcp`
// command never requires a prior build; run
// `npm run build --workspace @missionthread/mcp-server` first for full
// coverage, e.g. during quality-gate verification.
describe("built stdio server (dist/cli.js) — real child-process protocol round trip", () => {
  it("initializes, lists exactly six tools, and calls get_program_summary through the real built executable", async () => {
    if (!existsSync(DIST_CLI)) {
      return;
    }

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
  }, 15_000);
});
