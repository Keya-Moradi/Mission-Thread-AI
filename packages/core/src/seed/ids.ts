// Fixed, human-readable seed IDs (SPEC.md §4). Deterministic across every
// db:seed run so demo links, screenshots, and evals can reference them by name.

export const PROGRAM_ID = "PROGRAM-EDGELINK-X";

export const SUPPLIER_IDS = {
  northstar: "SUP-NORTHSTAR",
  ironvale: "SUP-IRONVALE",
  paragon: "SUP-PARAGON",
} as const;

export const COMPONENT_IDS = {
  ec440: "COMP-EC440",
  enclosure: "COMP-ENCLOSURE",
  battery: "COMP-BATTERY",
  firmware: "COMP-FIRMWARE",
  deviceMgmt: "COMP-DMS",
  telemetry: "COMP-TELEMETRY",
} as const;

export const REQUIREMENT_IDS = [
  "REQ-001",
  "REQ-002",
  "REQ-003",
  "REQ-004",
  "REQ-005",
  "REQ-006",
  "REQ-007",
  "REQ-008",
] as const;

export const MILESTONE_IDS = [
  "MS-001",
  "MS-002",
  "MS-003",
  "MS-004",
  "MS-005",
  "MS-006",
  "MS-007",
  "MS-008",
] as const;

export const TEST_IDS = [
  "TEST-001",
  "TEST-002",
  "TEST-003",
  "TEST-004",
  "TEST-005",
  "TEST-006",
  "TEST-007",
  "TEST-008",
] as const;

export const RISK_IDS = ["RISK-001", "RISK-002", "RISK-003", "RISK-004"] as const;

export const BUDGET_IDS = [
  "BUDGET-001",
  "BUDGET-002",
  "BUDGET-003",
  "BUDGET-004",
  "BUDGET-005",
] as const;

export const DEFECT_IDS = ["DEF-001", "DEF-002", "DEF-003"] as const;

export const EVENT_IDS = {
  supplierDelay: "EVT-SUPPLIER-001",
  general: ["EVT-002", "EVT-003", "EVT-004"] as const,
};

// One deterministic EVENT_RECORDED AuditEvent per seeded ProgramEvent (see
// prisma/seed.ts seedAuditEvents) — demonstrates the Phase 3 audit shell
// against a fresh reset without requiring a manual event submission first.
export const AUDIT_EVENT_IDS = {
  supplierDelay: "AUDIT-EVT-SUPPLIER-001",
  general: ["AUDIT-EVT-002", "AUDIT-EVT-003", "AUDIT-EVT-004"] as const,
};

export const AUDIT_TRACE_IDS = {
  supplierDelay: "TRACE-EVT-SUPPLIER-001",
  general: ["TRACE-EVT-002", "TRACE-EVT-003", "TRACE-EVT-004"] as const,
};

// The DAG edges between milestones (see prisma/seed.ts seedDependencies).
// Deterministic like every other seeded record, so a reset always produces
// the same graph for screenshots, demos, and future dependency-chain tests.
export const DEPENDENCY_IDS = [
  "DEP-001",
  "DEP-002",
  "DEP-003",
  "DEP-004",
  "DEP-005",
  "DEP-006",
  "DEP-007",
  "DEP-008",
] as const;

export const DEMO_USER_EMAILS = {
  programManager: "pm@missionthread.example",
  engineeringLead: "lead@missionthread.example",
  executiveViewer: "exec@missionthread.example",
} as const;

export const DEMO_USER_IDS = {
  programManager: "USER-PM",
  engineeringLead: "USER-ENG-LEAD",
  executiveViewer: "USER-EXEC",
} as const;

// Phase 4: the one seeded demonstration AI impact analysis, for
// EVT-SUPPLIER-001. Its content is not hand-authored — prisma/seed.ts calls
// the real, production buildModelInputProjection() + generateMockImpactAnalysis()
// + buildAttemptSourceReferenceSnapshot() functions against the live seeded
// event and persists whatever they produce, so these IDs only need to cover
// the fixed identifiers a demo needs to link to (the run/attempt/trace and
// the 3 mitigation options, always exactly 3) — SourceReference row IDs are
// derived deterministically from each supplied record's own (recordType,
// recordId) instead of being pre-enumerated here, since the exact supplied-
// evidence set depends on runtime data, not a fixed list. Every allowlisted
// record gets a row (not just the ones the mock output cites) — see
// docs/DECISIONS.md, "Phase 4 correction: complete attempt-evidence
// persistence".
export const ANALYSIS_IDS = {
  supplierDelay: "ANALYSIS-EVT-SUPPLIER-001",
} as const;

export const ANALYSIS_RUN_IDS = {
  supplierDelay: "RUN-EVT-SUPPLIER-001",
} as const;

export const ANALYSIS_TRACE_IDS = {
  supplierDelay: "TRACE-ANALYSIS-EVT-SUPPLIER-001",
} as const;

export const MITIGATION_OPTION_IDS = {
  supplierDelay: [
    "MIT-EVT-SUPPLIER-001-1",
    "MIT-EVT-SUPPLIER-001-2",
    "MIT-EVT-SUPPLIER-001-3",
  ] as const,
} as const;

export const ANALYSIS_AUDIT_EVENT_IDS = {
  started: "AUDIT-ANALYSIS-EVT-SUPPLIER-001-STARTED",
  succeeded: "AUDIT-ANALYSIS-EVT-SUPPLIER-001-SUCCEEDED",
} as const;
