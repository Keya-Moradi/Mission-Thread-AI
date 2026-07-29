import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { entityIdSchema } from "../analysis/schemas";
import { notFound, ok, validationError, type ServiceResult } from "../analysis/types";
import { computeRiskScore } from "../analysis/risk";
import { truncateText } from "../analysis/evidence";
import { EVIDENCE_RECORD_TYPES } from "../record-types";

type EvidenceRecordType = (typeof EVIDENCE_RECORD_TYPES)[number];
import {
  MAX_THREAD_EDGES,
  MAX_THREAD_LABEL_LENGTH,
  MAX_THREAD_METADATA_ENTRIES,
  MAX_THREAD_NODES,
  threadNodeId,
  type ProgramThreadGraph,
  type ThreadEdge,
  type ThreadEdgeKind,
  type ThreadMetadataValue,
  type ThreadNode,
  type ThreadNodeKind,
} from "./types";

const PROGRAM_HREF = "/programs/edgelink-x";

function label(text: string): string {
  return truncateText(text, MAX_THREAD_LABEL_LENGTH).text;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function money(amount: Prisma.Decimal | null | undefined): string | null {
  return amount ? amount.toFixed(2) : null;
}

/**
 * Maps a SourceReference/evidence record type to the thread node kind that
 * represents it. DEPENDENCY has no corresponding node (dependencies are
 * edges, not nodes — see §5) and is handled separately by the caller.
 */
function evidenceTypeToNodeKind(recordType: EvidenceRecordType): ThreadNodeKind | null {
  switch (recordType) {
    case "PROGRAM":
      return "PROGRAM";
    case "COMPONENT":
      return "COMPONENT";
    case "REQUIREMENT":
      return "REQUIREMENT";
    case "MILESTONE":
      return "MILESTONE";
    case "RISK":
      return "RISK";
    case "SUPPLIER":
      return "SUPPLIER";
    case "TEST_CASE":
      return "TEST_CASE";
    case "DEFECT":
      return "DEFECT";
    case "BUDGET_ITEM":
      return "BUDGET_ITEM";
    case "PROGRAM_EVENT":
      return "PROGRAM_EVENT";
    case "DEPENDENCY":
      return null;
  }
}

class GraphBuilder {
  private readonly nodes = new Map<string, ThreadNode>();
  private readonly edges = new Map<string, ThreadEdge>();

  addNode(node: ThreadNode): void {
    if (this.nodes.has(node.id)) return;
    if (Object.keys(node.metadata).length > MAX_THREAD_METADATA_ENTRIES) {
      throw new Error(`Node "${node.id}" exceeds MAX_THREAD_METADATA_ENTRIES.`);
    }
    this.nodes.set(node.id, node);
  }

  hasNode(id: string): boolean {
    return this.nodes.has(id);
  }

  getNode(id: string): ThreadNode | undefined {
    return this.nodes.get(id);
  }

  /** Edge identity (and dedup key) is exactly (kind, source, target) — the "logical edge". */
  addEdge(
    kind: ThreadEdgeKind,
    source: string,
    target: string,
    options: {
      label?: string | null;
      directed?: boolean;
      metadata?: Record<string, ThreadMetadataValue>;
    } = {},
  ): string {
    const id = `${kind}::${source}::${target}`;
    if (this.edges.has(id)) return id;
    if (source === target) {
      throw new Error(`Self-edge is not allowed: "${id}".`);
    }
    if (!this.nodes.has(source) || !this.nodes.has(target)) {
      throw new Error(`Edge "${id}" references a node that does not exist in the graph.`);
    }
    this.edges.set(id, {
      id,
      kind,
      source,
      target,
      label: options.label ?? null,
      directed: options.directed ?? true,
      metadata: options.metadata ?? {},
    });
    return id;
  }

  patchEdgeMetadata(edgeId: string, metadata: Record<string, ThreadMetadataValue>): void {
    const edge = this.edges.get(edgeId);
    if (!edge) return;
    this.edges.set(edgeId, { ...edge, metadata: { ...edge.metadata, ...metadata } });
  }

  patchNodeMetadata(nodeId: string, metadata: Record<string, ThreadMetadataValue>): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    const merged = { ...node.metadata, ...metadata };
    if (Object.keys(merged).length > MAX_THREAD_METADATA_ENTRIES) {
      throw new Error(`Node "${nodeId}" exceeds MAX_THREAD_METADATA_ENTRIES after patch.`);
    }
    this.nodes.set(nodeId, { ...node, metadata: merged });
  }

  /**
   * Any node not reachable (via any edge, either direction) from the
   * PROGRAM node gets a fallback ASSOCIATED_WITH edge from PROGRAM — so no
   * record is ever silently orphaned (§5, last sentence). This is a single
   * generic pass instead of special-casing every optional relationship.
   */
  connectOrphans(programNodeId: string): void {
    const adjacency = new Map<string, Set<string>>();
    for (const edge of this.edges.values()) {
      if (!adjacency.has(edge.source)) adjacency.set(edge.source, new Set());
      if (!adjacency.has(edge.target)) adjacency.set(edge.target, new Set());
      adjacency.get(edge.source)!.add(edge.target);
      adjacency.get(edge.target)!.add(edge.source);
    }

    const reached = new Set<string>([programNodeId]);
    const queue = [programNodeId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const neighbor of adjacency.get(current) ?? []) {
        if (reached.has(neighbor)) continue;
        reached.add(neighbor);
        queue.push(neighbor);
      }
    }

    const orphanIds = [...this.nodes.keys()].filter((id) => !reached.has(id)).sort();
    for (const orphanId of orphanIds) {
      this.addEdge("ASSOCIATED_WITH", programNodeId, orphanId, { label: "Associated with" });
    }
  }

  build(programId: string): ProgramThreadGraph {
    const nodeOrder = new Map<ThreadNodeKind, number>();
    (
      [
        "PROGRAM",
        "COMPONENT",
        "REQUIREMENT",
        "MILESTONE",
        "RISK",
        "SUPPLIER",
        "TEST_CASE",
        "DEFECT",
        "BUDGET_ITEM",
        "PROGRAM_EVENT",
        "ANALYSIS_RUN",
        "MITIGATION_OPTION",
        "DECISION",
        "PROPOSED_CHANGE",
      ] as const
    ).forEach((kind, index) => nodeOrder.set(kind, index));

    const edgeOrder = new Map<ThreadEdgeKind, number>();
    (
      [
        "CONTAINS",
        "ASSOCIATED_WITH",
        "SATISFIES",
        "SCHEDULED_ON",
        "DEPENDS_ON",
        "VERIFIED_BY",
        "HAS_DEFECT",
        "HAS_RISK",
        "HAS_BUDGET",
        "SUPPLIED",
        "TRIGGERED",
        "ANALYZED_BY",
        "CITED",
        "PROPOSED",
        "DECIDED",
        "TARGETS",
      ] as const
    ).forEach((kind, index) => edgeOrder.set(kind, index));

    const nodes = [...this.nodes.values()].sort((a, b) => {
      const kindDelta = (nodeOrder.get(a.kind) ?? 0) - (nodeOrder.get(b.kind) ?? 0);
      return kindDelta !== 0 ? kindDelta : a.recordId.localeCompare(b.recordId);
    });
    const edges = [...this.edges.values()].sort((a, b) => {
      const kindDelta = (edgeOrder.get(a.kind) ?? 0) - (edgeOrder.get(b.kind) ?? 0);
      if (kindDelta !== 0) return kindDelta;
      const sourceDelta = a.source.localeCompare(b.source);
      return sourceDelta !== 0 ? sourceDelta : a.target.localeCompare(b.target);
    });

    return { programId, nodes, edges, nodeCount: nodes.length, edgeCount: edges.length };
  }
}

