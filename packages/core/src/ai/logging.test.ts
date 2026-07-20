import { describe, expect, it } from "vitest";
import { logAnalysisEvent } from "./logging";

describe("logAnalysisEvent", () => {
  it("emits one line of valid JSON with the event name and every supplied field", () => {
    const lines: string[] = [];
    logAnalysisEvent(
      "analysis.started",
      {
        traceId: "trace-1",
        analysisRunId: "run-1",
        analysisId: "analysis-1",
        attempt: 1,
        eventId: "EVT-001",
        requestedById: "USER-PM",
        aiMode: "mock",
        provider: "mock",
      },
      (line) => lines.push(line),
    );

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.event).toBe("analysis.started");
    expect(parsed.traceId).toBe("trace-1");
    expect(parsed.analysisRunId).toBe("run-1");
    expect(typeof parsed.timestamp).toBe("string");
  });

  it("[never logs secrets/prompts/raw output] the emitted line only ever contains the documented safe fields", () => {
    const lines: string[] = [];
    logAnalysisEvent(
      "analysis.failed",
      {
        traceId: "trace-2",
        analysisRunId: "run-2",
        analysisId: "analysis-2",
        attempt: 2,
        eventId: "EVT-001",
        requestedById: "USER-PM",
        aiMode: "live",
        provider: "openai",
        model: "gpt-test",
        errorCategory: "TRANSIENT_PROVIDER_FAILURE",
      },
      (line) => lines.push(line),
    );

    const parsed = JSON.parse(lines[0]!);
    expect(Object.keys(parsed).sort()).toEqual(
      [
        "event",
        "timestamp",
        "traceId",
        "analysisRunId",
        "analysisId",
        "attempt",
        "eventId",
        "requestedById",
        "aiMode",
        "provider",
        "model",
        "errorCategory",
      ].sort(),
    );
  });
});
