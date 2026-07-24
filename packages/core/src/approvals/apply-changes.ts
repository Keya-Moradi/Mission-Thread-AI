import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
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
import { parsePersistedProposedChange, type PersistedProposedChange } from "./persisted-schemas";
import { validateNoOverlappingPersistedProposedChanges } from "./overlap";

type TransactionClient = Prisma.TransactionClient;

export interface AppliedChangesResult {
  mitigationOptionId: string;
  decisionId: string;
  appliedProposedChangeIds: string[];
  appliedAt: string;
  traceId: string;
}

/**
 * Applies one proposed change's domain mutation — only the allowlisted
 * fields the change actually proposed, never a wholesale record overwrite.
 * Takes the already-Zod-validated persisted shape, never the raw database
 * row: `change.targetRecordId` is a real `string` (not `string | null`)
 * for every branch that needs it, and `change.newValue` is a typed,
 * allowlisted-field object — no non-null assertion or `as`-cast stands in
 * for runtime validation anywhere in this function. NEW_ACTION never
 * mutates a domain table at all: the ProposedChange row itself is the
 * durable action record for this MVP (see docs/DECISIONS.md, "Phase 5
 * NEW_ACTION representation").
 */
async function applyDomainMutation(
  tx: TransactionClient,
  change: PersistedProposedChange,
): Promise<void> {
  switch (change.changeType) {
    case "MILESTONE_DATE": {
      await tx.milestone.update({
        where: { id: change.targetRecordId },
        data: { currentDate: new Date(change.newValue.currentDate) },
      });
      return;
    }
    case "RISK_UPDATE": {
      await tx.risk.update({
        where: { id: change.targetRecordId },
        data: change.newValue,
      });
      return;
    }
    case "BUDGET_UPDATE": {
      await tx.budgetItem.update({
        where: { id: change.targetRecordId },
        data: change.newValue,
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
      const pendingChanges = await tx.proposedChange.findMany({
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

      // 5a. Revalidate every stored row before any stale check or domain
      // mutation. Decision-time validation is the normal boundary for what
      // gets written in the first place, but this irreversible apply
      // transaction must fail closed if a stored row is malformed or
      // inconsistent — a TypeScript type is not a runtime guarantee about
      // what's actually in the database. See docs/DECISIONS.md, "Phase 5
      // correction: apply-time persisted-snapshot revalidation".
      const parsedChanges: { id: string; persisted: PersistedProposedChange }[] = [];
      for (const change of pendingChanges) {
        const parseResult = parsePersistedProposedChange(change);
        if (!parseResult.ok) {
          return validationError<AppliedChangesResult>(
            `Stored proposed change ${change.id} cannot be applied: ${parseResult.message}.`,
          );
        }
        parsedChanges.push({ id: change.id, persisted: parseResult.data });
      }

      // 5b. Reject a stored batch where two rows write the same field on
      // the same record — the same order-dependence problem
      // validateNoOverlappingProposedChanges() prevents at decision time,
      // reverified here in case the stored batch was ever assembled or
      // edited outside that path.
      const overlapCheck = validateNoOverlappingPersistedProposedChanges(
        parsedChanges.map((c) => c.persisted),
      );
      if (!overlapCheck.ok) {
        return overlapCheck as ServiceResult<AppliedChangesResult>;
      }

      const programId = option.impactAnalysis.programEvent.programId;

      // 6/7/8. Reload every target and compare against the stored oldValue.
      // Abort the entire batch on any single conflict — never a partial
      // apply (see docs/DECISIONS.md, "Phase 5 all-or-nothing behavior").
      for (const { id, persisted } of parsedChanges) {
        const staleCheck = await checkProposedChangeStale(
          tx,
          {
            changeType: persisted.changeType,
            targetRecordId: persisted.targetRecordId,
            oldValue: persisted.oldValue,
          },
          programId,
        );
        if (staleCheck.stale) {
          return conflict<AppliedChangesResult>(
            persisted.targetRecordType ?? "PROPOSED_CHANGE",
            persisted.targetRecordId ?? id,
            `Proposed change ${id} (${persisted.changeType}) is stale — the underlying record has changed since this decision was approved. Request a new decision instead of applying this one.`,
          );
        }
      }

      // 9. Apply every domain mutation. No AI or network request runs
      // inside this transaction.
      for (const { persisted } of parsedChanges) {
        await applyDomainMutation(tx, persisted);
      }

      // 10/11. Mark every proposed change APPLIED with the same appliedAt —
      // conditional on status = PENDING, the atomic concurrency claim
      // described in the function doc comment above.
      const claim = await tx.proposedChange.updateMany({
        where: { id: { in: parsedChanges.map((c) => c.id) }, status: "PENDING" },
        data: { status: "APPLIED", appliedAt },
      });
      if (claim.count !== parsedChanges.length) {
        throw new Error("proposed-change-apply-conflict");
      }

      // 12. One CHANGES_APPLIED audit event, linked to the decision. Bounded
      // structured payload only — before/after values are the same safe,
      // already-normalized, now-revalidated old/new snapshots persisted on
      // each ProposedChange row, never raw provider output or untrusted
      // text.
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
            proposedChangeIds: parsedChanges.map((c) => c.id),
            changeTypes: parsedChanges.map((c) => c.persisted.changeType),
            targetRecordIds: parsedChanges.map((c) => c.persisted.targetRecordId),
            targetRecordTypes: parsedChanges.map((c) => c.persisted.targetRecordType),
            beforeValues: parsedChanges.map((c) => c.persisted.oldValue) as Prisma.InputJsonValue,
            afterValues: parsedChanges.map((c) => c.persisted.newValue) as Prisma.InputJsonValue,
            appliedByUserId: actor.id,
            appliedAt: appliedAt.toISOString(),
          },
        },
      });

      return ok<AppliedChangesResult>({
        mitigationOptionId: option.id,
        decisionId: decision.id,
        appliedProposedChangeIds: parsedChanges.map((c) => c.id),
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
