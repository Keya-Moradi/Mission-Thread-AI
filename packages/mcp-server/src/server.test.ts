import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  prisma,
  PROGRAM_ID,
  REQUIREMENT_IDS,
  MILESTONE_IDS,
  calculateRiskScore,
} from "@missionthread/core";
import { createMissionThreadMcpServer } from "./server.js";

const EXPECTED_TOOL_NAMES = [
  "get_program_summary",
  "get_requirement",
  "get_schedule_dependencies",
  "list_failed_tests",
  "get_budget_variance",
  "get_risk_register",
];

async function connectedClient(): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createMissionThreadMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.1" });
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
  expect(content).toHaveLength(1);
  expect(content[0]!.type).toBe("text");
  return content[0]!.text;
}

describe("createMissionThreadMcpServer — tool registration", () => {
  it("[exact tool set] registers exactly the six tools named in SPEC.md §15, no more, no fewer", async () => {
    const { client, close } = await connectedClient();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
    } finally {
      await close();
    }
  });

  it("[read-only annotations] every tool is annotated readOnlyHint:true, destructiveHint:false", async () => {
    const { client, close } = await connectedClient();
    try {
      const { tools } = await client.listTools();
      for (const tool of tools) {
        expect(tool.annotations?.readOnlyHint).toBe(true);
        expect(tool.annotations?.destructiveHint).toBe(false);
      }
    } finally {
      await close();
    }
  });

  it("[factual descriptions] no tool description embeds an instruction or directive phrase", async () => {
    const { client, close } = await connectedClient();
    try {
      const { tools } = await client.listTools();
      const suspiciousPhrases = [
        "ignore previous",
        "ignore all previous",
        "you must",
        "disregard",
        "system prompt",
        "act as",
      ];
      for (const tool of tools) {
        const description = (tool.description ?? "").toLowerCase();
        expect(description.length).toBeLessThan(400);
        for (const phrase of suspiciousPhrases) {
          expect(description).not.toContain(phrase);
        }
      }
    } finally {
      await close();
    }
  });
});

describe("MCP tools — unknown fields and malformed IDs", () => {
  it("[unknown field] rejects a call with an extra input field before it reaches the handler", async () => {
    const { client, close } = await connectedClient();
    try {
      const result = await client.callTool({
        name: "get_program_summary",
        arguments: { programId: PROGRAM_ID, extra: "nope" },
      });
      expect(result.isError).toBe(true);
    } finally {
      await close();
    }
  });

  it("[padded ID] rejects a padded requirement ID as a safe error, not a thrown exception", async () => {
    const { client, close } = await connectedClient();
    try {
      const result = await client.callTool({
        name: "get_requirement",
        arguments: { requirementId: ` ${REQUIREMENT_IDS[0]} ` },
      });
      expect(result.isError).toBe(true);
    } finally {
      await close();
    }
  });

  it("[missing entity] an unknown program ID returns a safe isError result, not a crash", async () => {
    const { client, close } = await connectedClient();
    try {
      const result = await client.callTool({
        name: "get_program_summary",
        arguments: { programId: "PROGRAM-DOES-NOT-EXIST" },
      });
      expect(result.isError).toBe(true);
      const text = textOf(result);
      expect(text).not.toContain("Prisma");
      expect(text).not.toContain("at ");
    } finally {
      await close();
    }
  });
});

