import { randomUUID } from "node:crypto";
import type { Prisma, ProposedChangeType, RecordType } from "@prisma/client";
import { prisma } from "../db";
import { entityIdSchema } from "../analysis/schemas";
import {
  ok,
  notFound,
  validationError,
  forbidden,
  conflict,
  type ServiceResult,
} from "../analysis/types";
import { checkProposedChangeStale } from "./stale";
import { applyConfirmationSchema } from "./schemas";

type TransactionClient = Prisma.TransactionClient;

export interface AppliedChangesResult {
  mitigationOptionId: string;
  decisionId: string;
  appliedProposedChangeIds: string[];
  appliedAt: string;
  traceId: string;
}

interface PendingProposedChangeRow {
  id: string;
  changeType: ProposedChangeType;
  targetRecordId: string | null;
  targetRecordType: RecordType | null;
  oldValue: unknown;
  newValue: unknown;
}

/**
 * Applies one proposed change's domain mutation — only the allowlisted
 * fields the change actually proposed, never a wholesale record overwrite.
 * NEW_ACTION never mutates a domain table at all: the ProposedChange row
 * itself is the durable action record for this MVP (see docs/DECISIONS.md,
 * "Phase 5 NEW_ACTION representation").
 */
async function applyDomainMutation(
  tx: TransactionClient,
  change: PendingProposedChangeRow,
): Promise<void> {
  const newValue = (change.newValue ?? {}) as Record<string, unknown>;

  switch (change.changeType) {
    case "MILESTONE_DATE": {
      await tx.milestone.update({
        where: { id: change.targetRecordId! },
        data: { currentDate: new Date(newValue.currentDate as string) },
      });
      return;
    }
    case "RISK_UPDATE": {
      const data: Record<string, unknown> = {};
      if ("status" in newValue) data.status = newValue.status;
      if ("severity" in newValue) data.severity = newValue.severity;
      if ("probability" in newValue) data.probability = newValue.probability;
      if ("impact" in newValue) data.impact = newValue.impact;
      await tx.risk.update({
        where: { id: change.targetRecordId! },
        data: data as Prisma.RiskUpdateInput,
      });
      return;
    }
    case "BUDGET_UPDATE": {
      const data: Record<string, unknown> = {};
      if ("plannedAmount" in newValue) data.plannedAmount = newValue.plannedAmount;
      if ("actualAmount" in newValue) data.actualAmount = newValue.actualAmount;
      await tx.budgetItem.update({
        where: { id: change.targetRecordId! },
        data: data as Prisma.BudgetItemUpdateInput,
      });
      return;
    }
    case "NEW_ACTION":
      return;
  }
}

/**
 * Transactional, all-or-nothing application of every PENDING proposed
 * change belonging to one APPROVED mitigation option — see
 * docs/DECISIONS.md, "Phase 5 apply transaction". `confirmation` must be
 * the exact literal string `"APPLY"`: the server never trusts a hidden
 * Boolean for an operation this irreversible.
 *
 * Idempotency: once every proposed change for this option is APPLIED, a
 * repeated call finds zero PENDING proposed changes and is rejected with no
 * mutation, no duplicate audit event, and no altered `appliedAt` — see
 * docs/DECISIONS.md, "Phase 5 idempotency and concurrency". Concurrency:
 * the final `proposedChange.updateMany(... WHERE status = 'PENDING')` is
 * the atomic claim — if two concurrent calls both pass every earlier check,
 * only the first can actually claim the PENDING rows; the second's claim
 * count comes back short, and its entire transaction (including any domain
 * mutations it already applied) is rolled back.
 */
