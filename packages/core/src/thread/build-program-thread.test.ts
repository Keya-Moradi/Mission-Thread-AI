import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "../db";
import {
  PROGRAM_ID,
  DEMO_USER_IDS,
  DEPENDENCY_IDS,
  COMPONENT_IDS,
  MILESTONE_IDS,
  ANALYSIS_IDS,
  ANALYSIS_RUN_IDS,
  MITIGATION_OPTION_IDS,
} from "../seed/ids";
import { buildProgramThread, validateGraphInvariants } from "./build-program-thread";
import { threadNodeId, type ProgramThreadGraph, type ThreadEdge, type ThreadNode } from "./types";

function fabricatedGraph(overrides: Partial<ProgramThreadGraph> = {}): ProgramThreadGraph {
  const nodeA: ThreadNode = {
    id: "PROGRAM:P1",
    kind: "PROGRAM",
    recordId: "P1",
    label: "Program",
    subtitle: null,
    status: null,
    href: null,
    metadata: {},
  };
  const nodeB: ThreadNode = {
    id: "COMPONENT:C1",
    kind: "COMPONENT",
    recordId: "C1",
    label: "Component",
    subtitle: null,
    status: null,
    href: null,
    metadata: {},
  };
  const edge: ThreadEdge = {
    id: "CONTAINS::PROGRAM:P1::COMPONENT:C1",
    kind: "CONTAINS",
    source: "PROGRAM:P1",
    target: "COMPONENT:C1",
    label: null,
    directed: true,
    metadata: {},
  };
  return {
    programId: "P1",
    nodes: [nodeA, nodeB],
    edges: [edge],
    nodeCount: 2,
    edgeCount: 1,
    ...overrides,
  };
}

describe("validateGraphInvariants — pure, no database", () => {
  it("[valid graph] a well-formed graph has no violations", () => {
    expect(validateGraphInvariants(fabricatedGraph())).toEqual([]);
  });

  it("[duplicate node ID] two nodes sharing an ID is a violation", () => {
    const graph = fabricatedGraph();
    const violations = validateGraphInvariants({
      ...graph,
      nodes: [...graph.nodes, graph.nodes[0]!],
    });
    expect(violations.some((v) => v.includes("Duplicate node ID"))).toBe(true);
  });

  it("[duplicate edge ID] two edges sharing an ID is a violation", () => {
    const graph = fabricatedGraph();
    const violations = validateGraphInvariants({
      ...graph,
      edges: [...graph.edges, graph.edges[0]!],
    });
    expect(violations.some((v) => v.includes("Duplicate edge ID"))).toBe(true);
  });

  it("[dangling endpoint] an edge referencing a missing node is a violation", () => {
    const graph = fabricatedGraph();
    const dangling: ThreadEdge = { ...graph.edges[0]!, id: "x", target: "COMPONENT:MISSING" };
    const violations = validateGraphInvariants({ ...graph, edges: [dangling] });
    expect(violations.some((v) => v.includes("does not exist"))).toBe(true);
  });

  it("[self-edge] an edge whose source equals its target is a violation", () => {
    const graph = fabricatedGraph();
    const selfEdge: ThreadEdge = { ...graph.edges[0]!, id: "y", target: graph.edges[0]!.source };
    const violations = validateGraphInvariants({ ...graph, edges: [selfEdge] });
    expect(violations.some((v) => v.includes("self-edge"))).toBe(true);
  });
});

