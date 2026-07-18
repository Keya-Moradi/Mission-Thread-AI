import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { entityIdSchema } from "./schemas";
import { notFound, ok, validationError, type ServiceResult } from "./types";

// Sign convention throughout this module: varianceAmount = actual - planned
// (positive = overrun, negative = underrun). All arithmetic uses
// Prisma.Decimal (decimal.js), never plain `number`, so cents can't drift
// from binary floating-point rounding — see docs/DECISIONS.md.

export interface CurrencyBudgetTotals {
  currency: string;
  plannedTotal: string;
  actualTotal: string;
  varianceAmount: string;
  variancePercentage: number | null;
  budgetItemIds: string[];
}

export interface BudgetVarianceResult {
  programId: string;
  /** null only when budget items span more than one currency — see byCurrency. */
  currency: string | null;
  plannedTotal: string | null;
  actualTotal: string | null;
  varianceAmount: string | null;
  variancePercentage: number | null;
  contributingBudgetItemIds: string[];
  byCurrency: CurrencyBudgetTotals[];
  missingData: string[];
}

export interface BudgetItemLike {
  id: string;
  plannedAmount: Prisma.Decimal;
  actualAmount: Prisma.Decimal;
}

/**
 * Pure decimal arithmetic, unit-testable without a database — see
 * docs/DECISIONS.md for the actual-minus-planned sign convention.
 */
export function sumCurrencyGroup(
  currency: string,
  items: readonly BudgetItemLike[],
): CurrencyBudgetTotals {
  const plannedTotal = items.reduce(
    (sum, item) => sum.plus(item.plannedAmount),
    new Prisma.Decimal(0),
  );
  const actualTotal = items.reduce(
    (sum, item) => sum.plus(item.actualAmount),
    new Prisma.Decimal(0),
  );
  const varianceAmount = actualTotal.minus(plannedTotal);
  const variancePercentage = plannedTotal.isZero()
    ? null
    : varianceAmount.dividedBy(plannedTotal).times(100).toNumber();

  return {
    currency,
    plannedTotal: plannedTotal.toFixed(2),
    actualTotal: actualTotal.toFixed(2),
    varianceAmount: varianceAmount.toFixed(2),
    variancePercentage,
    budgetItemIds: items.map((i) => i.id).sort(),
  };
}

export async function calculateBudgetVariance(
  programId: string,
): Promise<ServiceResult<BudgetVarianceResult>> {
  const parsed = entityIdSchema.safeParse(programId);
  if (!parsed.success) {
    return validationError(parsed.error.issues.map((issue) => issue.message).join("; "));
  }

  const program = await prisma.program.findUnique({
    where: { id: parsed.data },
    select: { id: true },
  });
  if (!program) {
    return notFound("PROGRAM", parsed.data);
  }

  const items = await prisma.budgetItem.findMany({
    where: { programId: parsed.data },
    select: { id: true, plannedAmount: true, actualAmount: true, currency: true },
  });

  if (items.length === 0) {
    return ok({
      programId: parsed.data,
      currency: null,
      plannedTotal: null,
      actualTotal: null,
      varianceAmount: null,
      variancePercentage: null,
      contributingBudgetItemIds: [],
      byCurrency: [],
      missingData: [`No budget items found for program "${parsed.data}".`],
    });
  }

  const groups = new Map<string, BudgetItemLike[]>();
  for (const item of items) {
    const group = groups.get(item.currency) ?? [];
    group.push(item);
    groups.set(item.currency, group);
  }

  const byCurrency = [...groups.entries()]
    .map(([currency, groupItems]) => sumCurrencyGroup(currency, groupItems))
    .sort((a, b) => a.currency.localeCompare(b.currency));

  const missingData: string[] = [];
  const singleCurrency = byCurrency.length === 1 ? byCurrency[0]! : null;
  if (byCurrency.length > 1) {
    missingData.push(
      `Budget items span multiple currencies (${byCurrency.map((g) => g.currency).join(", ")}); a single total cannot be computed — see byCurrency.`,
    );
  }
  for (const group of byCurrency) {
    if (group.variancePercentage === null) {
      missingData.push(
        `Planned total is zero for currency ${group.currency}; variance percentage is undefined.`,
      );
    }
  }

  return ok({
    programId: parsed.data,
    currency: singleCurrency?.currency ?? null,
    plannedTotal: singleCurrency?.plannedTotal ?? null,
    actualTotal: singleCurrency?.actualTotal ?? null,
    varianceAmount: singleCurrency?.varianceAmount ?? null,
    variancePercentage: singleCurrency?.variancePercentage ?? null,
    contributingBudgetItemIds: items.map((i) => i.id).sort(),
    byCurrency,
    missingData,
  });
}

