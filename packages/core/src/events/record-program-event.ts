import { randomUUID } from "node:crypto";
import { prisma } from "../db";
import { PROGRAM_ID } from "../seed/ids";
import { utcDayDifference } from "../analysis/schedule";
import { ok, notFound, validationError, forbidden, type ServiceResult } from "../analysis/types";
import { eventEntrySchema, formatEventEntryZodError, type EventEntryInput } from "./schemas";

export interface RecordedProgramEvent {
  eventId: string;
  traceId: string;
  eventType: EventEntryInput["eventType"];
  componentId: string | null;
  supplierId: string | null;
  delayDays: number | null;
}

/**
 * Transactionally records a ProgramEvent and its matching EVENT_RECORDED
 * AuditEvent — the only audit mutation Phase 3 performs (SPEC.md's
 * append-only audit rule: no update/delete path exists for AuditEvent
 * anywhere in this codebase). See docs/DECISIONS.md, "Event/audit
 * transaction", for the full authorization and rollback design.
 *
 * `actorUserId` must come from the authenticated session at the server
 * boundary — never from form data — and is independently re-verified
 * against the database here (current existence, current role), never
 * trusted from a client-supplied value or a possibly-stale JWT claim.
 */
export async function recordProgramEvent(
  rawInput: unknown,
  actorUserId: string,
): Promise<ServiceResult<RecordedProgramEvent>> {
  if (!actorUserId || typeof actorUserId !== "string") {
    return forbidden("Invalid session.");
  }

  const parsed = eventEntrySchema.safeParse(rawInput);
  if (!parsed.success) {
    return validationError(formatEventEntryZodError(parsed.error));
  }
  const data = parsed.data;

  // Re-fetched fresh from the database on every call — never trust a role
  // claim cached in a JWT, which could be stale if an admin changed this
  // user's role after the session was issued. A missing actor (deleted
  // since the session was issued) and a wrong role are both FORBIDDEN,
  // not NOT_FOUND: from the caller's perspective, both are "you may not do
  // this," not "this record doesn't exist."
  const actor = await prisma.user.findUnique({
    where: { id: actorUserId },
    select: { id: true, role: true },
  });
  if (!actor) {
    return forbidden("Your session is no longer valid. Please sign in again.");
  }
  if (actor.role !== "PROGRAM_MANAGER") {
    return forbidden("Only a Program Manager may record a program event.");
  }

  // Matching both id and programId in one query, rather than checking
  // existence and program membership separately, means "doesn't exist"
  // and "exists in a different program" produce the identical NOT_FOUND
  // response — deliberately not distinguished, so this endpoint can never
  // be used to probe whether a given ID exists in some other program.
  if (data.componentId) {
    const component = await prisma.component.findFirst({
      where: { id: data.componentId, programId: PROGRAM_ID },
      select: { id: true },
    });
    if (!component) return notFound("COMPONENT", data.componentId);
  }
  if (data.supplierId) {
    const supplier = await prisma.supplier.findFirst({
      where: { id: data.supplierId, programId: PROGRAM_ID },
      select: { id: true },
    });
    if (!supplier) return notFound("SUPPLIER", data.supplierId);
  }

  // Authoritative, server-computed delay — a client-supplied delayDays was
  // never part of the input contract in the first place (eventEntrySchema
  // has no such field, and is `.strict()`), so there is nothing to ignore
  // here; this is simply where the real value comes from.
  const delayDays =
    data.eventType === "SUPPLIER_DELAY"
      ? utcDayDifference(new Date(data.originalDate), new Date(data.revisedDate))
      : null;

  const eventId = `EVT-${randomUUID()}`;
  const traceId = randomUUID();

  const isSupplierDelay = data.eventType === "SUPPLIER_DELAY";

  const created = await prisma.$transaction(async (tx) => {
    const event = await tx.programEvent.create({
      data: {
        id: eventId,
        programId: PROGRAM_ID,
        eventType: data.eventType,
        componentId: data.componentId ?? null,
        supplierId: data.supplierId ?? null,
        originalDate: isSupplierDelay ? new Date(data.originalDate) : null,
        revisedDate: isSupplierDelay ? new Date(data.revisedDate) : null,
        delayDays,
        reason: isSupplierDelay ? (data.reason ?? null) : null,
        confidence: isSupplierDelay ? data.confidence : null,
        quantity: isSupplierDelay ? data.quantity : null,
        rawNotes: data.rawNotes ?? null,
        createdById: actor.id,
      },
    });

    // Safe, structured fields only — see docs/DECISIONS.md, "Audit payload
    // redaction": full reason/rawNotes text never enters the audit trail,
    // only whether each was supplied.
    await tx.auditEvent.create({
      data: {
        traceId,
        actorUserId: actor.id,
        actorType: "USER",
        action: "EVENT_RECORDED",
        targetRecordId: event.id,
        targetRecordType: "PROGRAM_EVENT",
        afterValue: {
          eventType: event.eventType,
          componentId: event.componentId,
          supplierId: event.supplierId,
          originalDate: isSupplierDelay ? data.originalDate : null,
          revisedDate: isSupplierDelay ? data.revisedDate : null,
          computedDelayDays: delayDays,
          confidence: isSupplierDelay ? data.confidence : null,
          quantity: isSupplierDelay ? data.quantity : null,
          hasReason: isSupplierDelay ? Boolean(data.reason) : false,
          hasRawNotes: Boolean(data.rawNotes),
        },
      },
    });

    return event;
  });

  return ok({
    eventId: created.id,
    traceId,
    eventType: data.eventType,
    componentId: created.componentId,
    supplierId: created.supplierId,
    delayDays: created.delayDays,
  });
}
