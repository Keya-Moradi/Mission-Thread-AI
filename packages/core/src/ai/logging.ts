export const ANALYSIS_LOG_EVENTS = [
  "analysis.started",
  "analysis.succeeded",
  "analysis.failed",
  "analysis.retrying",
] as const;
export type AnalysisLogEvent = (typeof ANALYSIS_LOG_EVENTS)[number];

/**
 * Every field here is safe to persist and to show in a log aggregator —
 * never an API key, token, prompt, raw provider output, full untrusted
 * text, database URL, or credential. See docs/DECISIONS.md, "Phase 4
 * structured logging".
 */
export interface AnalysisLogFields {
  traceId: string;
  analysisRunId: string;
  analysisId: string;
  attempt: number;
  eventId: string;
  requestedById: string;
  aiMode: string;
  provider?: string;
  model?: string;
  durationMs?: number;
  status?: string;
  validationPassed?: boolean;
  errorCategory?: string;
}

export type AnalysisLogSink = (line: string) => void;

const defaultSink: AnalysisLogSink = (line) => {
  console.log(line);
};

/**
 * Emits one line of structured JSON per analysis lifecycle event. Takes an
 * explicit sink (defaulting to console.log) specifically so tests can
 * capture emitted lines directly, without spying on the global console.
 */
export function logAnalysisEvent(
  event: AnalysisLogEvent,
  fields: AnalysisLogFields,
  sink: AnalysisLogSink = defaultSink,
): void {
  sink(JSON.stringify({ event, timestamp: new Date().toISOString(), ...fields }));
}
