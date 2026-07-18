import { describe, expect, it } from "vitest";
import {
  CI_TEST_TARGETS,
  LOCAL_DEV_TARGETS,
  LOCAL_TEST_TARGETS,
  checkDestructiveOperationAllowed,
  extractDatabaseName,
  findApprovedDatabaseTarget,
  isTestDatabaseName,
  sanitizeDatabaseUrl,
} from "./db-safety";

const ALL_TARGETS = [...LOCAL_DEV_TARGETS, ...LOCAL_TEST_TARGETS, ...CI_TEST_TARGETS];
// CI_TEST_TARGETS is a fixed single-element array literal in db-safety.ts;
// asserted non-null here purely to satisfy noUncheckedIndexedAccess, not
// because its contents are actually uncertain at runtime.
const CI_TARGET = CI_TEST_TARGETS[0]!;

function urlFor(host: string, port: string, database: string): string {
  return `postgresql://missionthread:secretpw@${host}:${port}/${database}`;
}

describe("extractDatabaseName", () => {
  it("extracts the database name from a connection URL", () => {
    expect(extractDatabaseName(urlFor("localhost", "55432", "missionthread_test"))).toBe(
      "missionthread_test",
    );
  });
});

describe("sanitizeDatabaseUrl", () => {
  it("returns only host, port, and database — never credentials", () => {
    const safe = sanitizeDatabaseUrl(urlFor("localhost", "55432", "missionthread_test"));
    expect(safe).toEqual({ host: "localhost", port: "55432", database: "missionthread_test" });
    expect(JSON.stringify(safe)).not.toContain("secretpw");
    expect(JSON.stringify(safe)).not.toContain("missionthread:");
  });

  it("returns null for an unparsable URL instead of throwing", () => {
    expect(sanitizeDatabaseUrl("not a url")).toBeNull();
  });
});

describe("isTestDatabaseName — token-boundary rule", () => {
  it.each(["missionthread_test", "missionthread-test", "test_missionthread", "test"])(
    "accepts %s",
    (name) => {
      expect(isTestDatabaseName(name)).toBe(true);
    },
  );

  it.each(["missionthread_dev", "contest_prod", "latest", "attestation", "testament"])(
    "rejects %s (substring only, not a bounded token)",
    (name) => {
      expect(isTestDatabaseName(name)).toBe(false);
    },
  );
});