export async function applyApprovedChanges(
  mitigationOptionId: string,
  actorUserId: string,
  confirmation: string,
): Promise<ServiceResult<AppliedChangesResult>> {
  if (!actorUserId || typeof actorUserId !== "string") {
    return forbidden("Invalid session.");
  }

  const idResult = entityIdSchema.safeParse(mitigationOptionId);
  if (!idResult.success) {
    return validationError(idResult.error.issues.map((issue) => issue.message).join("; "));
  }

  const confirmationResult = applyConfirmationSchema.safeParse(confirmation);
  if (!confirmationResult.success) {
    return validationError('An explicit "APPLY" confirmation is required to apply these changes.');
  }

  // Actor and role verified before the transaction even opens — an
  // unauthorized caller should never cause a transaction to be opened at
  // all, matching SPEC.md §5's "revalidate every actor from the database at
  // mutation time" rule.
  const actor = await prisma.user.findUnique({
    where: { id: actorUserId },
    select: { id: true, role: true },
  });
  if (!actor) {
    return forbidden("Your session is no longer valid. Please sign in again.");
  }
  if (actor.role !== "PROGRAM_MANAGER") {
    return forbidden("Only a Program Manager may apply approved changes.");
  }

  const traceId = randomUUID();
  const appliedAt = new Date();

  try {
    return await prisma.$transaction(async (tx) => {
      // 1/2. Reload the option; require APPROVED.
      const option = await tx.mitigationOption.findUnique({
        where: { id: idResult.data },
        select: {
          id: true,
          status: true,
          impactAnalysis: { select: { programEvent: { select: { programId: true } } } },
        },
      });
      if (!option) {
        return notFound<AppliedChangesResult>("MITIGATION_OPTION", idResult.data);
      }
      if (option.status !== "APPROVED") {
        return validationError<AppliedChangesResult>(
          `This mitigation option is not approved (current status: ${option.status}).`,
        );
      }

      // 3. Load the unique APPROVED decision.
      const decision = await tx.decision.findUnique({
        where: { mitigationOptionId: option.id },
        select: { id: true, verdict: true },
      });
      if (!decision || decision.verdict !== "APPROVED") {
        return validationError<AppliedChangesResult>(
          "No approved decision exists for this mitigation option.",
        );
      }

      // 4/5. Load all PENDING proposed changes; require at least one. Once
      // every change has already been applied, this naturally rejects a
      // repeated apply request — see the idempotency note above.
      const pendingChanges: PendingProposedChangeRow[] = await tx.proposedChange.findMany({
        where: { mitigationOptionId: option.id, status: "PENDING" },
        select: {
          id: true,
          changeType: true,
          targetRecordId: true,
          targetRecordType: true,
          oldValue: true,
          newValue: true,
        },
      });
      if (pendingChanges.length === 0) {
        return validationError<AppliedChangesResult>(
          "There are no pending proposed changes to apply for this mitigation option.",
        );
      }

      const programId = option.impactAnalysis.programEvent.programId;

      // 6/7/8. Reload every target and compare against the stored oldValue.
      // Abort the entire batch on any single conflict — never a partial
      // apply (see docs/DECISIONS.md, "Phase 5 all-or-nothing behavior").
      for (const change of pendingChanges) {
        const staleCheck = await checkProposedChangeStale(tx, change, programId);
        if (staleCheck.stale) {
          return conflict<AppliedChangesResult>(
            change.targetRecordType ?? "PROPOSED_CHANGE",
            change.targetRecordId ?? change.id,
            `Proposed change ${change.id} (${change.changeType}) is stale — the underlying record has changed since this decision was approved. Request a new decision instead of applying this one.`,
          );
        }
      }

      // 9. Apply every domain mutation. No AI or network request runs
      // inside this transaction.
      for (const change of pendingChanges) {
        await applyDomainMutation(tx, change);
      }

      // 10/11. Mark every proposed change APPLIED with the same appliedAt —
      // conditional on status = PENDING, the atomic concurrency claim
      // described in the function doc comment above.
      const claim = await tx.proposedChange.updateMany({
        where: { id: { in: pendingChanges.map((change) => change.id) }, status: "PENDING" },
        data: { status: "APPLIED", appliedAt },
      });
      if (claim.count !== pendingChanges.length) {
        throw new Error("proposed-change-apply-conflict");
      }

      // 12. One CHANGES_APPLIED audit event, linked to the decision. Bounded
      // structured payload only — before/after values are the same safe,
      // already-normalized old/new snapshots persisted on each
      // ProposedChange row, never raw provider output or untrusted text.
      await tx.auditEvent.create({
        data: {
          traceId,
          actorUserId: actor.id,
          actorType: "USER",
          action: "CHANGES_APPLIED",
          targetRecordId: option.id,
          targetRecordType: "MITIGATION_OPTION",
          decisionId: decision.id,
          afterValue: {
            mitigationOptionId: option.id,
            decisionId: decision.id,
            proposedChangeIds: pendingChanges.map((change) => change.id),
            changeTypes: pendingChanges.map((change) => change.changeType),
            targetRecordIds: pendingChanges.map((change) => change.targetRecordId),
            targetRecordTypes: pendingChanges.map((change) => change.targetRecordType),
            beforeValues: pendingChanges.map((change) => change.oldValue) as Prisma.InputJsonValue,
            afterValues: pendingChanges.map((change) => change.newValue) as Prisma.InputJsonValue,
            appliedByUserId: actor.id,
            appliedAt: appliedAt.toISOString(),
          },
        },
      });

      return ok<AppliedChangesResult>({
        mitigationOptionId: option.id,
        decisionId: decision.id,
        appliedProposedChangeIds: pendingChanges.map((change) => change.id),
        appliedAt: appliedAt.toISOString(),
        traceId,
      });
    });
  } catch (error) {
    if (error instanceof Error && error.message === "proposed-change-apply-conflict") {
      return conflict(
        "MITIGATION_OPTION",
        idResult.data,
        "These changes were already applied by a concurrent request.",
      );
    }
    throw error;
  }
}
