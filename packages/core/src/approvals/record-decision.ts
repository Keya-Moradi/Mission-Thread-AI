import { randomUUID } from "node:crypto";
import { Prisma, type Role } from "@prisma/client";
import { prisma } from "../db";
import {
  ok,
  notFound,
  validationError,
  forbidden,
  conflict,
  type ServiceResult,
} from "../analysis/types";
import { buildProposedChangeSnapshot, type ProposedChangeSnapshot } from "./snapshot";
import {
  recordDecisionInputSchema,
  formatApprovalsZodError,
  type RecordDecisionInput,
} from "./schemas";

export interface RecordedMitigationDecision {
  decisionId: string;
  mitigationOptionId: string;
  verdict: RecordDecisionInput["verdict"];
  traceId: string;
  proposedChangeIds: string[];
}

/**
 * Program Manager may approve, reject, or request revision (and later
 * apply). Engineering Lead may only request revision. Executive Viewer may
 * never mutate. Hiding buttons in the UI is never the actual boundary —
 * this is: every path that can reach recordMitigationDecision() re-checks
 * this against the actor's current database role. See docs/DECISIONS.md,
 * "Phase 5 decision permissions".
 */
function checkDecisionPermission(
  role: Role,
  verdict: RecordDecisionInput["verdict"],
): { allowed: true } | { allowed: false; message: string } {
  if (role === "PROGRAM_MANAGER") return { allowed: true };
  if (role === "ENGINEERING_LEAD") {
    if (verdict === "REVISION_REQUESTED") return { allowed: true };
    return {
      allowed: false,
      message: "Only a Program Manager may approve or reject a mitigation option.",
    };
  }
  return { allowed: false, message: "Executive Viewers may not record decisions." };
}

function isMitigationOptionDecisionConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002" &&
    Array.isArray(error.meta?.target) &&
    (error.meta.target as unknown[]).includes("mitigationOptionId")
  );
}

/**
 * Records one human decision (approve / reject / request-revision) on a
 * PENDING mitigation option, in one transaction — see docs/DECISIONS.md,
 * "Phase 5 decision transaction" for the full step list this mirrors.
 * `actorUserId` must come from the authenticated session at the caller's
 * boundary, never from form data, and is independently re-verified against
 * the database here — never trusted from a client-supplied value or a
 * possibly-stale session/JWT role claim.
 *
 * Concurrency: `Decision.mitigationOptionId` is `@unique` at the database
 * level, so if two concurrent calls somehow both pass the pre-checks below,
 * only the first `decision.create()` can ever succeed — the second fails
 * with a Postgres unique-constraint violation, caught here and reported as
 * `CONFLICT`, never as two decisions or a thrown, unhandled error. The
 * `MitigationOption.status` transition is additionally guarded by a
 * conditional `updateMany(... WHERE status = 'PENDING')` for the same
 * reason — see docs/DECISIONS.md, "Phase 5 state machine".
 */