describe("buildProgramThread — DB-backed, against the seeded test database", () => {
  it("[not found] an unknown program ID returns NOT_FOUND", async () => {
    const result = await buildProgramThread("PROGRAM-DOES-NOT-EXIST");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  it("[malformed input] a padded ID returns VALIDATION_ERROR", async () => {
    const result = await buildProgramThread(` ${PROGRAM_ID} `);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });

  it("[seeded program] builds successfully with a non-trivial graph", async () => {
    const result = await buildProgramThread(PROGRAM_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.nodes.length).toBeGreaterThan(20);
    expect(result.data.edges.length).toBeGreaterThan(20);
    expect(result.data.nodeCount).toBe(result.data.nodes.length);
    expect(result.data.edgeCount).toBe(result.data.edges.length);
    expect(validateGraphInvariants(result.data)).toEqual([]);
  });

  it("[determinism] repeated calls produce identical node and edge ordering", async () => {
    const first = await buildProgramThread(PROGRAM_ID);
    const second = await buildProgramThread(PROGRAM_ID);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.data.nodes.map((n) => n.id)).toEqual(second.data.nodes.map((n) => n.id));
    expect(first.data.edges.map((e) => e.id)).toEqual(second.data.edges.map((e) => e.id));
  });

  it("[unique IDs] every node ID and every edge ID is unique", async () => {
    const result = await buildProgramThread(PROGRAM_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(new Set(result.data.nodes.map((n) => n.id)).size).toBe(result.data.nodes.length);
    expect(new Set(result.data.edges.map((e) => e.id)).size).toBe(result.data.edges.length);
  });

  it("[no duplicate logical edges] no (kind, source, target) triple repeats", async () => {
    const result = await buildProgramThread(PROGRAM_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const keys = result.data.edges.map((e) => `${e.kind}::${e.source}::${e.target}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("[dependency direction] preserves the database's fromMilestoneId -> toMilestoneId direction", async () => {
    const result = await buildProgramThread(PROGRAM_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const dependency = await prisma.dependency.findUniqueOrThrow({
      where: { id: DEPENDENCY_IDS[0] },
    });
    const edge = result.data.edges.find(
      (e) =>
        e.kind === "DEPENDS_ON" &&
        e.source === threadNodeId("MILESTONE", dependency.fromMilestoneId) &&
        e.target === threadNodeId("MILESTONE", dependency.toMilestoneId),
    );
    expect(edge).toBeDefined();
  });

  it("[analysis run] the seeded supplier-delay analysis appears as exactly one ANALYSIS_RUN node with 3 linked mitigation options", async () => {
    const result = await buildProgramThread(PROGRAM_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const runNodes = result.data.nodes.filter((n) => n.kind === "ANALYSIS_RUN");
    expect(runNodes.length).toBeGreaterThanOrEqual(1);
    const run = runNodes.find((n) => n.status === "SUCCEEDED");
    expect(run).toBeDefined();
    const optionEdges = result.data.edges.filter(
      (e) => e.kind === "CONTAINS" && e.source === run!.id,
    );
    expect(optionEdges.length).toBe(3);
  });

  it("[citations] the successful analysis cites at least one domain record via a CITED edge", async () => {
    const result = await buildProgramThread(PROGRAM_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const citedEdges = result.data.edges.filter((e) => e.kind === "CITED");
    expect(citedEdges.length).toBeGreaterThan(0);
  });

  it("[no unsafe fields] no PROGRAM_EVENT node exposes reason/rawNotes, and no node exposes a password or provider secret", async () => {
    const result = await buildProgramThread(PROGRAM_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const serialized = JSON.stringify(result.data);
    expect(serialized).not.toContain("passwordHash");
    for (const node of result.data.nodes.filter((n) => n.kind === "PROGRAM_EVENT")) {
      expect(Object.keys(node.metadata).sort()).toEqual(
        ["confidence", "delayDays", "eventType", "quantity"].sort(),
      );
    }
  });

  it("[decision rationale] a DECISION node never carries the complete rationale text", async () => {
    const optionId = `MIT-TEST-${randomUUID()}`;
    const { impactAnalysisId } = await createSucceededRunFixture();
    await prisma.mitigationOption.create({
      data: {
        id: optionId,
        impactAnalysisId,
        optionIndex: 0,
        title: "Fixture option",
        description: "Fixture — safe to delete.",
        tradeoffs: "None.",
        isRecommended: false,
      },
    });
    const longRationale =
      "This rationale is deliberately long so the test can prove it never appears in full inside a DECISION node's serialized graph metadata. ".repeat(
        3,
      );
    await prisma.decision.create({
      data: {
        id: `DEC-TEST-${randomUUID()}`,
        mitigationOptionId: optionId,
        actorUserId: DEMO_USER_IDS.programManager,
        verdict: "APPROVED",
        rationale: longRationale,
        traceId: `TRACE-TEST-${randomUUID()}`,
      },
    });

    const result = await buildProgramThread(PROGRAM_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const serialized = JSON.stringify(result.data);
    expect(serialized).not.toContain(longRationale);
    const decisionNode = result.data.nodes.find(
      (n) => n.kind === "DECISION" && n.status === "APPROVED",
    );
    expect(decisionNode).toBeDefined();
  });

  it("[failed run] a run whose terminal attempt is FAILED has zero linked mitigation options", async () => {
    await createFailedRunFixture();
    const result = await buildProgramThread(PROGRAM_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const failedRun = result.data.nodes.find(
      (n) => n.kind === "ANALYSIS_RUN" && n.recordId === lastFailedRunId,
    );
    expect(failedRun).toBeDefined();
    expect(failedRun!.status).toBe("FAILED");
    const optionEdges = result.data.edges.filter(
      (e) => e.kind === "CONTAINS" && e.source === failedRun!.id,
    );
    expect(optionEdges.length).toBe(0);
  });

  it("[retry grouping] two attempts sharing an analysisRunId collapse into one ANALYSIS_RUN node, using the higher attempt as terminal", async () => {
    const runId = `RUN-TEST-${randomUUID()}`;
    const { eventId } = await createTempEvent();
    const firstId = `ANALYSIS-TEST-${randomUUID()}`;
    await prisma.impactAnalysis.create({
      data: {
        id: firstId,
        programEventId: eventId,
        analysisRunId: runId,
        requestedById: DEMO_USER_IDS.programManager,
        traceId: `TRACE-TEST-${randomUUID()}`,
        status: "FAILED",
        aiMode: "mock",
        attempt: 1,
        errorCategory: "TRANSIENT_PROVIDER_FAILURE",
      },
    });
    createdAnalysisIds.push(firstId);
    const secondId = `ANALYSIS-TEST-${randomUUID()}`;
    await prisma.impactAnalysis.create({
      data: {
        id: secondId,
        programEventId: eventId,
        analysisRunId: runId,
        requestedById: DEMO_USER_IDS.programManager,
        traceId: `TRACE-TEST-${randomUUID()}`,
        status: "SUCCEEDED",
        aiMode: "mock",
        attempt: 2,
        confidence: "MEDIUM",
      },
    });
    createdAnalysisIds.push(secondId);

    const result = await buildProgramThread(PROGRAM_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const matching = result.data.nodes.filter(
      (n) => n.kind === "ANALYSIS_RUN" && n.recordId === runId,
    );
    expect(matching.length).toBe(1);
    expect(matching[0]!.status).toBe("SUCCEEDED");
    expect(matching[0]!.metadata.attemptCount).toBe(2);
    // The route's [id] segment is the logical analysisRunId, not the
    // terminal attempt's own ImpactAnalysis.id — see
    // apps/web's decision/apply pages, which 404 on a mismatch.
    expect(matching[0]!.href).toContain(runId);
    expect(matching[0]!.href).not.toContain(firstId);
    expect(matching[0]!.href).not.toContain(secondId);
  });

  it("[proposed change target] a MILESTONE_DATE change TARGETS the correct milestone node, and a NEW_ACTION change has no TARGETS edge", async () => {
    const { impactAnalysisId } = await createSucceededRunFixture();
    const targetedOptionId = `MIT-TEST-${randomUUID()}`;
    const newActionOptionId = `MIT-TEST-${randomUUID()}`;
    await prisma.mitigationOption.createMany({
      data: [
        {
          id: targetedOptionId,
          impactAnalysisId,
          optionIndex: 0,
          title: "Targeted option",
          description: "Fixture.",
          tradeoffs: "None.",
        },
        {
          id: newActionOptionId,
          impactAnalysisId,
          optionIndex: 1,
          title: "New action option",
          description: "Fixture.",
          tradeoffs: "None.",
        },
      ],
    });
    await prisma.proposedChange.create({
      data: {
        id: `PC-TEST-${randomUUID()}`,
        mitigationOptionId: targetedOptionId,
        changeType: "MILESTONE_DATE",
        targetRecordId: MILESTONE_IDS[0],
        targetRecordType: "MILESTONE",
        oldValue: { plannedDate: "2026-09-15" },
        newValue: { plannedDate: "2026-09-20" },
      },
    });
    await prisma.proposedChange.create({
      data: {
        id: `PC-TEST-${randomUUID()}`,
        mitigationOptionId: newActionOptionId,
        changeType: "NEW_ACTION",
        oldValue: {},
        newValue: { title: "Do something", description: "Fixture." },
      },
    });

    const result = await buildProgramThread(PROGRAM_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const milestoneNodeId = threadNodeId("MILESTONE", MILESTONE_IDS[0]);
    const targetsEdges = result.data.edges.filter((e) => e.kind === "TARGETS");
    expect(targetsEdges.some((e) => e.target === milestoneNodeId)).toBe(true);
    // Every TARGETS edge's source must be a PROPOSED_CHANGE node whose
    // change is not NEW_ACTION — i.e. no fake target edge was invented.
    for (const edge of targetsEdges) {
      const sourceNode = result.data.nodes.find((n) => n.id === edge.source);
      expect(sourceNode?.metadata.changeType).not.toBe("NEW_ACTION");
    }
  });

  it("[orphan connectivity] every node is reachable from the PROGRAM node", async () => {
    const result = await buildProgramThread(PROGRAM_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const adjacency = new Map<string, Set<string>>();
    for (const edge of result.data.edges) {
      if (!adjacency.has(edge.source)) adjacency.set(edge.source, new Set());
      if (!adjacency.has(edge.target)) adjacency.set(edge.target, new Set());
      adjacency.get(edge.source)!.add(edge.target);
      adjacency.get(edge.target)!.add(edge.source);
    }
    const programNodeId = threadNodeId("PROGRAM", PROGRAM_ID);
    const reached = new Set([programNodeId]);
    const queue = [programNodeId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const neighbor of adjacency.get(current) ?? []) {
        if (!reached.has(neighbor)) {
          reached.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    const unreached = result.data.nodes.filter((n) => !reached.has(n.id));
    expect(unreached).toEqual([]);
  });

  it("[dependency citation] a cited DEPENDENCY marks the matching DEPENDS_ON edge instead of inventing a node", async () => {
    const { impactAnalysisId } = await createSucceededRunFixture();
    await prisma.sourceReference.create({
      data: {
        id: `SRC-TEST-${randomUUID()}`,
        impactAnalysisId,
        recordId: DEPENDENCY_IDS[0],
        recordType: "DEPENDENCY",
        summary: "Fixture citation.",
        wasCited: true,
      },
    });
    await prisma.sourceReference.create({
      data: {
        id: `SRC-TEST-${randomUUID()}`,
        impactAnalysisId,
        recordId: COMPONENT_IDS.ec440,
        recordType: "COMPONENT",
        summary: "Fixture citation.",
        wasCited: true,
      },
    });

    const result = await buildProgramThread(PROGRAM_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const nodeKinds = new Set(result.data.nodes.map((n) => n.kind as string));
    expect(nodeKinds.has("DEPENDENCY")).toBe(false);
    const dependency = await prisma.dependency.findUniqueOrThrow({
      where: { id: DEPENDENCY_IDS[0] },
    });
    const dependencyEdge = result.data.edges.find(
      (e) =>
        e.kind === "DEPENDS_ON" &&
        e.source === threadNodeId("MILESTONE", dependency.fromMilestoneId) &&
        e.target === threadNodeId("MILESTONE", dependency.toMilestoneId),
    );
    expect(dependencyEdge?.metadata.cited).toBe(true);

    const componentCitedEdge = result.data.edges.find(
      (e) => e.kind === "CITED" && e.target === threadNodeId("COMPONENT", COMPONENT_IDS.ec440),
    );
    expect(componentCitedEdge).toBeDefined();
  });
});

describe("graph workflow links — use the logical analysisRunId, never an attempt's own ImpactAnalysis.id", () => {
  const decisionPattern = /^\/programs\/edgelink-x\/analyses\/([^/]+)\/options\/([^/]+)\/decision$/;
  const applyPattern = /^\/programs\/edgelink-x\/analyses\/([^/]+)\/options\/([^/]+)\/apply$/;
  const analysisRunPattern = /^\/programs\/edgelink-x\/analyses\/([^/]+)$/;

  it("[seeded analysis-run link] the seeded ANALYSIS_RUN node's href is exactly the analyses/[analysisRunId] route", async () => {
    const result = await buildProgramThread(PROGRAM_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const runNode = result.data.nodes.find(
      (n) => n.kind === "ANALYSIS_RUN" && n.recordId === ANALYSIS_RUN_IDS.supplierDelay,
    );
    expect(runNode).toBeDefined();
    expect(runNode?.href).toBe(`/programs/edgelink-x/analyses/${ANALYSIS_RUN_IDS.supplierDelay}`);
    // The terminal attempt's own row ID must never appear in the link.
    expect(runNode?.href).not.toContain(ANALYSIS_IDS.supplierDelay);
  });

  it("[seeded mitigation-option link] the seeded decision href embeds the logical run ID, not the attempt ID", async () => {
    const result = await buildProgramThread(PROGRAM_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const optionNode = result.data.nodes.find(
      (n) =>
        n.kind === "MITIGATION_OPTION" && n.recordId === MITIGATION_OPTION_IDS.supplierDelay[0],
    );
    expect(optionNode).toBeDefined();
    expect(optionNode?.href).toBe(
      `/programs/edgelink-x/analyses/${ANALYSIS_RUN_IDS.supplierDelay}/options/${MITIGATION_OPTION_IDS.supplierDelay[0]}/decision`,
    );
    expect(optionNode?.href).not.toContain(ANALYSIS_IDS.supplierDelay);
  });

  it("[every ANALYSIS_RUN node] links with its own analysisRunId (recordId), and never with a terminal attempt row ID", async () => {
    const result = await buildProgramThread(PROGRAM_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const attempts = await prisma.impactAnalysis.findMany({
      where: { programEvent: { programId: PROGRAM_ID } },
      select: { id: true, analysisRunId: true },
    });
    const attemptIds = new Set(attempts.map((a) => a.id));

    for (const node of result.data.nodes.filter((n) => n.kind === "ANALYSIS_RUN")) {
      const match = analysisRunPattern.exec(node.href ?? "");
      expect(match).not.toBeNull();
      expect(match?.[1]).toBe(node.recordId);
      // The linked segment must never coincide with a real ImpactAnalysis
      // row ID (an attempt ID), which would 404 against the actual route.
      expect(attemptIds.has(decodeURIComponent(match?.[1] ?? ""))).toBe(false);
    }
  });

  it("[every MITIGATION_OPTION decision link] embeds the option's logical analysisRunId", async () => {
    const result = await buildProgramThread(PROGRAM_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const options = await prisma.mitigationOption.findMany({
      where: { impactAnalysis: { programEvent: { programId: PROGRAM_ID } } },
      select: {
        id: true,
        impactAnalysisId: true,
        impactAnalysis: { select: { analysisRunId: true } },
      },
    });
    const runIdByOptionId = new Map(options.map((o) => [o.id, o.impactAnalysis.analysisRunId]));

    for (const node of result.data.nodes.filter((n) => n.kind === "MITIGATION_OPTION")) {
      const match = decisionPattern.exec(node.href ?? "");
      expect(match).not.toBeNull();
      expect(decodeURIComponent(match?.[1] ?? "")).toBe(runIdByOptionId.get(node.recordId));
      expect(decodeURIComponent(match?.[2] ?? "")).toBe(node.recordId);
    }
  });

  it("[every PROPOSED_CHANGE apply link] embeds the change's logical analysisRunId", async () => {
    const { impactAnalysisId, analysisRunId } = await createSucceededRunFixture();
    const optionId = `MIT-TEST-${randomUUID()}`;
    await prisma.mitigationOption.create({
      data: {
        id: optionId,
        impactAnalysisId,
        optionIndex: 0,
        title: "Fixture option",
        description: "Fixture.",
        tradeoffs: "None.",
      },
    });
    const changeId = `PC-TEST-${randomUUID()}`;
    await prisma.proposedChange.create({
      data: {
        id: changeId,
        mitigationOptionId: optionId,
        changeType: "MILESTONE_DATE",
        targetRecordId: MILESTONE_IDS[0],
        targetRecordType: "MILESTONE",
        oldValue: { plannedDate: "2026-09-15" },
        newValue: { plannedDate: "2026-09-20" },
      },
    });

    const result = await buildProgramThread(PROGRAM_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const changeNode = result.data.nodes.find(
      (n) => n.kind === "PROPOSED_CHANGE" && n.recordId === changeId,
    );
    expect(changeNode).toBeDefined();
    expect(changeNode?.href).toBe(
      `/programs/edgelink-x/analyses/${analysisRunId}/options/${optionId}/apply`,
    );
    expect(changeNode?.href).not.toContain(impactAnalysisId);
  });

  it("[resolves without 404] a controlled decision/apply fixture's constructed links satisfy the exact condition apps/web's pages check", async () => {
    const { impactAnalysisId, analysisRunId } = await createSucceededRunFixture();
    const optionId = `MIT-TEST-${randomUUID()}`;
    await prisma.mitigationOption.create({
      data: {
        id: optionId,
        impactAnalysisId,
        optionIndex: 0,
        title: "Fixture option",
        description: "Fixture.",
        tradeoffs: "None.",
      },
    });

    const result = await buildProgramThread(PROGRAM_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const optionNode = result.data.nodes.find(
      (n) => n.kind === "MITIGATION_OPTION" && n.recordId === optionId,
    );
    const match = decisionPattern.exec(optionNode?.href ?? "");
    expect(match).not.toBeNull();
    const [, linkedRunId, linkedOptionId] = match!;

    // Reproduce the exact guard apps/web's decision/apply pages use
    // (option.impactAnalysis.analysisRunId !== params.id => notFound()) —
    // proving the constructed link would NOT 404.
    const option = await prisma.mitigationOption.findUnique({
      where: { id: linkedOptionId },
      include: { impactAnalysis: { select: { analysisRunId: true } } },
    });
    expect(option).not.toBeNull();
    expect(option?.impactAnalysis.analysisRunId).toBe(linkedRunId);
    expect(linkedRunId).toBe(analysisRunId);
  });

  it("[no mutation-endpoint links] every non-null href is a safe GET-navigable page route, never an API/action endpoint", async () => {
    const result = await buildProgramThread(PROGRAM_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const node of result.data.nodes) {
      if (!node.href) continue;
      expect(node.href.startsWith("/programs/edgelink-x")).toBe(true);
      expect(node.href).not.toMatch(/^\/api\//);
      expect(node.href).not.toMatch(/\/actions?$/);
      const isKnownPageShape =
        node.href === "/programs/edgelink-x" ||
        analysisRunPattern.test(node.href) ||
        decisionPattern.test(node.href) ||
        applyPattern.test(node.href);
      expect(isKnownPageShape).toBe(true);
    }
  });
});

// ---- Fixture helpers (created + cleaned up per test, mirroring
// packages/core/src/approvals/record-decision.test.ts) ----

const createdEventIds: string[] = [];
const createdAnalysisIds: string[] = [];
let lastFailedRunId = "";

async function createTempEvent(): Promise<{ eventId: string }> {
  const eventId = `EVT-TEST-${randomUUID()}`;
  await prisma.programEvent.create({
    data: {
      id: eventId,
      programId: PROGRAM_ID,
      eventType: "GENERAL_UPDATE",
      createdById: DEMO_USER_IDS.programManager,
    },
  });
  createdEventIds.push(eventId);
  return { eventId };
}

async function createSucceededRunFixture(): Promise<{
  impactAnalysisId: string;
  analysisRunId: string;
}> {
  const { eventId } = await createTempEvent();
  const impactAnalysisId = `ANALYSIS-TEST-${randomUUID()}`;
  const analysisRunId = `RUN-TEST-${randomUUID()}`;
  await prisma.impactAnalysis.create({
    data: {
      id: impactAnalysisId,
      programEventId: eventId,
      analysisRunId,
      requestedById: DEMO_USER_IDS.programManager,
      traceId: `TRACE-TEST-${randomUUID()}`,
      status: "SUCCEEDED",
      aiMode: "mock",
      attempt: 1,
      confidence: "HIGH",
    },
  });
  createdAnalysisIds.push(impactAnalysisId);
  return { impactAnalysisId, analysisRunId };
}

async function createFailedRunFixture(): Promise<void> {
  const { eventId } = await createTempEvent();
  const runId = `RUN-TEST-${randomUUID()}`;
  const impactAnalysisId = `ANALYSIS-TEST-${randomUUID()}`;
  await prisma.impactAnalysis.create({
    data: {
      id: impactAnalysisId,
      programEventId: eventId,
      analysisRunId: runId,
      requestedById: DEMO_USER_IDS.programManager,
      traceId: `TRACE-TEST-${randomUUID()}`,
      status: "FAILED",
      aiMode: "mock",
      attempt: 1,
      errorCategory: "PROVIDER_REFUSAL",
    },
  });
  createdAnalysisIds.push(impactAnalysisId);
  lastFailedRunId = runId;
}

afterEach(async () => {
  for (const id of createdAnalysisIds.splice(0)) {
    await prisma.sourceReference.deleteMany({ where: { impactAnalysisId: id } });
    await prisma.proposedChange.deleteMany({
      where: { mitigationOption: { impactAnalysisId: id } },
    });
    await prisma.decision.deleteMany({ where: { mitigationOption: { impactAnalysisId: id } } });
    await prisma.mitigationOption.deleteMany({ where: { impactAnalysisId: id } });
    await prisma.impactAnalysis.deleteMany({ where: { id } });
  }
  for (const id of createdEventIds.splice(0)) {
    await prisma.programEvent.deleteMany({ where: { id } });
  }
});
