import { describe, expect, it } from "vitest";
import { extractDatabaseName, isTestDatabaseName } from "./db-safety";

describe("db-safety", () => {
  it("extracts the database name from a connection URL", () => {
    expect(extractDatabaseName("postgresql://user:pass@localhost:55432/missionthread_test")).toBe(
      "missionthread_test",
    );
  });

  it("accepts database names that contain a test marker", () => {
    expect(isTestDatabaseName("missionthread_test")).toBe(true);
    expect(isTestDatabaseName("MissionThread_TEST")).toBe(true);
  });

  it("rejects database names without a test marker", () => {
    expect(isTestDatabaseName("missionthread_dev")).toBe(false);
    expect(isTestDatabaseName("missionthread")).toBe(false);
  });
});