export async function recordMitigationDecision(
  rawInput: unknown,
  actorUserId: string,
): Promise<ServiceResult<RecordedMitigationDecision>> {
  if (!actorUserId || typeof actorUserId !== "string") {
    return forbidden("Invalid session.");
  }

  const parsed = recordDecisionInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return validationError(formatApprovalsZodError(parsed.error));
  }
  const input = parsed.data;

  const traceId = randomUUID();
  const decisionId = `DEC-${randomUUID()}`;

  try {
    return await prisma.$transaction(async (tx) => {
      // 1. Load/revalidate actor — never trust a session/JWT role claim.
      const actor = await tx.user.findUnique({
        where: { id: actorUserId },
        select: { id: true, role: true },
      });
      if (!actor) {
        return forbidden<RecordedMitigationDecision>(
          "Your session is no longer valid. Please sign in again.",
        );
      }

      const permission = checkDecisionPermission(actor.role, input.verdict);
      if (!permission.allowed) {
        return forbidden<RecordedMitigationDecision>(permission.message);
      }

      // 2. Load the mitigation option and the program it belongs to (via
      // its parent analysis's triggering event).
      const option = await tx.mitigationOption.findUnique({
        where: { id: input.mitigationOptionId },
        select: {
          id: true,
          status: true,
          impactAnalysisId: true,
          impactAnalysis: { select: { programEvent: { select: { programId: true } } } },
        },
      });
      if (!option) {
        return notFound<RecordedMitigationDecision>("MITIGATION_OPTION", input.mitigationOptionId);
      }

      // 3. Confirm the option is still PENDING — no transition from a
      // terminal status is ever allowed (SPEC.md's approval state machine).
      if (option.status !== "PENDING") {
        return conflict<RecordedMitigationDecision>(
          "MITIGATION_OPTION",
          option.id,
          `This mitigation option already has a decision (current status: ${option.status}).`,
        );
      }

      // 4. Confirm no Decision already exists — a fast, friendly check on
      // top of the @unique constraint that's the actual concurrency
      // guarantee (see function doc comment above).
      const existingDecision = await tx.decision.findUnique({
        where: { mitigationOptionId: option.id },
        select: { id: true },
      });
      if (existingDecision) {
        return conflict<RecordedMitigationDecision>(
          "MITIGATION_OPTION",
          option.id,
          "This mitigation option already has a recorded decision.",
        );
      }

      const programId = option.impactAnalysis.programEvent.programId;

      // 6/7/8. Validate, load, and snapshot every proposed change —
      // approval only. Each snapshot independently verifies its target
      // belongs to this program and builds the canonical old/new values;
      // the client's own proposed values are never trusted or persisted
      // directly.
      const snapshots: ProposedChangeSnapshot[] = [];
      if (input.verdict === "APPROVED") {
        for (const changeInput of input.proposedChanges) {
          const snapshotResult = await buildProposedChangeSnapshot(tx, changeInput, programId);
          if (!snapshotResult.ok) {
            return snapshotResult as ServiceResult<RecordedMitigationDecision>;
          }
          snapshots.push(snapshotResult.data);
        }
      }

      // 9. Create the Decision row.
      const decision = await tx.decision.create({
        data: {
          id: decisionId,
          mitigationOptionId: option.id,
          actorUserId: actor.id,
          verdict: input.verdict,
          rationale: input.rationale,
          traceId,
        },
      });

      // 10. Transition the option's status — conditional on PENDING so an
      // unexpected race still can't silently transition an already-decided
      // option (defense in depth alongside the Decision unique constraint).
      const statusUpdate = await tx.mitigationOption.updateMany({
        where: { id: option.id, status: "PENDING" },
        data: { status: input.verdict },
      });
      if (statusUpdate.count === 0) {
        throw new Error("mitigation-option-status-conflict");
      }

      // 11. Create proposed changes — approval only.
      const createdProposedChanges: { id: string; changeType: string }[] = [];
      if (input.verdict === "APPROVED") {
        for (const snapshot of snapshots) {
          const proposedChange = await tx.proposedChange.create({
            data: {
              mitigationOptionId: option.id,
              changeType: snapshot.changeType,
              targetRecordId: snapshot.targetRecordId,
              targetRecordType: snapshot.targetRecordType,
              oldValue: snapshot.oldValue as Prisma.InputJsonValue,
              newValue: snapshot.newValue as Prisma.InputJsonValue,
            },
          });
          createdProposedChanges.push({
            id: proposedChange.id,
            changeType: proposedChange.changeType,
          });
        }
      }

      // 12. One DECISION_RECORDED audit event — safe structured metadata
      // only. The complete rationale text stays on the Decision row and is
      // never copied into the audit JSON (see docs/DECISIONS.md).
      await tx.auditEvent.create({
        data: {
          traceId,
          actorUserId: actor.id,
          actorType: "USER",
          action: "DECISION_RECORDED",
          targetRecordId: option.id,
          targetRecordType: "MITIGATION_OPTION",
          decisionId: decision.id,
          afterValue: {
            verdict: input.verdict,
            mitigationOptionId: option.id,
            analysisId: option.impactAnalysisId,
            proposedChangeIds: createdProposedChanges.map((c) => c.id),
            proposedChangeTypes: createdProposedChanges.map((c) => c.changeType),
            hasRationale: input.rationale.trim().length > 0,
          },
        },
      });

      return ok<RecordedMitigationDecision>({
        decisionId: decision.id,
        mitigationOptionId: option.id,
        verdict: input.verdict,
        traceId,
        proposedChangeIds: createdProposedChanges.map((c) => c.id),
      });
    });
  } catch (error) {
    if (isMitigationOptionDecisionConflict(error)) {
      return conflict(
        "MITIGATION_OPTION",
        input.mitigationOptionId,
        "This mitigation option already has a recorded decision.",
      );
    }
    if (error instanceof Error && error.message === "mitigation-option-status-conflict") {
      return conflict(
        "MITIGATION_OPTION",
        input.mitigationOptionId,
        "This mitigation option already has a recorded decision.",
      );
    }
    throw error;
  }
}
