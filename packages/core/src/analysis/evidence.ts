import { prisma } from "../db";
import { entityIdSchema } from "./schemas";
import { notFound, ok, validationError, type ServiceResult } from "./types";
import { EVIDENCE_RECORD_TYPES } from "../record-types";
import {
  getImpactedRequirements,
  getImpactedMilestones,
  type ImpactedRequirement,
  type ImpactedMilestone,
} from "./traceability";
import { getVerificationGaps, type VerificationGapsResponse } from "./verification";
import { getRelatedDefects, type RelatedDefectsResponse } from "./defects";
import { calculateScheduleExposure, type ScheduleExposureResult } from "./schedule";
import { calculateBudgetExposure, type BudgetExposureResult } from "./budget";
import { calculateReadinessScore, type ReadinessScoreResult } from "./readiness";
import { calculateRiskScore, type RiskScoreResult } from "./risk";

type EvidenceRecordType = (typeof EVIDENCE_RECORD_TYPES)[number];

export interface EvidenceItem {
  recordId: string;
  recordType: EvidenceRecordType;
  summary: string;
}

/**
 * Deterministic, documented evidence bounds (docs/DECISIONS.md, "Evidence
 * count and length limits") — needed before this evidence could safely feed
 * a model prompt (Phase 4), even though nothing calls a model yet.
 */
export const EVIDENCE_LIMITS = {
  maxTotalItems: 100,
  maxItemsPerRecordType: 25,
  maxSummaryLength: 500,
  maxUntrustedTextLength: 4000,
} as const;

/**
 * Structured event facts derived only from validated database fields —
 * never from event.reason or event.rawNotes, which are free text a
 * supplier or user could have entered. See untrustedText below and
 * docs/DECISIONS.md, "Trusted structured facts vs. untrusted free text".
 */
export interface EventFacts {
  eventType: string;
  componentId: string | null;
  supplierId: string | null;
  originalDate: string | null;
  revisedDate: string | null;
  /** Computed from originalDate/revisedDate — authoritative over storedDelayDays when they disagree. */
  computedDelayDays: number | null;
  /** The event's own stored delayDays column, as-is — never presented as verified on its own. */
  storedDelayDays: number | null;
  delayDaysConsistent: boolean | null;
  confidence: string | null;
  quantity: number | null;
}

export interface AnalysisEvidence {
  eventId: string;

  eventFacts: EventFacts;

  impactedRequirements: ImpactedRequirement[];
  impactedMilestones: ImpactedMilestone[];
  verificationGaps: VerificationGapsResponse | null;
  relatedDefects: RelatedDefectsResponse | null;
  scheduleExposure: ScheduleExposureResult | null;
  budgetExposure: BudgetExposureResult | null;
  riskScores: RiskScoreResult[];
  readinessScore: ReadinessScoreResult | null;

  evidence: EvidenceItem[];
  assumptions: string[];
  unknowns: string[];

  /**
   * Free text a supplier or user submitted — deliberately isolated outside
   * `evidence[]`, never read by any Phase 2 calculation, and never
   * interpolated into a trusted summary. A future Phase 4 prompt must keep
   * this clearly labeled as data, not instructions. See docs/DECISIONS.md,
   * "Evidence bounding".
   */
  untrustedText: {
    reason: string | null;
    rawNotes: string | null;
  };
}

const TYPE_ORDER = new Map(EVIDENCE_RECORD_TYPES.map((type, index) => [type, index]));

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Structured-facts-only summary — eventType, component/supplier name,
 * computed delay, confidence, quantity. Deliberately excludes
 * event.reason and event.rawNotes: both are free text, never embedded in a
 * trusted evidence-item summary. See docs/DECISIONS.md.
 */
function buildEventSummary(event: {
  eventType: string;
  componentName: string | null;
  supplierName: string | null;
  computedDelayDays: number | null;
  confidence: string | null;
  quantity: number | null;
}): string {
  const parts = [event.eventType];
  if (event.componentName) parts.push(`component "${event.componentName}"`);
  if (event.supplierName) parts.push(`supplier "${event.supplierName}"`);
  if (event.computedDelayDays !== null) parts.push(`${event.computedDelayDays}-day delay`);
  if (event.confidence) parts.push(`confidence ${event.confidence}`);
  if (event.quantity !== null) parts.push(`quantity ${event.quantity}`);
  return parts.join(", ");
}

/**
 * Truncates to at most maxLength UTF-16 code units without splitting a
 * surrogate pair (an astral character, e.g. an emoji, is two UTF-16 code
 * units — cutting between them produces an unpaired, invalid code unit).
 * If the character immediately before the cut point is a high surrogate
 * (0xD800-0xDBFF) with no paired low surrogate included, the cut is moved
 * back one more position to exclude it entirely.
 */
