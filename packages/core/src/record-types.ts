import { z } from "zod";

// Mirrors the Prisma `RecordType` enum (packages/core/prisma/schema.prisma).
// SourceReference, ProposedChange, and AuditEvent all reuse that one Prisma
// enum instead of three separate Prisma enums (see docs/DECISIONS.md for
// why), so each context's actually-valid subset is enforced here with Zod
// at the application boundary rather than by the database schema itself.
export const RECORD_TYPES = [
  "PROGRAM",
  "COMPONENT",
  "REQUIREMENT",
  "MILESTONE",
  "DEPENDENCY",
  "RISK",
  "SUPPLIER",
  "TEST_CASE",
  "DEFECT",
  "BUDGET_ITEM",
  "PROGRAM_EVENT",
  "IMPACT_ANALYSIS",
  "MITIGATION_OPTION",
  "PROPOSED_CHANGE",
  "DECISION",
  "SOURCE_REFERENCE",
] as const;

export type RecordTypeValue = (typeof RECORD_TYPES)[number];

/**
 * Evidence citations (SourceReference.recordType): only real domain data
 * the deterministic services in packages/core can actually produce
 * evidence about. Deliberately excludes the workflow entities below —
 * evidence cites the program data an analysis was built from, never other
 * analyses, decisions, or itself.
 */
export const EVIDENCE_RECORD_TYPES = [
  "PROGRAM",
  "COMPONENT",
  "REQUIREMENT",
  "MILESTONE",
  "DEPENDENCY",
  "RISK",
  "SUPPLIER",
  "TEST_CASE",
  "DEFECT",
  "BUDGET_ITEM",
  "PROGRAM_EVENT",
] as const;
export const evidenceRecordTypeSchema = z.enum(EVIDENCE_RECORD_TYPES);

/**
 * Proposed-change targets (ProposedChange.targetRecordType): the small set
 * of records the approved workflow may actually mutate, matching
 * ProposedChangeType (MILESTONE_DATE, RISK_UPDATE, BUDGET_UPDATE — NEW_ACTION
 * creates a record rather than targeting an existing one, so it has no
 * corresponding entry here). Deliberately excludes users, suppliers, tests,
 * defects, program events, and every workflow/audit/evidence record — an
 * approved mitigation option must never be able to target any of those.
 */
export const PROPOSED_CHANGE_TARGET_TYPES = ["MILESTONE", "RISK", "BUDGET_ITEM"] as const;
export const proposedChangeTargetTypeSchema = z.enum(PROPOSED_CHANGE_TARGET_TYPES);

/**
 * Audit targets (AuditEvent.targetRecordType): the broadest context, since
 * the audit trail must be able to reference both the workflow records it's
 * documenting (an analysis starting, a decision being recorded) and the
 * mutable domain records those decisions eventually change. This is the
 * full RECORD_TYPES superset.
 */
export const AUDIT_TARGET_TYPES = RECORD_TYPES;
export const auditTargetTypeSchema = z.enum(AUDIT_TARGET_TYPES);

// Mirrors the Prisma `AuditAction` enum — used by the Phase 3 audit shell
// (apps/web) to validate the `action` query-parameter filter against an
// allowlist rather than accepting an arbitrary string.
export const AUDIT_ACTIONS = [
  "EVENT_RECORDED",
  "ANALYSIS_STARTED",
  "ANALYSIS_SUCCEEDED",
  "ANALYSIS_FAILED",
  "DECISION_RECORDED",
  "CHANGES_APPLIED",
] as const;
export const auditActionSchema = z.enum(AUDIT_ACTIONS);

// Mirrors the Prisma `AuditActor` enum — same purpose, for the `actorType`
// query-parameter filter.
export const AUDIT_ACTOR_TYPES = ["USER", "SYSTEM", "AI"] as const;
export const auditActorTypeSchema = z.enum(AUDIT_ACTOR_TYPES);
