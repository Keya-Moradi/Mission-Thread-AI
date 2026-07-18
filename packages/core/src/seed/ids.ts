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

export const DEMO_USER_EMAILS = {
  programManager: "pm@missionthread.example",
  engineeringLead: "lead@missionthread.example",
  executiveViewer: "exec@missionthread.example",
} as const;