export function truncateText(
  text: string,
  maxLength: number,
): { text: string; truncated: boolean } {
  if (text.length <= maxLength) return { text, truncated: false };
  let end = maxLength;
  const boundaryCode = text.charCodeAt(end - 1);
  if (boundaryCode >= 0xd800 && boundaryCode <= 0xdbff) {
    end -= 1;
  }
  return { text: text.slice(0, end), truncated: true };
}

export interface BoundedEvidence {
  evidence: EvidenceItem[];
  truncationNotes: string[];
}

/**
 * Applies EVIDENCE_LIMITS to an already-deduplicated, already-sorted
 * evidence array: per-item summary length, then a per-record-type cap,
 * then an overall cap — each preserving the existing deterministic order
 * rather than re-sorting, and each producing a truncationNotes entry
 * instead of silently dropping anything. Exported so bounds behavior is
 * directly unit-testable with synthetic data, without needing 100+ real
 * seeded records.
 */
export function applyEvidenceBounds(sortedEvidence: readonly EvidenceItem[]): BoundedEvidence {
  const truncationNotes: string[] = [];

  const withTruncatedSummaries = sortedEvidence.map((item) => {
    const { text, truncated } = truncateText(item.summary, EVIDENCE_LIMITS.maxSummaryLength);
    if (truncated) {
      truncationNotes.push(
        `Evidence summary for ${item.recordType} "${item.recordId}" was truncated to ${EVIDENCE_LIMITS.maxSummaryLength} characters.`,
      );
    }
    return text === item.summary ? item : { ...item, summary: text };
  });

  const countsByType = new Map<string, number>();
  const withinPerTypeLimit: EvidenceItem[] = [];
  const perTypeOverflowTypes = new Set<string>();
  for (const item of withTruncatedSummaries) {
    const count = countsByType.get(item.recordType) ?? 0;
    if (count < EVIDENCE_LIMITS.maxItemsPerRecordType) {
      withinPerTypeLimit.push(item);
      countsByType.set(item.recordType, count + 1);
    } else {
      perTypeOverflowTypes.add(item.recordType);
    }
  }
  for (const type of perTypeOverflowTypes) {
    truncationNotes.push(
      `More than ${EVIDENCE_LIMITS.maxItemsPerRecordType} ${type} evidence items were found; only the first ${EVIDENCE_LIMITS.maxItemsPerRecordType} (by deterministic order) are included.`,
    );
  }

  let finalEvidence = withinPerTypeLimit;
  if (withinPerTypeLimit.length > EVIDENCE_LIMITS.maxTotalItems) {
    finalEvidence = withinPerTypeLimit.slice(0, EVIDENCE_LIMITS.maxTotalItems);
    truncationNotes.push(
      `Evidence exceeded the maximum of ${EVIDENCE_LIMITS.maxTotalItems} total items; only the first ${EVIDENCE_LIMITS.maxTotalItems} (by deterministic order) are included.`,
    );
  }

  return { evidence: finalEvidence, truncationNotes };
}

