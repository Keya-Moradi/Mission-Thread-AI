import { describe, expect, it } from "vitest";
import type { ThreadNode } from "@missionthread/core";
import { computeThreadLayout, THREAD_LAYOUT_COLUMN_WIDTH } from "./thread-layout";

function node(kind: ThreadNode["kind"], recordId: string): ThreadNode {
  return {
    id: `${kind}:${recordId}`,
    kind,
    recordId,
    label: recordId,
    subtitle: null,
    status: null,
    href: null,
    metadata: {},
  };
}

describe("computeThreadLayout — pure, no database, no viewport", () => {
  it("[determinism] identical input order always yields identical positions", () => {
    const nodes = [
      node("PROGRAM", "P1"),
      node("COMPONENT", "C1"),
      node("COMPONENT", "C2"),
      node("MILESTONE", "M1"),
    ];
    const first = computeThreadLayout(nodes);
    const second = computeThreadLayout(nodes);
    expect(first).toEqual(second);
  });

  it("[order independence] shuffled input order yields identical positions", () => {
    const nodes = [
      node("PROGRAM", "P1"),
      node("COMPONENT", "C1"),
      node("COMPONENT", "C2"),
      node("MILESTONE", "M1"),
    ];
    const shuffled = [nodes[3]!, nodes[1]!, nodes[0]!, nodes[2]!];
    expect(computeThreadLayout(nodes)).toEqual(computeThreadLayout(shuffled));
  });

  it("[root placement] the PROGRAM node sits in column 0", () => {
    const positions = computeThreadLayout([node("PROGRAM", "P1"), node("COMPONENT", "C1")]);
    expect(positions["PROGRAM:P1"]!.x).toBe(0);
  });

  it("[left-to-right flow] a COMPONENT sits strictly left of a downstream MITIGATION_OPTION", () => {
    const positions = computeThreadLayout([
      node("PROGRAM", "P1"),
      node("COMPONENT", "C1"),
      node("MITIGATION_OPTION", "MIT1"),
    ]);
    expect(positions["COMPONENT:C1"]!.x).toBeLessThan(positions["MITIGATION_OPTION:MIT1"]!.x);
  });

  it("[same column, deterministic row order] nodes of the same kind stack by recordId", () => {
    const positions = computeThreadLayout([
      node("COMPONENT", "COMP-B"),
      node("COMPONENT", "COMP-A"),
    ]);
    expect(positions["COMPONENT:COMP-A"]!.y).toBeLessThan(positions["COMPONENT:COMP-B"]!.y);
  });

  it("[shared column] SUPPLIER and PROGRAM_EVENT share a column but never the same position", () => {
    const positions = computeThreadLayout([
      node("SUPPLIER", "SUP-1"),
      node("PROGRAM_EVENT", "EVT-1"),
    ]);
    expect(positions["SUPPLIER:SUP-1"]!.x).toBe(positions["PROGRAM_EVENT:EVT-1"]!.x);
    expect(positions["SUPPLIER:SUP-1"]!.y).not.toBe(positions["PROGRAM_EVENT:EVT-1"]!.y);
  });

  it("[no NaN / no negative] every position is a finite, non-negative number", () => {
    const positions = computeThreadLayout([
      node("PROGRAM", "P1"),
      node("DECISION", "D1"),
      node("PROPOSED_CHANGE", "PC1"),
    ]);
    for (const position of Object.values(positions)) {
      expect(Number.isFinite(position.x)).toBe(true);
      expect(Number.isFinite(position.y)).toBe(true);
      expect(position.x).toBeGreaterThanOrEqual(0);
      expect(position.y).toBeGreaterThanOrEqual(0);
    }
  });

  it("[empty input] an empty node list produces an empty position map", () => {
    expect(computeThreadLayout([])).toEqual({});
  });

  it("[column width] adjacent columns are spaced by exactly THREAD_LAYOUT_COLUMN_WIDTH", () => {
    const positions = computeThreadLayout([node("PROGRAM", "P1"), node("SUPPLIER", "SUP-1")]);
    expect(positions["SUPPLIER:SUP-1"]!.x - positions["PROGRAM:P1"]!.x).toBe(
      THREAD_LAYOUT_COLUMN_WIDTH,
    );
  });
});
