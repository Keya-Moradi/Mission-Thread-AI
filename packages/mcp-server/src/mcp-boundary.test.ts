import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MCP_LIMITS, PROGRAM_ID } from "@missionthread/core";
import { createMissionThreadMcpServer } from "./server.js";
import { MCP_OUTPUT_BYTE_LIMIT } from "./tool-result.js";

async function connectedClient(): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createMissionThreadMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "boundary-test", version: "0.0.1" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content[0]!.text;
}

describe("MCP end-to-end input/output bounds (correction pass §3)", () => {
  it("[one-million-character ID] a call with a 1,000,000-character requested ID fails before any database query, with a small safe error", async () => {
    const overlongId = "R".repeat(1_000_000);
    const { client, close } = await connectedClient();
    try {
      const result = await client.callTool({
        name: "get_requirement",
        arguments: { requirementId: overlongId },
      });
      expect(result.isError).toBe(true);
      const text = textOf(result);
      expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MCP_OUTPUT_BYTE_LIMIT);
      // The oversized ID must appear nowhere in the result.
      expect(text).not.toContain(overlongId);
      expect(text).not.toContain("R".repeat(200));
      expect(text.length).toBeLessThan(1000);
    } finally {
      await close();
    }
  });

  it("[exactly at the ceiling] an ID of exactly MCP_LIMITS.maxIdLength characters is accepted (rejected only strictly above it)", async () => {
    const exactLengthId = "M".repeat(MCP_LIMITS.maxIdLength);
    const { client, close } = await connectedClient();
    try {
      const result = await client.callTool({
        name: "get_requirement",
        arguments: { requirementId: exactLengthId },
      });
      // Not found (this ID doesn't exist) rather than a validation error —
      // proves the length bound itself did not reject a valid-length ID.
      expect(result.isError).toBe(true);
      expect(textOf(result)).not.toMatch(/exceeds the maximum permitted length/);
    } finally {
      await close();
    }
  });

  it("[one over the ceiling] MCP_LIMITS.maxIdLength + 1 characters is rejected as a validation error", async () => {
    const tooLongId = "M".repeat(MCP_LIMITS.maxIdLength + 1);
    const { client, close } = await connectedClient();
    try {
      const result = await client.callTool({
        name: "get_requirement",
        arguments: { requirementId: tooLongId },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/exceeds the maximum permitted length/);
    } finally {
      await close();
    }
  });

  it("[padded ID still rejected] whitespace-padding is rejected exactly as it is everywhere else in this repo", async () => {
    const { client, close } = await connectedClient();
    try {
      const result = await client.callTool({
        name: "get_program_summary",
        arguments: { programId: ` ${PROGRAM_ID} ` },
      });
      expect(result.isError).toBe(true);
    } finally {
      await close();
    }
  });

  it("[empty ID rejected] an empty or whitespace-only ID is rejected", async () => {
    const { client, close } = await connectedClient();
    try {
      const emptyResult = await client.callTool({
        name: "get_program_summary",
        arguments: { programId: "" },
      });
      expect(emptyResult.isError).toBe(true);

      const whitespaceResult = await client.callTool({
        name: "get_program_summary",
        arguments: { programId: "   " },
      });
      expect(whitespaceResult.isError).toBe(true);
    } finally {
      await close();
    }
  });

  it("[database-derived free text bounded] normal seeded output is unchanged by the new bounding (text is well under maxTextLength already)", async () => {
    const { client, close } = await connectedClient();
    try {
      const result = await client.callTool({
        name: "get_program_summary",
        arguments: { programId: PROGRAM_ID },
      });
      const data = JSON.parse(textOf(result));
      expect(data.name).toBe("EdgeLink-X");
      expect(data.name.length).toBeLessThanOrEqual(MCP_LIMITS.maxTextLength);
      expect(data.description.length).toBeLessThanOrEqual(MCP_LIMITS.maxTextLength);
    } finally {
      await close();
    }
  });
});