function truncateUntrustedField(
  value: string | null,
  fieldName: string,
  notes: string[],
): string | null {
  if (value === null) return null;
  const { text, truncated } = truncateText(value, EVIDENCE_LIMITS.maxUntrustedTextLength);
  if (truncated) {
    notes.push(
      `Untrusted ${fieldName} text was truncated to ${EVIDENCE_LIMITS.maxUntrustedTextLength} characters.`,
    );
  }
  return text;
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

  // Run the schedule calculation first — it's the authoritative source for
  // computedDelayDays/delayDaysConsistent in eventFacts below, and for the
  // trusted event summary, instead of trusting event.delayDays on its own.
  const scheduleResult = await calculateScheduleExposure(event.id);
  if (!scheduleResult.ok) {
    unknowns.push(`Could not resolve schedule exposure: ${scheduleResult.error.message}`);
  } else {
    unknowns.push(...scheduleResult.data.missingData);
  }

  const eventFacts: EventFacts = scheduleResult.ok
    ? {
        eventType: event.eventType,
        componentId: event.componentId,
        supplierId: event.supplierId,
        originalDate: scheduleResult.data.originalDate,
        revisedDate: scheduleResult.data.revisedDate,
        computedDelayDays: scheduleResult.data.directDelayDays,
        storedDelayDays: scheduleResult.data.storedDelayDays,
        delayDaysConsistent: scheduleResult.data.delayDaysConsistent,
        confidence: event.confidence,
        quantity: event.quantity,
      }
    : {
        // Unexpected failure path only (schedule validation/existence were
        // already proven above by fetching this same event) — fall back to
        // the raw stored fields rather than fabricating a computed delay.
        eventType: event.eventType,
        componentId: event.componentId,
        supplierId: event.supplierId,
        originalDate: event.originalDate ? toIsoDate(event.originalDate) : null,
        revisedDate: event.revisedDate ? toIsoDate(event.revisedDate) : null,
        computedDelayDays: null,
        storedDelayDays: event.delayDays ?? null,
        delayDaysConsistent: null,
        confidence: event.confidence,
        quantity: event.quantity,
      };

  addItem(
    "PROGRAM_EVENT",
    event.id,
    buildEventSummary({
      eventType: event.eventType,
      componentName: event.component?.name ?? null,
      supplierName: event.supplier?.name ?? null,
      computedDelayDays: eventFacts.computedDelayDays,
      confidence: event.confidence,
      quantity: event.quantity,
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

  let impactedRequirements: ImpactedRequirement[] = [];
  let impactedMilestones: ImpactedMilestone[] = [];
  let impactedMilestoneIds: string[] = [];
  let dependencyDerivedMilestoneIds: string[] = [];

  if (event.component) {
    const [requirementsResult, milestonesResult] = await Promise.all([
      getImpactedRequirements(event.component.id),
      getImpactedMilestones(event.component.id),
    ]);

    if (requirementsResult.ok) {
      impactedRequirements = requirementsResult.data;
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
      impactedMilestones = milestonesResult.data;
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

    if (dependencyDerivedMilestoneIds.length === 0 && impactedMilestoneIds.length > 0) {
      unknowns.push(
        "No dependency-derived milestone impacts were found; only directly-linked milestones are affected.",
      );
    }
  } else {
    unknowns.push(
      "Event has no linked component; no impacted requirements, milestones, or dependency edges could be identified.",
    );
  }

  let verificationGaps: VerificationGapsResponse | null = null;
  let relatedDefects: RelatedDefectsResponse | null = null;

  const impactedRequirementIds = impactedRequirements.map((r) => r.requirementId).sort();
  if (impactedRequirementIds.length > 0) {
    const [gapsResult, defectsResult] = await Promise.all([
      getVerificationGaps(impactedRequirementIds),
      getRelatedDefects(impactedRequirementIds),
    ]);

    if (gapsResult.ok) {
      verificationGaps = gapsResult.data;
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
      relatedDefects = defectsResult.data;
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

  const [budgetResult, readinessResult, componentRisks] = await Promise.all([
    calculateBudgetExposure(event.id),
    calculateReadinessScore(event.program.id),
    event.component
      ? prisma.risk.findMany({
          where: { componentId: event.component.id },
          select: { id: true, title: true },
        })
      : Promise.resolve([]),
  ]);

  let budgetExposure: BudgetExposureResult | null = null;
  if (budgetResult.ok) {
    budgetExposure = budgetResult.data;
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

  let readinessScore: ReadinessScoreResult | null = null;
  if (readinessResult.ok) {
    readinessScore = readinessResult.data;
    unknowns.push(...readinessResult.data.warnings);
  } else {
    unknowns.push(`Could not resolve readiness score: ${readinessResult.error.message}`);
  }

  // Full structured risk results — probability, impact, numeric score,
  // computed band, and stored-severity consistency — via the same
  // calculateRiskScore() every other caller uses, not a hand-rolled
  // severity/status-only summary. See docs/DECISIONS.md.
  const riskScores: RiskScoreResult[] = [];
  for (const risk of componentRisks) {
    const riskResult = await calculateRiskScore(risk.id);
    if (riskResult.ok) {
      riskScores.push(riskResult.data);
      addItem(
        "RISK",
        risk.id,
        `${risk.title} — score ${riskResult.data.score} (${riskResult.data.computedBand})` +
          `, stored severity ${riskResult.data.storedSeverity}` +
          `${riskResult.data.severityConsistent ? "" : " [inconsistent with computed band]"}` +
          `, status ${riskResult.data.status}`,
      );
    } else {
      unknowns.push(`Could not resolve risk score for "${risk.id}": ${riskResult.error.message}`);
    }
  }

  const sortedEvidence = [...items.values()].sort((a, b) => {
    const typeDelta = (TYPE_ORDER.get(a.recordType) ?? 0) - (TYPE_ORDER.get(b.recordType) ?? 0);
    return typeDelta !== 0 ? typeDelta : a.recordId.localeCompare(b.recordId);
  });

  const { evidence: boundedEvidence, truncationNotes } = applyEvidenceBounds(sortedEvidence);
  unknowns.push(...truncationNotes);

  const untrustedNotes: string[] = [];
  const untrustedText = {
    reason: truncateUntrustedField(event.reason, "reason", untrustedNotes),
    rawNotes: truncateUntrustedField(event.rawNotes, "rawNotes", untrustedNotes),
  };
  unknowns.push(...untrustedNotes);

  return ok({
    eventId: event.id,
    eventFacts,
    impactedRequirements,
    impactedMilestones,
    verificationGaps,
    relatedDefects,
    scheduleExposure: scheduleResult.ok ? scheduleResult.data : null,
    budgetExposure,
    riskScores,
    readinessScore,
    evidence: boundedEvidence,
    assumptions,
    unknowns: [...new Set(unknowns)],
    untrustedText,
  });
}