describe("findApprovedDatabaseTarget — exact (host, port, database) tuples", () => {
  it.each(LOCAL_DEV_TARGETS.map((t) => [t.host, t.port, t.database] as const))(
    "[positive] accepts the approved local dev target %s:%s/%s",
    (host, port, database) => {
      const target = sanitizeDatabaseUrl(urlFor(host, port, database))!;
      expect(findApprovedDatabaseTarget(target, LOCAL_DEV_TARGETS, {})).not.toBeNull();
    },
  );

  it.each(LOCAL_TEST_TARGETS.map((t) => [t.host, t.port, t.database] as const))(
    "[positive] accepts the approved local test target %s:%s/%s",
    (host, port, database) => {
      const target = sanitizeDatabaseUrl(urlFor(host, port, database))!;
      expect(findApprovedDatabaseTarget(target, LOCAL_TEST_TARGETS, {})).not.toBeNull();
    },
  );

  it("[positive] accepts the CI target when CI=true", () => {
    const target = sanitizeDatabaseUrl(urlFor(CI_TARGET.host, CI_TARGET.port, CI_TARGET.database))!;
    expect(findApprovedDatabaseTarget(target, CI_TEST_TARGETS, { CI: "true" })).not.toBeNull();
  });

  it("[negative] rejects the CI tuple's host/port/database when CI is absent", () => {
    const target = sanitizeDatabaseUrl(urlFor(CI_TARGET.host, CI_TARGET.port, CI_TARGET.database))!;
    expect(findApprovedDatabaseTarget(target, CI_TEST_TARGETS, {})).toBeNull();
  });

  it("[negative] rejects the CI tuple's host/port/database when CI=false", () => {
    const target = sanitizeDatabaseUrl(urlFor(CI_TARGET.host, CI_TARGET.port, CI_TARGET.database))!;
    expect(findApprovedDatabaseTarget(target, CI_TEST_TARGETS, { CI: "false" })).toBeNull();
  });

  it("[negative] rejects localhost:5432/missionthread_dev outside CI (wrong port for dev, and dev isn't a CI target at all)", () => {
    const target = sanitizeDatabaseUrl(urlFor("localhost", "5432", "missionthread_dev"))!;
    expect(findApprovedDatabaseTarget(target, ALL_TARGETS, {})).toBeNull();
  });

  it("[negative] rejects localhost:5432/missionthread_test outside CI (right host/db, wrong port unless CI=true)", () => {
    const target = sanitizeDatabaseUrl(urlFor("localhost", "5432", "missionthread_test"))!;
    expect(findApprovedDatabaseTarget(target, ALL_TARGETS, {})).toBeNull();
    expect(findApprovedDatabaseTarget(target, ALL_TARGETS, { CI: "true" })).not.toBeNull();
  });

  it("[negative] rejects the test target when only the dev target is approved for this operation", () => {
    const target = sanitizeDatabaseUrl(urlFor("localhost", "55432", "missionthread_test"))!;
    expect(findApprovedDatabaseTarget(target, LOCAL_DEV_TARGETS, {})).toBeNull();
  });

  it("[negative] rejects the dev target when only the test target is approved for this operation", () => {
    const target = sanitizeDatabaseUrl(urlFor("localhost", "55432", "missionthread_dev"))!;
    expect(findApprovedDatabaseTarget(target, LOCAL_TEST_TARGETS, {})).toBeNull();
  });

  it("[negative] rejects an arbitrary port even with an approved host and database", () => {
    const target = sanitizeDatabaseUrl(urlFor("localhost", "9999", "missionthread_dev"))!;
    expect(findApprovedDatabaseTarget(target, ALL_TARGETS, {})).toBeNull();
  });

  it("[negative] rejects a remote host even with an approved port and database", () => {
    const target = sanitizeDatabaseUrl(
      urlFor("production-db.example.com", "55432", "missionthread_dev"),
    )!;
    expect(findApprovedDatabaseTarget(target, ALL_TARGETS, {})).toBeNull();
  });

  it("[negative] rejects an approved database name on the wrong port", () => {
    const target = sanitizeDatabaseUrl(urlFor("localhost", "5433", "missionthread_dev"))!;
    expect(findApprovedDatabaseTarget(target, LOCAL_DEV_TARGETS, {})).toBeNull();
  });

  it("[negative] rejects an approved port with the wrong database", () => {
    const target = sanitizeDatabaseUrl(urlFor("localhost", "55432", "some_other_db"))!;
    expect(findApprovedDatabaseTarget(target, ALL_TARGETS, {})).toBeNull();
  });
});

