import type { Prisma, ProposedChangeType } from "@prisma/client";

type TransactionClient = Prisma.TransactionClient;

function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Reloads only the fields a stored proposed change's `oldValue` actually
 * captured (never more), using the identical normalized representation
 * buildProposedChangeSnapshot() used when the value was first captured —
 * UTC date-only strings, fixed-two-decimal monetary strings, Prisma enum
 * strings, plain risk numbers — so a value that hasn't really changed can
 * never register as stale merely from a representation mismatch. Returns
 * `null` if the target record no longer exists or no longer belongs to this
 * program (itself a form of staleness — the caller below treats a missing
 * target as "every captured field changed").
 */
async function loadCurrentComparableValue(
  tx: TransactionClient,
  changeType: ProposedChangeType,
  targetRecordId: string | null,
  programId: string,
  keys: string[],
): Promise<Record<string, unknown> | null> {
  switch (changeType) {
    case "MILESTONE_DATE": {
      if (!targetRecordId) return null;
      const milestone = await tx.milestone.findFirst({
        where: { id: targetRecordId, programId },
        select: { currentDate: true },
      });
      if (!milestone) return null;
      return { currentDate: formatDateOnly(milestone.currentDate) };
    }
    case "RISK_UPDATE": {
      if (!targetRecordId) return null;
      const risk = await tx.risk.findFirst({
        where: { id: targetRecordId, programId },
        select: { status: true, severity: true, probability: true, impact: true },
      });
      if (!risk) return null;
      const result: Record<string, unknown> = {};
      const riskFields: Record<string, unknown> = risk;
      for (const key of keys) {
        if (key in riskFields) result[key] = riskFields[key];
      }
      return result;
    }
    case "BUDGET_UPDATE": {
      if (!targetRecordId) return null;
      const budgetItem = await tx.budgetItem.findFirst({
        where: { id: targetRecordId, programId },
        select: { plannedAmount: true, actualAmount: true },
      });
      if (!budgetItem) return null;
      const result: Record<string, unknown> = {};
      if (keys.includes("plannedAmount"))
        result.plannedAmount = budgetItem.plannedAmount.toFixed(2);
      if (keys.includes("actualAmount")) result.actualAmount = budgetItem.actualAmount.toFixed(2);
      return result;
    }
    case "NEW_ACTION":
      // No existing target — {} always matches the stored {} oldValue, so
      // a NEW_ACTION proposed change can never be stale.
      return {};
  }
}

export interface StaleCheckResult {
  stale: boolean;
  /** The target record no longer exists, or no longer belongs to this program. */
  targetMissing: boolean;
  /** Which captured field(s) disagree with the current database value — empty when not stale. */
  changedFields: string[];
}

/**
 * Compares a persisted ProposedChange's captured `oldValue` against the
 * record's *current* database value, at both preview and apply time — see
 * docs/DECISIONS.md, "Phase 5 stale-data conflict detection". Never
 * silently overwrites: the caller (the apply-preview route, and
 * applyApprovedChanges()) is responsible for blocking on `stale: true`.
 */
export async function checkProposedChangeStale(
  tx: TransactionClient,
  proposedChange: {
    changeType: ProposedChangeType;
    targetRecordId: string | null;
    oldValue: unknown;
  },
  programId: string,
): Promise<StaleCheckResult> {
  const storedOldValue = (proposedChange.oldValue ?? {}) as Record<string, unknown>;
  const keys = Object.keys(storedOldValue);

  const current = await loadCurrentComparableValue(
    tx,
    proposedChange.changeType,
    proposedChange.targetRecordId,
    programId,
    keys,
  );

  if (current === null) {
    return { stale: keys.length > 0, targetMissing: true, changedFields: keys };
  }

  const changedFields = keys.filter((key) => storedOldValue[key] !== current[key]);
  return { stale: changedFields.length > 0, targetMissing: false, changedFields };
}
