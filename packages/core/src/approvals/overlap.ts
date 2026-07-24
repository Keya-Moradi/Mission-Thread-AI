import { ok, validationError, type ServiceResult } from "../analysis/types";
import type { ProposedChangeInput } from "./schemas";
import type { PersistedProposedChange } from "./persisted-schemas";

/**
 * A "write key" identifies exactly one field on exactly one record that a
 * proposed change would overwrite — `<targetType>:<targetId>:<field>`, e.g.
 * `"RISK:RISK-001:status"`. Two proposed changes in the same batch that
 * produce the same write key would apply in whatever order the batch
 * happens to be processed in, making the final persisted value
 * order-dependent and silently discarding one of the two human-approved
 * values. See docs/DECISIONS.md, "Phase 5 correction: reject overlapping
 * proposed-change writes".
 *
 * `NEW_ACTION` always returns no keys: it creates a new, independent
 * record every time rather than overwriting an existing field, so it can
 * never conflict with anything else in the batch, including another
 * `NEW_ACTION`.
 */
export function getProposedChangeWriteKeys(change: ProposedChangeInput): string[] {
  switch (change.changeType) {
    case "MILESTONE_DATE":
      return [`MILESTONE:${change.targetRecordId}:currentDate`];
    case "RISK_UPDATE": {
      const keys: string[] = [];
      if (change.status !== undefined) keys.push(`RISK:${change.targetRecordId}:status`);
      if (change.severity !== undefined) keys.push(`RISK:${change.targetRecordId}:severity`);
      if (change.probability !== undefined) keys.push(`RISK:${change.targetRecordId}:probability`);
      if (change.impact !== undefined) keys.push(`RISK:${change.targetRecordId}:impact`);
      return keys;
    }
    case "BUDGET_UPDATE": {
      const keys: string[] = [];
      if (change.plannedAmount !== undefined)
        keys.push(`BUDGET_ITEM:${change.targetRecordId}:plannedAmount`);
      if (change.actualAmount !== undefined)
        keys.push(`BUDGET_ITEM:${change.targetRecordId}:actualAmount`);
      return keys;
    }
    case "NEW_ACTION":
      return [];
  }
}

/**
 * The persisted-row equivalent of `getProposedChangeWriteKeys()` — used at
 * apply time against already-Zod-validated stored `ProposedChange` rows
 * (see `persisted-schemas.ts`). A persisted `RISK_UPDATE`/`BUDGET_UPDATE`
 * row's `newValue` already carries only the fields that changeType
 * actually proposed (enforced by `parsePersistedProposedChange()`), so the
 * key set is derived directly from `Object.keys(newValue)` rather than a
 * per-field `!== undefined` check.
 */
export function getPersistedProposedChangeWriteKeys(change: PersistedProposedChange): string[] {
  switch (change.changeType) {
    case "MILESTONE_DATE":
      return [`MILESTONE:${change.targetRecordId}:currentDate`];
    case "RISK_UPDATE":
      return Object.keys(change.newValue).map((field) => `RISK:${change.targetRecordId}:${field}`);
    case "BUDGET_UPDATE":
      return Object.keys(change.newValue).map(
        (field) => `BUDGET_ITEM:${change.targetRecordId}:${field}`,
      );
    case "NEW_ACTION":
      return [];
  }
}

interface DuplicateWriteKey {
  key: string;
  firstIndex: number;
  secondIndex: number;
}

/**
 * Shared core: the first write key that appears more than once across an
 * ordered list of per-entry key lists, or `null` if every key is unique.
 * Used identically for client-submitted proposed changes (decision time)
 * and persisted `ProposedChange` rows (apply time) — see the two call
 * sites in `record-decision.ts` and `apply-changes.ts`.
 */
export function findDuplicateWriteKey(
  keyListsByEntry: readonly string[][],
): DuplicateWriteKey | null {
  const firstSeenAt = new Map<string, number>();
  for (const [index, keys] of keyListsByEntry.entries()) {
    for (const key of keys) {
      const firstIndex = firstSeenAt.get(key);
      if (firstIndex !== undefined) {
        return { key, firstIndex, secondIndex: index };
      }
      firstSeenAt.set(key, index);
    }
  }
  return null;
}

/**
 * A safe, bounded message describing a write-key conflict — built entirely
 * from the write key's own `<targetType>:<targetId>:<field>` components
 * (each already validated: a Zod enum/allowlisted field name, and a
 * program-scoped entity ID), never from arbitrary client-submitted free
 * text.
 */
function formatOverlapMessage(duplicate: DuplicateWriteKey): string {
  const [targetType, targetId, field] = duplicate.key.split(":");
  return (
    `Proposed changes ${duplicate.firstIndex} and ${duplicate.secondIndex} both write "${field}" ` +
    `on ${targetType} "${targetId}" — each field may be proposed at most once per decision.`
  );
}

/**
 * Rejects a batch of client-submitted proposed changes if any two of them
 * would write the same field on the same record — see
 * `getProposedChangeWriteKeys()` above. Pure and side-effect-free: called
 * by `recordMitigationDecision()` immediately after Zod parsing, before
 * any database access, so an overlapping batch never opens a transaction,
 * loads a target record, or creates any row.
 */
export function validateNoOverlappingProposedChanges(
  changes: readonly ProposedChangeInput[],
): ServiceResult<null> {
  const duplicate = findDuplicateWriteKey(changes.map(getProposedChangeWriteKeys));
  if (duplicate) {
    return validationError(formatOverlapMessage(duplicate));
  }
  return ok(null);
}

/**
 * The apply-time equivalent, run against already-parsed persisted rows —
 * see `applyApprovedChanges()`. A stored batch that somehow overlaps
 * (e.g. two decisions' proposed changes were merged by a bug, or a row was
 * edited directly) is refused before any stale check or domain mutation.
 */
export function validateNoOverlappingPersistedProposedChanges(
  changes: readonly PersistedProposedChange[],
): ServiceResult<null> {
  const duplicate = findDuplicateWriteKey(changes.map(getPersistedProposedChangeWriteKeys));
  if (duplicate) {
    return validationError(formatOverlapMessage(duplicate));
  }
  return ok(null);
}
