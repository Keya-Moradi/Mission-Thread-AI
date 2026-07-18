import { describe, expect, it } from "vitest";
import {
  APPROVED_DEV_DATABASE_NAMES,
  APPROVED_TEST_DATABASE_NAMES,
  checkDestructiveOperationAllowed,
  extractDatabaseName,
  isApprovedTestDatabaseName,
  isTestDatabaseName,
  sanitizeDatabaseUrl,
} from "./db-safety";

const TEST_URL = "postgresql://missionthread:secretpw@localhost:55432/missionthread_test";
const DEV_URL = "postgresql://missionthread:secretpw@localhost:55432/missionthread_dev";

describe("extractDatabaseName", () => {
  it("extracts the database name from a connection URL", () => {
    expect(extractDatabaseName(TEST_URL)).toBe("missionthread_test");
  });
});

describe("sanitizeDatabaseUrl", () => {
  it("returns only host, port, and database — never credentials", () => {
    const safe = sanitizeDatabaseUrl(TEST_URL);
    expect(safe).toEqual({ host: "localhost", port: "55432", database: "missionthread_test" });
    expect(JSON.stringify(safe)).not.toContain("secretpw");
    expect(JSON.stringify(safe)).not.toContain("missionthread:");
  });

  it("returns null for an unparsable URL instead of throwing", () => {
    expect(sanitizeDatabaseUrl("not a url")).toBeNull();
  });
});

describe("isTestDatabaseName — token-boundary rule", () => {
  it.each([
    "missionthread_test",
    "missionthread-test",
    "test_missionthread",
    "MissionThread_TEST",
    "test",
  ])("accepts %s", (name) => {
    expect(isTestDatabaseName(name)).toBe(true);
  });

  it.each([
    "missionthread_dev",
    "missionthread",
    "contest_prod",
    "latest",
    "attestation",
    "testament",
  ])("rejects %s (substring only, not a bounded token)", (name) => {
    expect(isTestDatabaseName(name)).toBe(false);
  });
});

describe("isApprovedTestDatabaseName — token rule AND allowlist", () => {
  it("accepts the real project test database", () => {
    expect(isApprovedTestDatabaseName("missionthread_test")).toBe(true);
  });

  it("rejects a name that passes the token rule but isn't on the allowlist", () => {
    // Guards against exactly the case the spec calls out: a plausible-looking
    // but unrecognized name must not pass just because it contains "test"
    // as a clean token.
    expect(isApprovedTestDatabaseName("customer_testing_prod")).toBe(false);
    expect(isApprovedTestDatabaseName("someone_elses_test")).toBe(false);
  });
});

describe("checkDestructiveOperationAllowed", () => {
  const baseEnv = { ALLOW_DESTRUCTIVE_DATABASE_OPERATION: "true" };

  it("[positive] allows a test reset against the approved test database with the opt-in flag set", () => {
    const result = checkDestructiveOperationAllowed({
      operationName: "test database reset",
      databaseUrl: TEST_URL,
      approvedDatabaseNames: APPROVED_TEST_DATABASE_NAMES,
      env: baseEnv,
    });
    expect(result.allowed).toBe(true);
    expect(result.message).not.toContain("secretpw");
  });

  it("[positive] allows a dev reseed against the approved dev database with the opt-in flag set", () => {
    const result = checkDestructiveOperationAllowed({
      operationName: "dev database reseed",
      databaseUrl: DEV_URL,
      approvedDatabaseNames: APPROVED_DEV_DATABASE_NAMES,
      env: baseEnv,
    });
    expect(result.allowed).toBe(true);
  });

  it("[negative] rejects when NODE_ENV is production, even with a valid target and flag", () => {
    const result = checkDestructiveOperationAllowed({
      operationName: "test database reset",
      databaseUrl: TEST_URL,
      approvedDatabaseNames: APPROVED_TEST_DATABASE_NAMES,
      env: { ...baseEnv, NODE_ENV: "production" },
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("production_environment");
  });

  it("[negative] rejects a missing database URL", () => {
    const result = checkDestructiveOperationAllowed({
      operationName: "test database reset",
      databaseUrl: undefined,
      approvedDatabaseNames: APPROVED_TEST_DATABASE_NAMES,
      env: baseEnv,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("missing_database_url");
  });

  it("[negative] rejects a malformed database URL", () => {
    const result = checkDestructiveOperationAllowed({
      operationName: "test database reset",
      databaseUrl: "not a url",
      approvedDatabaseNames: APPROVED_TEST_DATABASE_NAMES,
      env: baseEnv,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("malformed_database_url");
  });

  it("[negative] rejects an unapproved remote host even when the database name matches", () => {
    const result = checkDestructiveOperationAllowed({
      operationName: "test database reset",
      databaseUrl: "postgresql://user:pw@production-db.example.com:5432/missionthread_test",
      approvedDatabaseNames: APPROVED_TEST_DATABASE_NAMES,
      env: baseEnv,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("host_not_allowed");
  });

  it("[negative] rejects the dev database name when only the test allowlist is passed", () => {
    const result = checkDestructiveOperationAllowed({
      operationName: "test database reset",
      databaseUrl: DEV_URL,
      approvedDatabaseNames: APPROVED_TEST_DATABASE_NAMES,
      env: baseEnv,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("database_name_not_approved");
  });

  it("[negative] rejects an unapproved database name entirely", () => {
    const result = checkDestructiveOperationAllowed({
      operationName: "test database reset",
      databaseUrl: "postgresql://user:pw@localhost:55432/some_other_db",
      approvedDatabaseNames: APPROVED_TEST_DATABASE_NAMES,
      env: baseEnv,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("database_name_not_approved");
  });

  it("[negative] rejects when the opt-in flag is missing", () => {
    const result = checkDestructiveOperationAllowed({
      operationName: "test database reset",
      databaseUrl: TEST_URL,
      approvedDatabaseNames: APPROVED_TEST_DATABASE_NAMES,
      env: {},
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("missing_explicit_opt_in");
  });

  it("[negative] rejects vague truthy values for the opt-in flag", () => {
    for (const value of ["1", "yes", "TRUE", "True", " true", "true "]) {
      const result = checkDestructiveOperationAllowed({
        operationName: "test database reset",
        databaseUrl: TEST_URL,
        approvedDatabaseNames: APPROVED_TEST_DATABASE_NAMES,
        env: { ALLOW_DESTRUCTIVE_DATABASE_OPERATION: value },
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("missing_explicit_opt_in");
    }
  });

  it("never includes the raw connection string or credentials in any rejection message", () => {
    const cases = [
      { databaseUrl: TEST_URL, approvedDatabaseNames: APPROVED_DEV_DATABASE_NAMES, env: baseEnv },
      { databaseUrl: TEST_URL, approvedDatabaseNames: APPROVED_TEST_DATABASE_NAMES, env: {} },
    ];
    for (const testCase of cases) {
      const result = checkDestructiveOperationAllowed({
        operationName: "test database reset",
        ...testCase,
      });
      expect(result.message).not.toContain("secretpw");
      expect(result.message).not.toContain("missionthread:secretpw");
    }
  });
});
