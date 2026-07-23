import type { Prisma } from "@prisma/client";
import type { RecordTypeValue } from "../record-types";
import { notFound, ok, type ServiceResult } from "../analysis/types";
import type { ProposedChangeInput } from "./schemas";

type TransactionClient = Prisma.TransactionClient;

/**
 * The server-generated snapshot for one proposed change: `oldValue` is
 * always built from the current database row (never the client), and
 * `newValue` is always built from the already-validated input (never
 * arbitrary Prisma output — only the allowlisted fields the caller actually
 * proposed). `oldValue`/`newValue` share the same key set for every
 * changeType except NEW_ACTION, so stale-data comparison (see stale.ts) can
 * walk `Object.keys(oldValue)` generically instead of switching on
 * changeType a second time. See docs/DECISIONS.md, "Phase 5 server-generated
 * proposed-change snapshots".
 */
export interface ProposedChangeSnapshot {
  changeType: ProposedChangeInput["changeType"];
  targetRecordId: string | null;
  targetRecordType: RecordTypeValue | null;
  oldValue: Record<string, unknown>;
  newValue: Record<string, unknown>;
}

function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Loads the record a proposed change targets, verifies it belongs to
 * `programId` (a nonexistent ID and an ID from another program produce the
 * identical NOT_FOUND, matching the same non-distinguishing pattern
 * recordProgramEvent() already uses), and builds the canonical old/new
 * value pair. Takes a transaction client so both recordMitigationDecision()
 * (decision time) and applyApprovedChanges() (apply time — the second,
 * authoritative read used for stale-data comparison) reuse the identical
 * snapshot-construction logic inside their own transactions.
 */
export async function buildProposedChangeSnapshot(
  tx: TransactionClient,
  input: ProposedChangeInput,
  programId: string,
): Promise<ServiceResult<ProposedChangeSnapshot>> {
  switch (input.changeType) {
    case "MILESTONE_DATE": {
      const milestone = await tx.milestone.findFirst({
        where: { id: input.targetRecordId, programId },
        select: { id: true, currentDate: true },
      });
      if (!milestone) return notFound("MILESTONE", input.targetRecordId);
      return ok({
        changeType: "MILESTONE_DATE",
        targetRecordId: milestone.id,
        targetRecordType: "MILESTONE",
        oldValue: { currentDate: formatDateOnly(milestone.currentDate) },
        newValue: { currentDate: input.currentDate },
      });
    }
    case "RISK_UPDATE": {
      const risk = await tx.risk.findFirst({
        where: { id: input.targetRecordId, programId },
        select: { id: true, status: true, severity: true, probability: true, impact: true },
      });
      if (!risk) return notFound("RISK", input.targetRecordId);

      const oldValue: Record<string, unknown> = {};
      const newValue: Record<string, unknown> = {};
      if (input.status !== undefined) {
        oldValue.status = risk.status;
        newValue.status = input.status;
      }
      if (input.severity !== undefined) {
        oldValue.severity = risk.severity;
        newValue.severity = input.severity;
      }
      if (input.probability !== undefined) {
        oldValue.probability = risk.probability;
        newValue.probability = input.probability;
      }
      if (input.impact !== undefined) {
        oldValue.impact = risk.impact;
        newValue.impact = input.impact;
      }
      return ok({
        changeType: "RISK_UPDATE",
        targetRecordId: risk.id,
        targetRecordType: "RISK",
        oldValue,
        newValue,
      });
    }
    case "BUDGET_UPDATE": {
      const budgetItem = await tx.budgetItem.findFirst({
        where: { id: input.targetRecordId, programId },
        select: { id: true, plannedAmount: true, actualAmount: true },
      });
      if (!budgetItem) return notFound("BUDGET_ITEM", input.targetRecordId);

      const oldValue: Record<string, unknown> = {};
      const newValue: Record<string, unknown> = {};
      if (input.plannedAmount !== undefined) {
        oldValue.plannedAmount = budgetItem.plannedAmount.toFixed(2);
        newValue.plannedAmount = input.plannedAmount;
      }
      if (input.actualAmount !== undefined) {
        oldValue.actualAmount = budgetItem.actualAmount.toFixed(2);
        newValue.actualAmount = input.actualAmount;
      }
      return ok({
        changeType: "BUDGET_UPDATE",
        targetRecordId: budgetItem.id,
        targetRecordType: "BUDGET_ITEM",
        oldValue,
        newValue,
      });
    }
    case "NEW_ACTION": {
      // No existing record to target or load — {} is the safe, fixed old
      // value (see docs/DECISIONS.md), and the durable payload is the
      // ProposedChange row's own newValue, per the MVP representation
      // decision (no separate ActionItem model).
      return ok({
        changeType: "NEW_ACTION",
        targetRecordId: null,
        targetRecordType: null,
        oldValue: {},
        newValue: {
          title: input.title,
          description: input.description,
          dueDate: input.dueDate,
        },
      });
    }
  }
}
