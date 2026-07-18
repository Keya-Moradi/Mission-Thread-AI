import { prisma } from "../db";
import { entityIdSchema } from "./schemas";
import { notFound, ok, validationError, type ServiceResult } from "./types";
import { EVIDENCE_RECORD_TYPES } from "../record-types";
import { getImpactedRequirements, getImpactedMilestones } from "./traceability";
import { getVerificationGaps } from "./verification";
import { getRelatedDefects } from "./defects";
import { calculateScheduleExposure } from "./schedule";
import { calculateBudgetExposure } from "./budget";
import { calculateReadinessScore } from "./readiness";

type EvidenceRecordType = (typeof EVIDENCE_RECORD_TYPES)[number];

export interface EvidenceItem {
  recordId: string;
  recordType: EvidenceRecordType;
  summary: string;
}

export interface AnalysisEvidence {
  eventId: string;
  evidence: EvidenceItem[];
  assumptions: string[];
  unknowns: string[];
  /**
   * Isolated, untrusted supplier-submitted text — deliberately never part of
   * `evidence[]` and never read by any Phase 2 calculation. See
   * docs/DECISIONS.md, "Evidence bounding". A future Phase 4 prompt must
   * keep this clearly labeled as data, not instructions.
   */
  untrustedSupplierNotes: string | null;
}

const TYPE_ORDER = new Map(EVIDENCE_RECORD_TYPES.map((type, index) => [type, index]));

function buildEventSummary(event: {
  eventType: string;
  delayDays: number | null;
  reason: string | null;
  componentName: string | null;
}): string {
  const parts = [event.eventType];
  if (event.componentName) parts.push(`component "${event.componentName}"`);
  if (event.delayDays !== null) parts.push(`${event.delayDays}-day delay`);
  if (event.reason) parts.push(`reason: ${event.reason}`);
  return parts.join(", ");
}

