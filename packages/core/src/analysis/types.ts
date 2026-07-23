import type { RecordTypeValue } from "../record-types";

/**
 * The single result shape every Phase 2 deterministic service function
 * returns — see docs/DECISIONS.md, "Deterministic-service error strategy".
 * Callers check `ok` and never need to know which functions throw, because
 * none of them do for expected failure modes (missing entity, invalid
 * input); those are always `{ ok: false, error }`.
 */
export type ServiceResult<T> = { ok: true; data: T } | { ok: false; error: DomainError };

export type DomainErrorCode = "NOT_FOUND" | "VALIDATION_ERROR" | "FORBIDDEN" | "CONFLICT";

export interface DomainError {
  code: DomainErrorCode;
  /** The kind of record that was missing or invalid, when applicable. */
  entityType?: RecordTypeValue;
  /** The specific ID that was missing or invalid, when applicable. */
  entityId?: string;
  /** Always safe to log or display — never includes raw database rows. */
  message: string;
}

export function ok<T>(data: T): ServiceResult<T> {
  return { ok: true, data };
}

export function notFound<T>(
  entityType: DomainError["entityType"],
  entityId: string,
): ServiceResult<T> {
  return {
    ok: false,
    error: {
      code: "NOT_FOUND",
      entityType,
      entityId,
      message: `${entityType} "${entityId}" was not found.`,
    },
  };
}

export function validationError<T>(message: string): ServiceResult<T> {
  return { ok: false, error: { code: "VALIDATION_ERROR", message } };
}

/**
 * For an authenticated actor who is not permitted to perform the requested
 * mutation — a missing/stale session user, or a role that isn't allowed —
 * see docs/DECISIONS.md, "Phase 3 mutation authorization". Always a safe,
 * generic message: never reveals whether an ID was malformed vs. simply
 * lacked permission, which would otherwise leak information to an
 * unauthorized caller.
 */
export function forbidden<T>(message: string): ServiceResult<T> {
  return { ok: false, error: { code: "FORBIDDEN", message } };
}

/**
 * For a mutation that can no longer proceed because the record it targets
 * changed after the decision/approval that authorized it was made — see
 * Phase 5 stale-data conflict detection in docs/DECISIONS.md. Distinct from
 * `VALIDATION_ERROR` (malformed input) and `NOT_FOUND` (record never
 * existed): a `CONFLICT` record exists and the input is well-formed, but
 * applying it now would silently overwrite a change nobody approved.
 */
export function conflict<T>(
  entityType: DomainError["entityType"],
  entityId: string,
  message: string,
): ServiceResult<T> {
  return { ok: false, error: { code: "CONFLICT", entityType, entityId, message } };
}

/**
 * Direct = a record is linked to the queried entity through one hop
 * (e.g. a Milestone whose componentId matches). Transitive/dependency-derived
 * = reached only by walking further relationships (e.g. a downstream
 * milestone reached through the Dependency graph). Kept as a shared type so
 * every service that distinguishes the two uses the same vocabulary.
 */
export type ImpactRelationship = "direct" | "dependency-derived";