export async function buildProgramThread(
  programId: string,
): Promise<ServiceResult<ProgramThreadGraph>> {
  const parsed = entityIdSchema.safeParse(programId);
  if (!parsed.success) {
    return validationError(parsed.error.issues.map((issue) => issue.message).join("; "));
  }

  const program = await prisma.program.findUnique({
    where: { id: parsed.data },
    select: { id: true, name: true, description: true },
  });
  if (!program) {
    return notFound("PROGRAM", parsed.data);
  }

  try {
    const graph = await buildGraphUnsafe(program);
    if (graph.nodes.length > MAX_THREAD_NODES) {
      return validationError(
        `Thread graph exceeds MAX_THREAD_NODES (${graph.nodes.length} > ${MAX_THREAD_NODES}).`,
      );
    }
    if (graph.edges.length > MAX_THREAD_EDGES) {
      return validationError(
        `Thread graph exceeds MAX_THREAD_EDGES (${graph.edges.length} > ${MAX_THREAD_EDGES}).`,
      );
    }
    const violations = validateGraphInvariants(graph);
    if (violations.length > 0) {
      return validationError(`Thread graph invariant violation: ${violations.join("; ")}`);
    }
    return ok(graph);
  } catch (error) {
    // A programming invariant was violated while building (e.g. a
    // duplicate node ID collision inside GraphBuilder) — fail safe with
    // VALIDATION_ERROR rather than ever returning a partial/corrupt graph.
    const message = error instanceof Error ? error.message : "Unknown thread graph build error.";
    return validationError(`Thread graph could not be safely constructed: ${message}`);
  }
}

