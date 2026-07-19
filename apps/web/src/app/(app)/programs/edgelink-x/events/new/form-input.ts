// Pure FormData-to-raw-input adapter for the event-entry server action.
// Deliberately outside the "use server" actions.ts file so it's directly
// unit-testable without a server-action runtime, and so its branching
// logic is visibly separate from the authorization/mutation code around it.
//
// The critical invariant this module exists to enforce: only the exact
// discriminator "GENERAL_UPDATE" may ever produce a general-update
// candidate, and only the exact discriminator "SUPPLIER_DELAY" may ever
// produce a supplier-delay candidate. Any other value — an unrecognized
// string, a missing field, a non-string FormData entry (e.g. a File) — is
// preserved as-is (or reduced to an empty string, for non-string values,
// which is equally not a valid discriminator) and handed to
// eventEntrySchema to reject. Silently defaulting an invalid discriminator
// to GENERAL_UPDATE would let a malformed request be recorded as if it
// were a legitimate general update — see docs/DECISIONS.md.

function toRequiredStringField(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function toOptionalStringField(value: FormDataEntryValue | null): string | undefined {
  const trimmed = toRequiredStringField(value);
  return trimmed.length > 0 ? trimmed : undefined;
}

function toQuantityField(value: FormDataEntryValue | null): number | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Reads only the fields the matched event type's contract actually uses —
 * never a client-supplied delayDays, actorUserId, or programId, none of
 * which this form even has inputs for. eventEntrySchema's `.strict()`
 * would reject any of those anyway, but they're not read from formData at
 * all as the first line of defense.
 */
export function buildEventEntryInputFromFormData(formData: FormData): unknown {
  const rawEventType = formData.get("eventType");
  // A non-string value (a File, or the field simply absent — formData.get
  // returns null) can never be a valid discriminator; normalized to an
  // empty string so the fallthrough below still hands eventEntrySchema
  // something to reject, rather than an unrepresentable non-string value.
  const eventType = typeof rawEventType === "string" ? rawEventType : "";

  if (eventType === "SUPPLIER_DELAY") {
    return {
      eventType: "SUPPLIER_DELAY",
      componentId: toRequiredStringField(formData.get("componentId")),
      supplierId: toRequiredStringField(formData.get("supplierId")),
      originalDate: toRequiredStringField(formData.get("originalDate")),
      revisedDate: toRequiredStringField(formData.get("revisedDate")),
      confidence: toRequiredStringField(formData.get("confidence")),
      quantity: toQuantityField(formData.get("quantity")),
      reason: toOptionalStringField(formData.get("reason")),
      rawNotes: toOptionalStringField(formData.get("rawNotes")),
    };
  }

  if (eventType === "GENERAL_UPDATE") {
    return {
      eventType: "GENERAL_UPDATE",
      componentId: toOptionalStringField(formData.get("componentId")),
      supplierId: toOptionalStringField(formData.get("supplierId")),
      rawNotes: toRequiredStringField(formData.get("rawNotes")),
    };
  }

  // Preserve an invalid discriminator so eventEntrySchema rejects it — do
  // not replace it with GENERAL_UPDATE. `eventType` here is whatever
  // unrecognized string was actually submitted (e.g. "SOMETHING_ELSE"), or
  // "" for a missing/non-string value; either way it fails
  // eventEntrySchema's discriminated-union check with a clear error.
  return { eventType };
}