describe("MCP tools — bounded, correct, deterministic output", () => {
  it("[get_program_summary] returns bounded valid JSON matching the deterministic readiness/budget services", async () => {
    const { client, close } = await connectedClient();
    try {
      const result = await client.callTool({
        name: "get_program_summary",
        arguments: { programId: PROGRAM_ID },
      });
      expect(result.isError).toBeFalsy();
      const data = JSON.parse(textOf(result));
      expect(data.counts.requirements).toBe(8);
      expect(data.budgetVariance.plannedTotal).toBe("964000.00");
      expect(data.readinessScore.totalScore).toBeGreaterThanOrEqual(0);
    } finally {
      await close();
    }
  });

  it("[get_requirement] returns complete linked-component and linked-test relationships", async () => {
    const { client, close } = await connectedClient();
    try {
      const result = await client.callTool({
        name: "get_requirement",
        arguments: { requirementId: REQUIREMENT_IDS[0] },
      });
      const data = JSON.parse(textOf(result));
      expect(data.linkedComponents.length).toBeGreaterThan(0);
      expect(data.linkedTests.length).toBeGreaterThan(0);
    } finally {
      await close();
    }
  });

  it("[get_schedule_dependencies] preserves direction and enforces the maxDepth ceiling", async () => {
    const { client, close } = await connectedClient();
    try {
      const withinBounds = await client.callTool({
        name: "get_schedule_dependencies",
        arguments: { milestoneId: MILESTONE_IDS[0], maxDepth: 3 },
      });
      const data = JSON.parse(textOf(withinBounds));
      expect(data.downstream.every((n: { depth: number }) => n.depth <= 3)).toBe(true);

      const overBounds = await client.callTool({
        name: "get_schedule_dependencies",
        arguments: { milestoneId: MILESTONE_IDS[0], maxDepth: 999 },
      });
      expect(overBounds.isError).toBe(true);
    } finally {
      await close();
    }
  });

  it("[list_failed_tests] excludes PASSED, BLOCKED, and NOT_RUN outcomes", async () => {
    const { client, close } = await connectedClient();
    try {
      const result = await client.callTool({
        name: "list_failed_tests",
        arguments: { programId: PROGRAM_ID },
      });
      const data = JSON.parse(textOf(result)) as Array<{ outcome: string }>;
      expect(data.length).toBeGreaterThan(0);
      expect(data.every((t) => t.outcome === "FAILED")).toBe(true);
    } finally {
      await close();
    }
  });

  it("[get_budget_variance] amounts are fixed-two-decimal strings", async () => {
    const { client, close } = await connectedClient();
    try {
      const result = await client.callTool({
        name: "get_budget_variance",
        arguments: { programId: PROGRAM_ID },
      });
      const data = JSON.parse(textOf(result));
      expect(data.plannedTotal).toMatch(/^\d+\.\d{2}$/);
      for (const item of data.itemSummaries) {
        expect(item.plannedAmount).toMatch(/^\d+\.\d{2}$/);
      }
    } finally {
      await close();
    }
  });

  it("[get_risk_register] scores match calculateRiskScore() exactly", async () => {
    const { client, close } = await connectedClient();
    try {
      const result = await client.callTool({
        name: "get_risk_register",
        arguments: { programId: PROGRAM_ID },
      });
      const data = JSON.parse(textOf(result)) as Array<{ riskId: string; score: number }>;
      for (const risk of data) {
        const expected = await calculateRiskScore(risk.riskId);
        expect(expected.ok).toBe(true);
        if (expected.ok) expect(risk.score).toBe(expected.data.score);
      }
    } finally {
      await close();
    }
  });
});

describe("MCP protocol — in-memory linked transport (§20 required protocol-level test)", () => {
  it("initializes, lists tools, and calls get_program_summary through a real MCP client/server pair, with no network request", async () => {
    const server = createMissionThreadMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "protocol-test-client", version: "0.0.1" });

    const run = async () => {
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      expect(client.getServerVersion()?.name).toBe("missionthread-ai");

      const { tools } = await client.listTools();
      expect(tools.length).toBe(6);

      const result = await client.callTool({
        name: "get_program_summary",
        arguments: { programId: PROGRAM_ID },
      });
      expect(result.isError).toBeFalsy();
      const data = JSON.parse(textOf(result));
      expect(data.programId).toBe(PROGRAM_ID);
    };

    await Promise.race([
      run(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("protocol test timed out")), 5000),
      ),
    ]);

    await client.close();
    await server.close();
  }, 10_000);
});

describe("Zero-mutation verification", () => {
  it("every tool call leaves database row counts unchanged", async () => {
    const before = await Promise.all([
      prisma.program.count(),
      prisma.requirement.count(),
      prisma.milestone.count(),
      prisma.risk.count(),
      prisma.testCase.count(),
      prisma.budgetItem.count(),
      prisma.decision.count(),
      prisma.proposedChange.count(),
      prisma.auditEvent.count(),
    ]);

    const { client, close } = await connectedClient();
    try {
      await client.callTool({ name: "get_program_summary", arguments: { programId: PROGRAM_ID } });
      await client.callTool({
        name: "get_requirement",
        arguments: { requirementId: REQUIREMENT_IDS[0] },
      });
      await client.callTool({
        name: "get_schedule_dependencies",
        arguments: { milestoneId: MILESTONE_IDS[0] },
      });
      await client.callTool({ name: "list_failed_tests", arguments: { programId: PROGRAM_ID } });
      await client.callTool({ name: "get_budget_variance", arguments: { programId: PROGRAM_ID } });
      await client.callTool({ name: "get_risk_register", arguments: { programId: PROGRAM_ID } });
    } finally {
      await close();
    }

    const after = await Promise.all([
      prisma.program.count(),
      prisma.requirement.count(),
      prisma.milestone.count(),
      prisma.risk.count(),
      prisma.testCase.count(),
      prisma.budgetItem.count(),
      prisma.decision.count(),
      prisma.proposedChange.count(),
      prisma.auditEvent.count(),
    ]);

    expect(after).toEqual(before);
  });
});

describe("Import-time side effects", () => {
  it("importing server.ts and calling createMissionThreadMcpServer() never connects a transport", async () => {
    const server = createMissionThreadMcpServer();
    expect(server.isConnected()).toBe(false);
  });
});