async function buildGraphUnsafe(program: {
  id: string;
  name: string;
  description: string;
}): Promise<ProgramThreadGraph> {
  const programId = program.id;
  const builder = new GraphBuilder();

  const [
    components,
    requirements,
    requirementComponents,
    milestones,
    dependencies,
    risks,
    suppliers,
    testCases,
    testRequirements,
    defects,
    budgetItems,
    events,
  ] = await Promise.all([
    prisma.component.findMany({
      where: { programId },
      select: { id: true, name: true, subsystem: true },
    }),
    prisma.requirement.findMany({
      where: { programId },
      select: { id: true, title: true, priority: true, status: true },
    }),
    prisma.requirementComponent.findMany({
      where: { requirement: { programId } },
      select: { requirementId: true, componentId: true },
    }),
    prisma.milestone.findMany({
      where: { programId },
      select: {
        id: true,
        name: true,
        componentId: true,
        plannedDate: true,
        currentDate: true,
        status: true,
      },
    }),
    prisma.dependency.findMany({
      where: { programId },
      select: { id: true, fromMilestoneId: true, toMilestoneId: true },
    }),
    prisma.risk.findMany({
      where: { programId },
      select: {
        id: true,
        title: true,
        severity: true,
        probability: true,
        impact: true,
        status: true,
        componentId: true,
      },
    }),
    prisma.supplier.findMany({ where: { programId }, select: { id: true, name: true } }),
    prisma.testCase.findMany({
      where: { programId },
      select: { id: true, name: true, outcome: true, lastRunAt: true },
    }),
    prisma.testRequirement.findMany({
      where: { requirement: { programId } },
      select: { testCaseId: true, requirementId: true },
    }),
    prisma.defect.findMany({
      where: { programId },
      select: { id: true, title: true, severity: true, status: true, relatedTestCaseId: true },
    }),
    prisma.budgetItem.findMany({
      where: { programId },
      select: {
        id: true,
        category: true,
        componentId: true,
        plannedAmount: true,
        actualAmount: true,
        currency: true,
      },
    }),
    prisma.programEvent.findMany({
      where: { programId },
      select: {
        id: true,
        eventType: true,
        componentId: true,
        supplierId: true,
        confidence: true,
        quantity: true,
        delayDays: true,
      },
    }),
  ]);

  // ---- PROGRAM ----
  const programNodeId = threadNodeId("PROGRAM", programId);
  builder.addNode({
    id: programNodeId,
    kind: "PROGRAM",
    recordId: programId,
    label: label(program.name),
    subtitle: label(program.description),
    status: null,
    href: PROGRAM_HREF,
    metadata: {},
  });

  // ---- COMPONENT ---- (Program CONTAINS Component)
  for (const component of components) {
    const id = threadNodeId("COMPONENT", component.id);
    builder.addNode({
      id,
      kind: "COMPONENT",
      recordId: component.id,
      label: label(component.name),
      subtitle: label(component.subsystem),
      status: null,
      href: PROGRAM_HREF,
      metadata: { subsystem: component.subsystem },
    });
    builder.addEdge("CONTAINS", programNodeId, id, { label: "Contains" });
  }

  // ---- SUPPLIER ---- (Program CONTAINS Supplier)
  for (const supplier of suppliers) {
    const id = threadNodeId("SUPPLIER", supplier.id);
    builder.addNode({
      id,
      kind: "SUPPLIER",
      recordId: supplier.id,
      label: label(supplier.name),
      subtitle: null,
      status: null,
      href: PROGRAM_HREF,
      metadata: {},
    });
    builder.addEdge("CONTAINS", programNodeId, id, { label: "Contains" });
  }

  // ---- REQUIREMENT ---- (Component SATISFIES Requirement, via RequirementComponent)
  for (const requirement of requirements) {
    const id = threadNodeId("REQUIREMENT", requirement.id);
    builder.addNode({
      id,
      kind: "REQUIREMENT",
      recordId: requirement.id,
      label: label(requirement.title),
      subtitle: label(requirement.priority),
      status: requirement.status,
      href: PROGRAM_HREF,
      metadata: { priority: requirement.priority },
    });
  }
  for (const link of requirementComponents) {
    const componentNodeId = threadNodeId("COMPONENT", link.componentId);
    const requirementNodeId = threadNodeId("REQUIREMENT", link.requirementId);
    if (!builder.hasNode(componentNodeId) || !builder.hasNode(requirementNodeId)) continue;
    builder.addEdge("SATISFIES", componentNodeId, requirementNodeId, { label: "Satisfies" });
  }

  // ---- MILESTONE ---- (Component SCHEDULED_ON Milestone)
  for (const milestone of milestones) {
    const id = threadNodeId("MILESTONE", milestone.id);
    builder.addNode({
      id,
      kind: "MILESTONE",
      recordId: milestone.id,
      label: label(milestone.name),
      subtitle: `Planned ${isoDate(milestone.plannedDate)}`,
      status: milestone.status,
      href: PROGRAM_HREF,
      metadata: {
        plannedDate: isoDate(milestone.plannedDate),
        currentDate: isoDate(milestone.currentDate),
      },
    });
    const componentNodeId = threadNodeId("COMPONENT", milestone.componentId);
    if (builder.hasNode(componentNodeId)) {
      builder.addEdge("SCHEDULED_ON", componentNodeId, id, { label: "Scheduled on" });
    }
  }

  // ---- Dependency (Milestone -> Milestone) ---- (DEPENDS_ON, database direction preserved)
  const dependencyEdgeIdByDependencyId = new Map<string, string>();
  for (const dependency of dependencies) {
    const fromNodeId = threadNodeId("MILESTONE", dependency.fromMilestoneId);
    const toNodeId = threadNodeId("MILESTONE", dependency.toMilestoneId);
    if (!builder.hasNode(fromNodeId) || !builder.hasNode(toNodeId)) continue;
    const edgeId = builder.addEdge("DEPENDS_ON", fromNodeId, toNodeId, {
      label: "Must complete before",
      metadata: { cited: false },
    });
    dependencyEdgeIdByDependencyId.set(dependency.id, edgeId);
  }

  // ---- RISK ---- (Component HAS_RISK Risk)
  for (const risk of risks) {
    const id = threadNodeId("RISK", risk.id);
    const scoreCalc = computeRiskScore(risk.probability, risk.impact, risk.severity);
    builder.addNode({
      id,
      kind: "RISK",
      recordId: risk.id,
      label: label(risk.title),
      subtitle: `Score ${scoreCalc.score} (${scoreCalc.computedBand})`,
      status: risk.status,
      href: PROGRAM_HREF,
      metadata: {
        probability: risk.probability,
        impact: risk.impact,
        score: scoreCalc.score,
        band: scoreCalc.computedBand,
      },
    });
    if (risk.componentId) {
      const componentNodeId = threadNodeId("COMPONENT", risk.componentId);
      if (builder.hasNode(componentNodeId)) {
        builder.addEdge("HAS_RISK", componentNodeId, id, { label: "Has risk" });
      }
    }
  }

  // ---- TEST_CASE ---- (Requirement VERIFIED_BY TestCase, via TestRequirement)
  for (const testCase of testCases) {
    const id = threadNodeId("TEST_CASE", testCase.id);
    builder.addNode({
      id,
      kind: "TEST_CASE",
      recordId: testCase.id,
      label: label(testCase.name),
      subtitle: testCase.lastRunAt ? `Last run ${isoDate(testCase.lastRunAt)}` : "Never run",
      status: testCase.outcome,
      href: PROGRAM_HREF,
      metadata: { lastRunAt: testCase.lastRunAt ? isoDate(testCase.lastRunAt) : null },
    });
  }
  for (const link of testRequirements) {
    const requirementNodeId = threadNodeId("REQUIREMENT", link.requirementId);
    const testNodeId = threadNodeId("TEST_CASE", link.testCaseId);
    if (!builder.hasNode(requirementNodeId) || !builder.hasNode(testNodeId)) continue;
    builder.addEdge("VERIFIED_BY", requirementNodeId, testNodeId, { label: "Verified by" });
  }

  // ---- DEFECT ---- (TestCase HAS_DEFECT Defect, where relatedTestCaseId exists)
  for (const defect of defects) {
    const id = threadNodeId("DEFECT", defect.id);
    builder.addNode({
      id,
      kind: "DEFECT",
      recordId: defect.id,
      label: label(defect.title),
      subtitle: label(defect.severity),
      status: defect.status,
      href: PROGRAM_HREF,
      metadata: { severity: defect.severity },
    });
    if (defect.relatedTestCaseId) {
      const testNodeId = threadNodeId("TEST_CASE", defect.relatedTestCaseId);
      if (builder.hasNode(testNodeId)) {
        builder.addEdge("HAS_DEFECT", testNodeId, id, { label: "Has defect" });
      }
    }
  }

  // ---- BUDGET_ITEM ---- (Component HAS_BUDGET BudgetItem)
  for (const item of budgetItems) {
    const id = threadNodeId("BUDGET_ITEM", item.id);
    const variance = item.actualAmount.minus(item.plannedAmount);
    builder.addNode({
      id,
      kind: "BUDGET_ITEM",
      recordId: item.id,
      label: label(item.category),
      subtitle: `${item.currency} ${money(item.actualAmount)}`,
      status: null,
      href: PROGRAM_HREF,
      metadata: {
        plannedAmount: money(item.plannedAmount),
        actualAmount: money(item.actualAmount),
        varianceAmount: money(variance),
        currency: item.currency,
      },
    });
    if (item.componentId) {
      const componentNodeId = threadNodeId("COMPONENT", item.componentId);
      if (builder.hasNode(componentNodeId)) {
        builder.addEdge("HAS_BUDGET", componentNodeId, id, { label: "Has budget" });
      }
    }
  }

  // ---- PROGRAM_EVENT ---- (Supplier SUPPLIED / Component TRIGGERED ProgramEvent)
  for (const event of events) {
    const id = threadNodeId("PROGRAM_EVENT", event.id);
    builder.addNode({
      id,
      kind: "PROGRAM_EVENT",
      recordId: event.id,
      label: label(event.eventType.replaceAll("_", " ")),
      subtitle: event.delayDays !== null ? `${event.delayDays}-day delay` : null,
      status: null,
      href: PROGRAM_HREF,
      metadata: {
        eventType: event.eventType,
        confidence: event.confidence,
        quantity: event.quantity,
        delayDays: event.delayDays,
      },
    });
    if (event.supplierId) {
      const supplierNodeId = threadNodeId("SUPPLIER", event.supplierId);
      if (builder.hasNode(supplierNodeId)) {
        builder.addEdge("SUPPLIED", supplierNodeId, id, { label: "Supplied" });
      }
    }
    if (event.componentId) {
      const componentNodeId = threadNodeId("COMPONENT", event.componentId);
      if (builder.hasNode(componentNodeId)) {
        builder.addEdge("TRIGGERED", componentNodeId, id, { label: "Triggered" });
      }
    }
  }

  // ---- ANALYSIS_RUN (grouped by analysisRunId) ----
  const analysisAttempts = await prisma.impactAnalysis.findMany({
    where: { programEvent: { programId } },
    select: {
      id: true,
      programEventId: true,
      analysisRunId: true,
      traceId: true,
      status: true,
      attempt: true,
      confidence: true,
      scheduleExposureDays: true,
      budgetExposureAmount: true,
    },
    orderBy: [{ analysisRunId: "asc" }, { attempt: "asc" }],
  });

  const attemptsByRun = new Map<string, typeof analysisAttempts>();
  for (const attempt of analysisAttempts) {
    const list = attemptsByRun.get(attempt.analysisRunId) ?? [];
    list.push(attempt);
    attemptsByRun.set(attempt.analysisRunId, list);
  }

  interface RunInfo {
    analysisRunId: string;
    programEventId: string;
    terminalAnalysisId: string;
    terminalStatus: string;
    attemptCount: number;
    terminalTraceId: string;
  }
  const runInfos: RunInfo[] = [];

  for (const [analysisRunId, attempts] of attemptsByRun) {
    const terminal = attempts.reduce((max, current) =>
      current.attempt > max.attempt ? current : max,
    );
    runInfos.push({
      analysisRunId,
      programEventId: terminal.programEventId,
      terminalAnalysisId: terminal.id,
      terminalStatus: terminal.status,
      attemptCount: attempts.length,
      terminalTraceId: terminal.traceId,
    });

    const nodeId = threadNodeId("ANALYSIS_RUN", analysisRunId);
    const isSucceeded = terminal.status === "SUCCEEDED";
    builder.addNode({
      id: nodeId,
      kind: "ANALYSIS_RUN",
      recordId: analysisRunId,
      label: label(`Analysis run ${analysisRunId}`),
      subtitle: `${attempts.length} attempt${attempts.length === 1 ? "" : "s"}`,
      status: terminal.status,
      href: `/programs/edgelink-x/analyses/${terminal.id}`,
      metadata: {
        attemptCount: attempts.length,
        terminalStatus: terminal.status,
        terminalTraceId: terminal.traceId,
        confidence: isSucceeded ? (terminal.confidence ?? null) : null,
        scheduleExposureDays: isSucceeded ? (terminal.scheduleExposureDays ?? null) : null,
        budgetExposureAmount: isSucceeded ? money(terminal.budgetExposureAmount) : null,
        omittedCitationCount: 0,
      },
    });

    const eventNodeId = threadNodeId("PROGRAM_EVENT", terminal.programEventId);
    if (builder.hasNode(eventNodeId)) {
      builder.addEdge("ANALYZED_BY", eventNodeId, nodeId, { label: "Analyzed by" });
    }
  }

  // ---- MITIGATION_OPTION / DECISION / PROPOSED_CHANGE ----
  // Only the successful terminal attempt of each run may have mitigation
  // options linked — a failed run gets no phantom options (§4).
  const succeededTerminalIds = runInfos
    .filter((run) => run.terminalStatus === "SUCCEEDED")
    .map((run) => run.terminalAnalysisId);

  const mitigationOptions =
    succeededTerminalIds.length === 0
      ? []
      : await prisma.mitigationOption.findMany({
          where: { impactAnalysisId: { in: succeededTerminalIds } },
          select: {
            id: true,
            impactAnalysisId: true,
            optionIndex: true,
            title: true,
            costImpact: true,
            scheduleImpact: true,
            isRecommended: true,
            status: true,
          },
        });

  const analysisRunIdByTerminalAnalysisId = new Map(
    runInfos.map((run) => [run.terminalAnalysisId, run.analysisRunId]),
  );

  for (const option of mitigationOptions) {
    const runId = analysisRunIdByTerminalAnalysisId.get(option.impactAnalysisId);
    if (!runId) continue;
    const runNodeId = threadNodeId("ANALYSIS_RUN", runId);
    const optionNodeId = threadNodeId("MITIGATION_OPTION", option.id);
    builder.addNode({
      id: optionNodeId,
      kind: "MITIGATION_OPTION",
      recordId: option.id,
      label: label(option.title),
      subtitle: `Option ${option.optionIndex + 1}`,
      status: option.status,
      href: `/programs/edgelink-x/analyses/${option.impactAnalysisId}/options/${option.id}/decision`,
      metadata: {
        costImpact: money(option.costImpact),
        scheduleImpact: option.scheduleImpact,
        isRecommended: option.isRecommended,
      },
    });
    builder.addEdge("CONTAINS", runNodeId, optionNodeId, { label: "Contains" });
  }

  const optionIds = mitigationOptions.map((option) => option.id);

  const decisions =
    optionIds.length === 0
      ? []
      : await prisma.decision.findMany({
          where: { mitigationOptionId: { in: optionIds } },
          select: { id: true, mitigationOptionId: true, verdict: true, rationale: true },
        });
  for (const decision of decisions) {
    const optionNodeId = threadNodeId("MITIGATION_OPTION", decision.mitigationOptionId);
    if (!builder.hasNode(optionNodeId)) continue;
    const id = threadNodeId("DECISION", decision.id);
    const rationaleExcerpt = truncateText(decision.rationale, 100);
    builder.addNode({
      id,
      kind: "DECISION",
      recordId: decision.id,
      label: label(`Decision: ${decision.verdict.replaceAll("_", " ")}`),
      subtitle: null,
      status: decision.verdict,
      href: PROGRAM_HREF,
      metadata: {
        verdict: decision.verdict,
        rationaleExcerpt: rationaleExcerpt.text + (rationaleExcerpt.truncated ? "…" : ""),
      },
    });
    builder.addEdge("DECIDED", optionNodeId, id, { label: "Decided" });
  }

  const proposedChanges =
    optionIds.length === 0
      ? []
      : await prisma.proposedChange.findMany({
          where: { mitigationOptionId: { in: optionIds } },
          select: {
            id: true,
            mitigationOptionId: true,
            changeType: true,
            targetRecordId: true,
            targetRecordType: true,
            status: true,
          },
        });
  for (const change of proposedChanges) {
    const optionNodeId = threadNodeId("MITIGATION_OPTION", change.mitigationOptionId);
    if (!builder.hasNode(optionNodeId)) continue;
    const id = threadNodeId("PROPOSED_CHANGE", change.id);
    builder.addNode({
      id,
      kind: "PROPOSED_CHANGE",
      recordId: change.id,
      label: label(change.changeType.replaceAll("_", " ")),
      subtitle: null,
      status: change.status,
      href: `/programs/edgelink-x/analyses/${mitigationOptionAnalysisId(mitigationOptions, change.mitigationOptionId)}/options/${change.mitigationOptionId}/apply`,
      metadata: { changeType: change.changeType, targetRecordType: change.targetRecordType },
    });
    builder.addEdge("PROPOSED", optionNodeId, id, { label: "Proposed" });

    // NEW_ACTION has no existing record to target — no fake TARGETS edge.
    if (change.targetRecordId && change.targetRecordType) {
      const targetKind = proposedChangeTargetToNodeKind(change.targetRecordType);
      if (targetKind) {
        const targetNodeId = threadNodeId(targetKind, change.targetRecordId);
        if (builder.hasNode(targetNodeId)) {
          builder.addEdge("TARGETS", id, targetNodeId, { label: "Targets" });
        }
      }
    }
  }

  // ---- Evidence citations (CITED edges from ANALYSIS_RUN) ----
  const sourceReferences =
    succeededTerminalIds.length === 0
      ? []
      : await prisma.sourceReference.findMany({
          where: { impactAnalysisId: { in: succeededTerminalIds }, wasCited: true },
          select: { impactAnalysisId: true, recordId: true, recordType: true },
        });

  const terminalAnalysisIdToRunId = new Map(
    runInfos.map((run) => [run.terminalAnalysisId, run.analysisRunId]),
  );

  for (const [terminalAnalysisId, runId] of terminalAnalysisIdToRunId) {
    const citations = sourceReferences.filter((ref) => ref.impactAnalysisId === terminalAnalysisId);
    if (citations.length === 0) continue;
    const runNodeId = threadNodeId("ANALYSIS_RUN", runId);
    const citedNodeIds = new Set<string>();
    let omittedCount = 0;

    for (const citation of citations) {
      if (citation.recordType === "DEPENDENCY") {
        const edgeId = dependencyEdgeIdByDependencyId.get(citation.recordId);
        if (edgeId) {
          builder.patchEdgeMetadata(edgeId, { cited: true });
        } else {
          omittedCount += 1;
        }
        continue;
      }
      const nodeKind = evidenceTypeToNodeKind(citation.recordType as EvidenceRecordType);
      if (!nodeKind) {
        omittedCount += 1;
        continue;
      }
      const targetNodeId = threadNodeId(nodeKind, citation.recordId);
      if (!builder.hasNode(targetNodeId)) {
        omittedCount += 1;
        continue;
      }
      citedNodeIds.add(targetNodeId);
    }

    for (const targetNodeId of citedNodeIds) {
      builder.addEdge("CITED", runNodeId, targetNodeId, { label: "Cited" });
    }
    if (omittedCount > 0) {
      builder.patchNodeMetadata(runNodeId, { omittedCitationCount: omittedCount });
    }
  }

  builder.connectOrphans(programNodeId);

  return builder.build(programId);
}

