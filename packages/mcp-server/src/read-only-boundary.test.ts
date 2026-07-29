import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PROGRAM_ID } from "@missionthread/core";
import { createMissionThreadMcpServer } from "./server.js";

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

const SOURCE_FILES = [
  "index.ts",
  "stdio-server.ts",
  "cli.ts",
  "server.ts",
  "tool-result.ts",
  "tools/get-program-summary.ts",
  "tools/get-requirement.ts",
  "tools/get-schedule-dependencies.ts",
  "tools/list-failed-tests.ts",
  "tools/get-budget-variance.ts",
  "tools/get-risk-register.ts",
].map((relativePath) => ({
  relativePath,
  content: readFileSync(path.join(SRC_DIR, relativePath), "utf8"),
}));

describe("read-only boundary — static source checks", () => {
  it("no source file executes arbitrary/raw SQL", () => {
    for (const file of SOURCE_FILES) {
      expect(file.content).not.toMatch(/\$queryRaw|\$executeRaw/);
    }
  });

  it("no source file uses a shell or filesystem tool", () => {
    for (const file of SOURCE_FILES) {
      expect(file.content).not.toMatch(/child_process|exec\(|execSync|spawn\(/);
      expect(file.content).not.toMatch(
        /from ["']node:fs["']|from ["']fs["']|require\(["']fs["']\)/,
      );
    }
  });

  it("no source file imports a mutation function from @missionthread/core", () => {
    for (const file of SOURCE_FILES) {
      expect(file.content).not.toMatch(
        /recordProgramEvent|recordMitigationDecision|applyApprovedChanges/,
      );
    }
  });

  it("no source file imports the AI provider or reads provider credentials", () => {
    for (const file of SOURCE_FILES) {
      expect(file.content).not.toMatch(/from ["']openai["']|from ["'].*\/ai["']|OPENAI_API_KEY/);
    }
  });

  it("no source file logs to stdout (console.log) — stdout is reserved for the MCP protocol", () => {
    for (const file of SOURCE_FILES) {
      expect(file.content).not.toMatch(/console\.log\(/);
    }
  });

  it("no tool description embeds a hidden instruction (checked directly against source text)", () => {
    const toolFiles = SOURCE_FILES.filter((f) => f.relativePath.startsWith("tools/"));
    expect(toolFiles.length).toBe(6);
    for (const file of toolFiles) {
      const match = file.content.match(/description:\s*\n?\s*"([^"]+)"/);
      expect(match).not.toBeNull();
      const description = (match?.[1] ?? "").toLowerCase();
      for (const phrase of ["ignore previous", "you must", "system prompt", "disregard"]) {
        expect(description).not.toContain(phrase);
      }
    }
  });
});

describe("read-only boundary — runtime checks", () => {
  it("exactly six tools are registered — no write tool exists", async () => {
    const server = createMissionThreadMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "boundary-test", version: "0.0.1" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(6);
      for (const tool of tools) {
        expect(tool.name).toMatch(/^get_|^list_/);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("tool output is escaped JSON text, never HTML", async () => {
    const server = createMissionThreadMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "boundary-test", version: "0.0.1" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const result = await client.callTool({
        name: "get_program_summary",
        arguments: { programId: PROGRAM_ID },
      });
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]!.type).toBe("text");
      expect(content[0]!.text).not.toMatch(/<html|<script/i);
      expect(() => JSON.parse(content[0]!.text)).not.toThrow();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