describe("checkDestructiveOperationAllowed", () => {
  const baseEnv = { ALLOW_DESTRUCTIVE_DATABASE_OPERATION: "true" };

  it("[positive] allows a test reset against an approved local test target with the opt-in flag set", () => {
    const result = checkDestructiveOperationAllowed({
      operationName: "test database reset",
      databaseUrl: urlFor("localhost", "55432", "missionthread_test"),
      approvedTargets: LOCAL_TEST_TARGETS,
      env: baseEnv,
    });
    expect(result.allowed).toBe(true);
    expect(result.message).not.toContain("secretpw");
  });

  it("[positive] allows a dev reseed against an approved local dev target with the opt-in flag set", () => {
    const result = checkDestructiveOperationAllowed({
      operationName: "dev database reseed",
      databaseUrl: urlFor("localhost", "55432", "missionthread_dev"),
      approvedTargets: LOCAL_DEV_TARGETS,
      env: baseEnv,
    });
    expect(result.allowed).toBe(true);
  });

  it("[positive] allows the CI seed against the CI target when CI=true and the flag is set", () => {
    const result = checkDestructiveOperationAllowed({
      operationName: "CI database seed",
      databaseUrl: urlFor("localhost", "5432", "missionthread_test"),
      approvedTargets: CI_TEST_TARGETS,
      env: { ...baseEnv, CI: "true" },
    });
    expect(result.allowed).toBe(true);
  });

  it("[negative] rejects the CI target when CI is absent, even with the flag set", () => {
    const result = checkDestructiveOperationAllowed({
      operationName: "CI database seed",
      databaseUrl: urlFor("localhost", "5432", "missionthread_test"),
      approvedTargets: CI_TEST_TARGETS,
      env: baseEnv,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("target_not_approved");
  });

  it("[negative] rejects when NODE_ENV is production, even with a valid target and flag", () => {
    const result = checkDestructiveOperationAllowed({
      operationName: "test database reset",
      databaseUrl: urlFor("localhost", "55432", "missionthread_test"),
      approvedTargets: LOCAL_TEST_TARGETS,
      env: { ...baseEnv, NODE_ENV: "production" },
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("production_environment");
  });

  it("[negative] rejects a missing database URL", () => {
    const result = checkDestructiveOperationAllowed({
      operationName: "test database reset",
      databaseUrl: undefined,
      approvedTargets: LOCAL_TEST_TARGETS,
      env: baseEnv,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("missing_database_url");
  });

  it("[negative] rejects a malformed database URL", () => {
    const result = checkDestructiveOperationAllowed({
      operationName: "test database reset",
      databaseUrl: "not a url",
      approvedTargets: LOCAL_TEST_TARGETS,
      env: baseEnv,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("malformed_database_url");
  });

  it("[negative] rejects an unapproved remote host even when the database name matches", () => {
    const result = checkDestructiveOperationAllowed({
      operationName: "test database reset",
      databaseUrl: urlFor("production-db.example.com", "55432", "missionthread_test"),
      approvedTargets: LOCAL_TEST_TARGETS,
      env: baseEnv,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("target_not_approved");
  });

  it("[negative] rejects the dev database name when only the test targets are approved", () => {
    const result = checkDestructiveOperationAllowed({
      operationName: "test database reset",
      databaseUrl: urlFor("localhost", "55432", "missionthread_dev"),
      approvedTargets: LOCAL_TEST_TARGETS,
      env: baseEnv,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("target_not_approved");
  });

  it("[negative] rejects when the opt-in flag is missing", () => {
    const result = checkDestructiveOperationAllowed({
      operationName: "test database reset",
      databaseUrl: urlFor("localhost", "55432", "missionthread_test"),
      approvedTargets: LOCAL_TEST_TARGETS,
      env: {},
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("missing_explicit_opt_in");
  });

  it("[negative] rejects vague truthy values for the opt-in flag", () => {
    for (const value of ["1", "yes", "TRUE", "True", " true", "true "]) {
      const result = checkDestructiveOperationAllowed({
        operationName: "test database reset",
        databaseUrl: urlFor("localhost", "55432", "missionthread_test"),
        approvedTargets: LOCAL_TEST_TARGETS,
        env: { ALLOW_DESTRUCTIVE_DATABASE_OPERATION: value },
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("missing_explicit_opt_in");
    }
  });

  it("never includes the raw connection string or credentials in any rejection message", () => {
    const cases = [
      {
        databaseUrl: urlFor("localhost", "55432", "missionthread_test"),
        approvedTargets: LOCAL_DEV_TARGETS,
        env: baseEnv,
      },
      {
        databaseUrl: urlFor("localhost", "55432", "missionthread_test"),
        approvedTargets: LOCAL_TEST_TARGETS,
        env: {},
      },
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