function mitigationOptionAnalysisId(
  options: Array<{ id: string; impactAnalysisId: string }>,
  optionId: string,
): string {
  return options.find((option) => option.id === optionId)?.impactAnalysisId ?? "";
}

function proposedChangeTargetToNodeKind(targetRecordType: string): ThreadNodeKind | null {
  switch (targetRecordType) {
    case "MILESTONE":
      return "MILESTONE";
    case "RISK":
      return "RISK";
    case "BUDGET_ITEM":
      return "BUDGET_ITEM";
    default:
      return null;
  }
}

export function validateGraphInvariants(graph: ProgramThreadGraph): string[] {
  const violations: string[] = [];

  const nodeIds = new Set<string>();
  for (const node of graph.nodes) {
    if (nodeIds.has(node.id)) violations.push(`Duplicate node ID "${node.id}".`);
    nodeIds.add(node.id);
    if (node.label.length > MAX_THREAD_LABEL_LENGTH) {
      violations.push(`Node "${node.id}" label exceeds MAX_THREAD_LABEL_LENGTH.`);
    }
    if (Object.keys(node.metadata).length > MAX_THREAD_METADATA_ENTRIES) {
      violations.push(`Node "${node.id}" metadata exceeds MAX_THREAD_METADATA_ENTRIES.`);
    }
  }

  const edgeIds = new Set<string>();
  const logicalEdgeKeys = new Set<string>();
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) violations.push(`Duplicate edge ID "${edge.id}".`);
    edgeIds.add(edge.id);

    const logicalKey = `${edge.kind}::${edge.source}::${edge.target}`;
    if (logicalEdgeKeys.has(logicalKey)) {
      violations.push(`Duplicate logical edge "${logicalKey}".`);
    }
    logicalEdgeKeys.add(logicalKey);

    if (!nodeIds.has(edge.source)) {
      violations.push(`Edge "${edge.id}" source "${edge.source}" does not exist.`);
    }
    if (!nodeIds.has(edge.target)) {
      violations.push(`Edge "${edge.id}" target "${edge.target}" does not exist.`);
    }
    if (edge.source === edge.target) {
      violations.push(`Edge "${edge.id}" is a self-edge, which is not allowed.`);
    }
  }

  return violations;
}
