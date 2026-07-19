// Shared status vocabulary across the dashboard, program overview, and
// audit shell — one place mapping a domain status string to a color, so
// "OPEN" (a Risk status) and "OPEN" (a Defect status) always render the
// same way instead of each page inventing its own badge colors.
const STATUS_TONES: Record<string, "danger" | "warning" | "success" | "neutral" | "accent"> = {
  // Milestone
  NOT_STARTED: "neutral",
  ON_TRACK: "success",
  AT_RISK: "warning",
  DELAYED: "danger",
  COMPLETE: "success",
  // Risk / generic OPEN-MITIGATING-CLOSED
  OPEN: "danger",
  MITIGATING: "warning",
  CLOSED: "success",
  // Defect
  IN_PROGRESS: "warning",
  RESOLVED: "success",
  // Test outcome
  PASSED: "success",
  FAILED: "danger",
  BLOCKED: "warning",
  NOT_RUN: "neutral",
  // Severity
  LOW: "neutral",
  MEDIUM: "warning",
  HIGH: "danger",
  CRITICAL: "danger",
};

const TONE_CLASSES: Record<string, string> = {
  danger: "bg-danger/10 text-danger",
  warning: "bg-warning/10 text-warning",
  success: "bg-success/10 text-success",
  accent: "bg-accent/10 text-accent",
  neutral: "bg-border text-muted",
};

export function StatusBadge({ status }: { status: string }) {
  const tone = STATUS_TONES[status] ?? "neutral";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${TONE_CLASSES[tone]}`}
    >
      {status.replaceAll("_", " ")}
    </span>
  );
}
