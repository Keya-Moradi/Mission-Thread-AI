import { prisma } from "../db";
import { entityIdSchema } from "./schemas";
import { notFound, ok, validationError, type ServiceResult } from "./types";
import { getImpactedMilestones } from "./traceability";

const MS_PER_DAY = 86_400_000;

/**
 * Pure UTC calendar-day arithmetic, unit-testable without a database. Every
 * date this schema stores is date-only (e.g. `new Date("2026-09-15")`,
 * which JS parses as UTC midnight), so a plain millisecond difference
 * divided by a day's worth of milliseconds gives an exact day count with no
 * local-timezone drift — see docs/DECISIONS.md.
 */
export function utcDayDifference(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / MS_PER_DAY);
}

export function addUtcDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface ScheduleExposureResult {
  eventId: string;
  originalDate: string | null;
  revisedDate: string | null;
  /** Computed from revisedDate - originalDate; null if either date is missing. */
  directDelayDays: number | null;
  /** The event's own stored delayDays field, as-is. */
  storedDelayDays: number | null;
  /** null when directDelayDays or storedDelayDays is unavailable to compare. */
  delayDaysConsistent: boolean | null;
  directMilestoneIds: string[];
  dependencyDerivedMilestoneIds: string[];
  impactedMilestoneIds: string[];
  /** max(milestone.plannedDate + directDelayDays) across every impacted milestone. */
  latestExposedDate: string | null;
  missingData: string[];
}

export async function calculateScheduleExposure(
  eventId: string,
): Promise<ServiceResult<ScheduleExposureResult>> {
  const parsed = entityIdSchema.safeParse(eventId);
  if (!parsed.success) {
    return validationError(parsed.error.issues.map((issue) => issue.message).join("; "));
  }

  const event = await prisma.programEvent.findUnique({
    where: { id: parsed.data },
    select: { id: true, componentId: true, originalDate: true, revisedDate: true, delayDays: true },
  });
  if (!event) {
    return notFound("PROGRAM_EVENT", parsed.data);
  }

  const missingData: string[] = [];

  const directDelayDays =
    event.originalDate && event.revisedDate
      ? utcDayDifference(event.originalDate, event.revisedDate)
      : null;
  if (!event.originalDate || !event.revisedDate) {
    missingData.push(
      "Event is missing originalDate and/or revisedDate; directDelayDays cannot be computed.",
    );
  }

  const storedDelayDays = event.delayDays ?? null;
  if (storedDelayDays === null) {
    missingData.push("Event has no stored delayDays value.");
  }

  const delayDaysConsistent =
    directDelayDays === null || storedDelayDays === null
      ? null
      : directDelayDays === storedDelayDays;
  if (delayDaysConsistent === false) {
    missingData.push(
      `Stored delayDays (${storedDelayDays}) disagrees with the date-computed delay (${directDelayDays}); dates are treated as authoritative.`,
    );
  }

  let directMilestoneIds: string[] = [];
  let dependencyDerivedMilestoneIds: string[] = [];
  let impactedMilestones: Array<{ milestoneId: string; plannedDate: string }> = [];

  if (!event.componentId) {
    missingData.push("Event has no linked component; no impacted milestones can be identified.");
  } else {
    const impactResult = await getImpactedMilestones(event.componentId);
    if (impactResult.ok) {
      directMilestoneIds = impactResult.data
        .filter((m) => m.relationship === "direct")
        .map((m) => m.milestoneId)
        .sort();
      dependencyDerivedMilestoneIds = impactResult.data
        .filter((m) => m.relationship === "dependency-derived")
        .map((m) => m.milestoneId)
        .sort();
      impactedMilestones = impactResult.data.map((m) => ({
        milestoneId: m.milestoneId,
        plannedDate: m.plannedDate,
      }));
    } else {
      missingData.push(`Could not resolve impacted milestones: ${impactResult.error.message}`);
    }
  }

  let latestExposedDate: string | null = null;
  if (directDelayDays === null) {
    missingData.push("latestExposedDate cannot be computed without directDelayDays.");
  } else if (impactedMilestones.length === 0) {
    missingData.push("latestExposedDate cannot be computed: no impacted milestones were found.");
  } else {
    const exposedDates = impactedMilestones.map((m) =>
      addUtcDays(new Date(m.plannedDate), directDelayDays),
    );
    latestExposedDate = toIsoDate(new Date(Math.max(...exposedDates.map((d) => d.getTime()))));
  }

  return ok({
    eventId: parsed.data,
    originalDate: event.originalDate ? toIsoDate(event.originalDate) : null,
    revisedDate: event.revisedDate ? toIsoDate(event.revisedDate) : null,
    directDelayDays,
    storedDelayDays,
    delayDaysConsistent,
    directMilestoneIds,
    dependencyDerivedMilestoneIds,
    impactedMilestoneIds: [...directMilestoneIds, ...dependencyDerivedMilestoneIds].sort(),
    latestExposedDate,
    missingData,
  });
}