export async function buildAnalysisEvidence(
  eventId: string,
): Promise<ServiceResult<AnalysisEvidence>> {
  const parsed = entityIdSchema.safeParse(eventId);
  if (!parsed.success) {
    return validationError(parsed.error.issues.map((issue) => issue.message).join("; "));
  }

  const event = await prisma.programEvent.findUnique({
    where: { id: parsed.data },
    include: { component: true, supplier: true, program: true },
  });
  if (!event) {
    return notFound("PROGRAM_EVENT", parsed.data);
  }

  const assumptions: string[] = [
    "Schedule cascade assumes every impacted milestone shifts by the full direct delay; no partial mitigation or schedule float is modeled.",
    "Budget exposure reflects existing planned/actual variance on directly linked budget items, not a newly calculated incremental delay cost — the schema has no per-day cost field.",
    "Readiness score treats a category with zero records (e.g. no tests, no risks) as neutral (full points), not as a penalty.",
  ];
  const unknowns: string[] = [];

  const items = new Map<string, EvidenceItem>();
  const addItem = (recordType: EvidenceRecordType, recordId: string, summary: string) => {
    items.set(`${recordType}:${recordId}`, { recordType, recordId, summary });
  };

  addItem(
    "PROGRAM_EVENT",
    event.id,
    buildEventSummary({
      eventType: event.eventType,
      delayDays: event.delayDays,
      reason: event.reason,
      componentName: event.component?.name ?? null,
    }),
  );
  addItem("PROGRAM", event.program.id, `${event.program.name}: ${event.program.description}`);
  if (event.component) {
    addItem(
      "COMPONENT",
      event.component.id,
      `${event.component.name} (${event.component.subsystem})`,
    );
  }
  if (event.supplier) {
    addItem("SUPPLIER", event.supplier.id, `Supplier: ${event.supplier.name}`);
  }

  let impactedRequirementIds: string[] = [];
  let impactedMilestoneIds: string[] = [];
  let dependencyDerivedMilestoneIds: string[] = [];

  if (event.component) {
    const [requirementsResult, milestonesResult] = await Promise.all([
      getImpactedRequirements(event.component.id),
      getImpactedMilestones(event.component.id),
    ]);

    if (requirementsResult.ok) {
      impactedRequirementIds = requirementsResult.data.map((r) => r.requirementId).sort();
      for (const requirement of requirementsResult.data) {
        addItem(
          "REQUIREMENT",
          requirement.requirementId,
          `${requirement.title} — status ${requirement.status}, priority ${requirement.priority}`,
        );
      }
    } else {
      unknowns.push(`Could not resolve impacted requirements: ${requirementsResult.error.message}`);
    }

    if (milestonesResult.ok) {
      impactedMilestoneIds = milestonesResult.data.map((m) => m.milestoneId).sort();
      dependencyDerivedMilestoneIds = milestonesResult.data
        .filter((m) => m.relationship === "dependency-derived")
        .map((m) => m.milestoneId)
        .sort();
      for (const milestone of milestonesResult.data) {
        addItem(
          "MILESTONE",
          milestone.milestoneId,
          `${milestone.name} — status ${milestone.status}, planned ${milestone.plannedDate}`,
        );
      }
    } else {
      unknowns.push(`Could not resolve impacted milestones: ${milestonesResult.error.message}`);
    }

    // Cite the specific Dependency edges that connect the impacted subgraph
    // — an edge is cascade-relevant only when both endpoints are impacted
    // milestones, which is exactly what makes a dependency-derived
    // milestone impacted in the first place.
    if (impactedMilestoneIds.length > 0) {
      const impactedSet = new Set(impactedMilestoneIds);
      const edges = await prisma.dependency.findMany({
        where: { programId: event.program.id },
        select: { id: true, fromMilestoneId: true, toMilestoneId: true },
      });
      for (const edge of edges) {
        if (impactedSet.has(edge.fromMilestoneId) && impactedSet.has(edge.toMilestoneId)) {
          addItem(
            "DEPENDENCY",
            edge.id,
            `Dependency ${edge.id}: ${edge.fromMilestoneId} -> ${edge.toMilestoneId}`,
          );
        }
      }
    }
  } else {
    unknowns.push(
      "Event has no linked component; no impacted requirements, milestones, or dependency edges could be identified.",
    );
  }

  if (impactedRequirementIds.length > 0) {
    const [gapsResult, defectsResult] = await Promise.all([
      getVerificationGaps(impactedRequirementIds),
      getRelatedDefects(impactedRequirementIds),
    ]);

    if (gapsResult.ok) {
      const testIds = [...new Set(gapsResult.data.results.flatMap((r) => r.testIds))].sort();
      if (testIds.length > 0) {
        const testCases = await prisma.testCase.findMany({
          where: { id: { in: testIds } },
          select: { id: true, name: true, outcome: true },
        });
        for (const testCase of testCases) {
          addItem("TEST_CASE", testCase.id, `${testCase.name} — outcome ${testCase.outcome}`);
        }
      }
      if (gapsResult.data.missingRequirementIds.length > 0) {
        unknowns.push(
          `Requested requirement IDs not found: ${gapsResult.data.missingRequirementIds.join(", ")}.`,
        );
      }
    } else {
      unknowns.push(`Could not resolve verification gaps: ${gapsResult.error.message}`);
    }

    if (defectsResult.ok) {
      for (const defect of defectsResult.data.results) {
        addItem(
          "DEFECT",
          defect.defectId,
          `${defect.title} — severity ${defect.severity}, status ${defect.status}`,
        );
      }
    } else {
      unknowns.push(`Could not resolve related defects: ${defectsResult.error.message}`);
    }
  }

  const [scheduleResult, budgetResult, readinessResult, componentRisks] = await Promise.all([
    calculateScheduleExposure(event.id),
    calculateBudgetExposure(event.id),
    calculateReadinessScore(event.program.id),
    event.component
      ? prisma.risk.findMany({
          where: { componentId: event.component.id },
          select: { id: true, title: true, severity: true, status: true },
        })
      : Promise.resolve([]),
  ]);

  if (scheduleResult.ok) {
    unknowns.push(...scheduleResult.data.missingData);
  } else {
    unknowns.push(`Could not resolve schedule exposure: ${scheduleResult.error.message}`);
  }

  if (budgetResult.ok) {
    unknowns.push(...budgetResult.data.missingData);
    for (const item of budgetResult.data.exposedBudgetItems) {
      addItem(
        "BUDGET_ITEM",
        item.budgetItemId,
        `${item.category}: planned ${item.plannedAmount}, actual ${item.actualAmount} ${item.currency}`,
      );
    }
  } else {
    unknowns.push(`Could not resolve budget exposure: ${budgetResult.error.message}`);
  }

  if (readinessResult.ok) {
    unknowns.push(...readinessResult.data.warnings);
  } else {
    unknowns.push(`Could not resolve readiness score: ${readinessResult.error.message}`);
  }

  for (const risk of componentRisks) {
    addItem("RISK", risk.id, `${risk.title} — severity ${risk.severity}, status ${risk.status}`);
  }

  const evidence = [...items.values()].sort((a, b) => {
    const typeDelta = (TYPE_ORDER.get(a.recordType) ?? 0) - (TYPE_ORDER.get(b.recordType) ?? 0);
    return typeDelta !== 0 ? typeDelta : a.recordId.localeCompare(b.recordId);
  });

  if (dependencyDerivedMilestoneIds.length === 0 && impactedMilestoneIds.length > 0) {
    unknowns.push(
      "No dependency-derived milestone impacts were found; only directly-linked milestones are affected.",
    );
  }

  return ok({
    eventId: event.id,
    evidence,
    assumptions,
    unknowns: [...new Set(unknowns)],
    untrustedSupplierNotes: event.rawNotes ?? null,
  });
}
