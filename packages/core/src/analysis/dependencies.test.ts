import { describe, expect, it } from "vitest";
import { getDependencyChain, traverseDependencyChain, type DependencyEdge } from "./dependencies";

describe("traverseDependencyChain — pure, DB-free traversal", () => {
  it("[direct] a single edge A->B: from B, A is upstream depth 1; from A, B is downstream depth 1", () => {
    const edges: DependencyEdge[] = [{ id: "E1", fromMilestoneId: "A", toMilestoneId: "B" }];

    const fromB = traverseDependencyChain(edges, "B");
    expect(fromB.upstream).toEqual([{ milestoneId: "A", depth: 1, viaDependencyId: "E1" }]);
    expect(fromB.downstream).toEqual([]);

    const fromA = traverseDependencyChain(edges, "A");
    expect(fromA.downstream).toEqual([{ milestoneId: "B", depth: 1, viaDependencyId: "E1" }]);
    expect(fromA.upstream).toEqual([]);
  });

  it("[multi-hop] a linear chain A->B->C->D: downstream from A reaches D at depth 3", () => {
    const edges: DependencyEdge[] = [
      { id: "E1", fromMilestoneId: "A", toMilestoneId: "B" },
      { id: "E2", fromMilestoneId: "B", toMilestoneId: "C" },
      { id: "E3", fromMilestoneId: "C", toMilestoneId: "D" },
    ];

    const result = traverseDependencyChain(edges, "A");
    expect(result.downstream.map((n) => [n.milestoneId, n.depth])).toEqual([
      ["B", 1],
      ["C", 2],
      ["D", 3],
    ]);
  });

  it("[branching] a diamond A->B, A->C, B->D, C->D: D is reached once, at the shortest depth", () => {
    const edges: DependencyEdge[] = [
      { id: "E1", fromMilestoneId: "A", toMilestoneId: "B" },
      { id: "E2", fromMilestoneId: "A", toMilestoneId: "C" },
      { id: "E3", fromMilestoneId: "B", toMilestoneId: "D" },
      { id: "E4", fromMilestoneId: "C", toMilestoneId: "D" },
    ];

    const result = traverseDependencyChain(edges, "A");
    const ids = result.downstream.map((n) => n.milestoneId);
    expect(ids.filter((id) => id === "D")).toHaveLength(1);
    expect(result.downstream.find((n) => n.milestoneId === "D")?.depth).toBe(2);
    expect(new Set(ids)).toEqual(new Set(["B", "C", "D"]));
  });

  it("[duplicate edges] two identical A->B edges never produce a duplicate B in the result", () => {
    const edges: DependencyEdge[] = [
      { id: "E1", fromMilestoneId: "A", toMilestoneId: "B" },
      { id: "E2", fromMilestoneId: "A", toMilestoneId: "B" },
    ];

    const result = traverseDependencyChain(edges, "A");
    expect(result.downstream).toHaveLength(1);
    expect(result.downstream[0]?.milestoneId).toBe("B");
  });

  it("[cycle] a synthetic cycle A->B->C->A terminates instead of looping forever", () => {
    const edges: DependencyEdge[] = [
      { id: "E1", fromMilestoneId: "A", toMilestoneId: "B" },
      { id: "E2", fromMilestoneId: "B", toMilestoneId: "C" },
      { id: "E3", fromMilestoneId: "C", toMilestoneId: "A" },
    ];

    const result = traverseDependencyChain(edges, "A");
    expect(result.downstream.map((n) => n.milestoneId)).toEqual(["B", "C"]);
    // The start node must never appear in its own chain, even via the cycle.
    expect(result.downstream.some((n) => n.milestoneId === "A")).toBe(false);
  });

  it("[unknown] a milestone with no matching edges resolves to empty chains in both directions", () => {
    const edges: DependencyEdge[] = [{ id: "E1", fromMilestoneId: "A", toMilestoneId: "B" }];
    const result = traverseDependencyChain(edges, "Z");
    expect(result.upstream).toEqual([]);
    expect(result.downstream).toEqual([]);
  });
});

describe("getDependencyChain — DB-backed, against the seeded test database", () => {
  it("[not found] an unknown milestone ID returns NOT_FOUND", async () => {
    const result = await getDependencyChain("MS-DOES-NOT-EXIST");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  it("[validation] an empty milestone ID returns VALIDATION_ERROR", async () => {
    const result = await getDependencyChain("");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });

  it("MS-002's upstream is exactly MS-001 (direct prerequisite)", async () => {
    const result = await getDependencyChain("MS-002");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.upstream.map((n) => n.milestoneId)).toEqual(["MS-001"]);
    expect(result.data.upstream[0]?.depth).toBe(1);
  });

  it("MS-002's downstream is MS-006 and MS-008, both direct dependents", async () => {
    const result = await getDependencyChain("MS-002");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.downstream.map((n) => n.milestoneId).sort()).toEqual(["MS-006", "MS-008"]);
  });

  it("MS-001's downstream reaches MS-008 transitively at depth 2 (multi-hop, branching)", async () => {
    const result = await getDependencyChain("MS-001");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byId = new Map(result.data.downstream.map((n) => [n.milestoneId, n.depth]));
    expect(byId.get("MS-002")).toBe(1);
    expect(byId.get("MS-006")).toBe(2);
    expect(byId.get("MS-008")).toBe(2);
  });

  it("MS-008's upstream has 6 direct prerequisites (branching) plus MS-001 transitively at depth 2", async () => {
    const result = await getDependencyChain("MS-008");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const direct = result.data.upstream.filter((n) => n.depth === 1).map((n) => n.milestoneId);
    expect(new Set(direct)).toEqual(
      new Set(["MS-002", "MS-003", "MS-004", "MS-005", "MS-006", "MS-007"]),
    );
    expect(result.data.upstream.find((n) => n.milestoneId === "MS-001")?.depth).toBe(2);
  });

  it("results are deterministically ordered (depth then milestone ID) across repeated calls", async () => {
    const first = await getDependencyChain("MS-008");
    const second = await getDependencyChain("MS-008");
    expect(first).toEqual(second);
  });
});