export interface ExposedBudgetItem {
  budgetItemId: string;
  category: string;
  plannedAmount: string;
  actualAmount: string;
  varianceAmount: string;
  currency: string;
}

export interface BudgetExposureResult {
  eventId: string;
  componentId: string | null;
  currency: string | null;
  exposedBudgetItems: ExposedBudgetItem[];
  totalPlanned: string | null;
  totalActual: string | null;
  currentVarianceTotal: string | null;
  /**
   * The total budget tied to the affected component — i.e. the amount
   * actually at risk from this event — not a calculated incremental delay
   * cost. See docs/DECISIONS.md: no schema field supports the latter.
   */
  totalDeterministicExposure: string | null;
  exposureBasis: string;
  missingData: string[];
}

const NO_INCREMENTAL_COST_NOTE =
  "This schema has no per-day or per-unit cost-impact field, so no new incremental delay cost can be deterministically calculated from this event alone (see docs/DECISIONS.md).";

export async function calculateBudgetExposure(
  eventId: string,
): Promise<ServiceResult<BudgetExposureResult>> {
  const parsed = entityIdSchema.safeParse(eventId);
  if (!parsed.success) {
    return validationError(parsed.error.issues.map((issue) => issue.message).join("; "));
  }

  const event = await prisma.programEvent.findUnique({
    where: { id: parsed.data },
    select: { id: true, componentId: true },
  });
  if (!event) {
    return notFound("PROGRAM_EVENT", parsed.data);
  }

  if (!event.componentId) {
    return ok({
      eventId: parsed.data,
      componentId: null,
      currency: null,
      exposedBudgetItems: [],
      totalPlanned: null,
      totalActual: null,
      currentVarianceTotal: null,
      totalDeterministicExposure: null,
      exposureBasis: "Event has no linked component; no budget items can be identified.",
      missingData: [NO_INCREMENTAL_COST_NOTE, "Event has no linked component."],
    });
  }

  const items = await prisma.budgetItem.findMany({
    where: { componentId: event.componentId },
    select: { id: true, category: true, plannedAmount: true, actualAmount: true, currency: true },
  });

  const exposureBasis = `Budget items directly linked to component "${event.componentId}".`;

  if (items.length === 0) {
    return ok({
      eventId: parsed.data,
      componentId: event.componentId,
      currency: null,
      exposedBudgetItems: [],
      totalPlanned: null,
      totalActual: null,
      currentVarianceTotal: null,
      totalDeterministicExposure: null,
      exposureBasis,
      missingData: [
        NO_INCREMENTAL_COST_NOTE,
        `No budget items found for component "${event.componentId}".`,
      ],
    });
  }

  const exposedBudgetItems: ExposedBudgetItem[] = items
    .map((item) => ({
      budgetItemId: item.id,
      category: item.category,
      plannedAmount: item.plannedAmount.toFixed(2),
      actualAmount: item.actualAmount.toFixed(2),
      varianceAmount: item.actualAmount.minus(item.plannedAmount).toFixed(2),
      currency: item.currency,
    }))
    .sort((a, b) => a.budgetItemId.localeCompare(b.budgetItemId));

  const currencies = new Set(items.map((i) => i.currency));
  if (currencies.size > 1) {
    return ok({
      eventId: parsed.data,
      componentId: event.componentId,
      currency: null,
      exposedBudgetItems,
      totalPlanned: null,
      totalActual: null,
      currentVarianceTotal: null,
      totalDeterministicExposure: null,
      exposureBasis,
      missingData: [
        NO_INCREMENTAL_COST_NOTE,
        `Exposed budget items span multiple currencies (${[...currencies].sort().join(", ")}); totals cannot be combined.`,
      ],
    });
  }

  const totalPlanned = items.reduce(
    (sum, item) => sum.plus(item.plannedAmount),
    new Prisma.Decimal(0),
  );
  const totalActual = items.reduce(
    (sum, item) => sum.plus(item.actualAmount),
    new Prisma.Decimal(0),
  );
  const currentVarianceTotal = totalActual.minus(totalPlanned);

  return ok({
    eventId: parsed.data,
    componentId: event.componentId,
    currency: [...currencies][0]!,
    exposedBudgetItems,
    totalPlanned: totalPlanned.toFixed(2),
    totalActual: totalActual.toFixed(2),
    currentVarianceTotal: currentVarianceTotal.toFixed(2),
    totalDeterministicExposure: totalPlanned.toFixed(2),
    exposureBasis,
    missingData: [NO_INCREMENTAL_COST_NOTE],
  });
}
