import { describe, expect, it } from "vitest";
import {
  GITHUB_ACTIONS_TEST_TARGETS,
  LOCAL_DEV_TARGETS,
  LOCAL_TEST_TARGETS,
  checkDestructiveOperationAllowed,
  extractDatabaseName,
  findApprovedDatabaseTarget,
  isTestDatabaseName,
  resolveSeedScopeTargets,
  sanitizeDatabaseUrl,
} from "./db-safety";

const ALL_TARGETS = [...LOCAL_DEV_TARGETS, ...LOCAL_TEST_TARGETS, ...GITHUB_ACTIONS_TEST_TARGETS];
// GITHUB_ACTIONS_TEST_TARGETS is a fixed single-element array literal in
// db-safety.ts; asserted non-null here purely to satisfy
// noUncheckedIndexedAccess, not because its contents are actually
// uncertain at runtime.
const GITHUB_ACTIONS_TARGET = GITHUB_ACTIONS_TEST_TARGETS[0]!;

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

  describe("GitHub Actions target — GITHUB_ACTIONS is the sole authority, not CI", () => {
    const ghTarget = sanitizeDatabaseUrl(
      urlFor(
        GITHUB_ACTIONS_TARGET.host,
        GITHUB_ACTIONS_TARGET.port,
        GITHUB_ACTIONS_TARGET.database,
      ),
    )!;

    it("[positive] passes with GITHUB_ACTIONS=true", () => {
      expect(
        findApprovedDatabaseTarget(ghTarget, GITHUB_ACTIONS_TEST_TARGETS, {
          GITHUB_ACTIONS: "true",
        }),
      ).not.toBeNull();
    });

    it("[positive] passes with both GITHUB_ACTIONS=true and CI=true", () => {
      expect(
        findApprovedDatabaseTarget(ghTarget, GITHUB_ACTIONS_TEST_TARGETS, {
          GITHUB_ACTIONS: "true",
          CI: "true",
        }),
      ).not.toBeNull();
    });

    it("[negative] fails when both GITHUB_ACTIONS and CI are absent", () => {
      expect(findApprovedDatabaseTarget(ghTarget, GITHUB_ACTIONS_TEST_TARGETS, {})).toBeNull();
    });

    it("[negative] fails with only CI=true (CI alone is not authoritative)", () => {
      expect(
        findApprovedDatabaseTarget(ghTarget, GITHUB_ACTIONS_TEST_TARGETS, { CI: "true" }),
      ).toBeNull();
    });

    it("[negative] fails with GITHUB_ACTIONS=false", () => {
      expect(
        findApprovedDatabaseTarget(ghTarget, GITHUB_ACTIONS_TEST_TARGETS, {
          GITHUB_ACTIONS: "false",
        }),
      ).toBeNull();
    });

    it.each(["TRUE", "True", " true", "true "])(
      "[negative] fails with the vague/malformed value %j",
      (value) => {
        expect(
          findApprovedDatabaseTarget(ghTarget, GITHUB_ACTIONS_TEST_TARGETS, {
            GITHUB_ACTIONS: value,
          }),
        ).toBeNull();
      },
    );

    it("[negative] fails for the dev database on port 5432, even with GITHUB_ACTIONS=true", () => {
      const devOnGithubPort = sanitizeDatabaseUrl(
        urlFor("localhost", "5432", "missionthread_dev"),
      )!;
      expect(
        findApprovedDatabaseTarget(devOnGithubPort, GITHUB_ACTIONS_TEST_TARGETS, {
          GITHUB_ACTIONS: "true",
        }),
      ).toBeNull();
    });

    it("[negative] fails for arbitrary hosts or ports, even with GITHUB_ACTIONS=true", () => {
      const wrongHost = sanitizeDatabaseUrl(urlFor("example.com", "5432", "missionthread_test"))!;
      const wrongPort = sanitizeDatabaseUrl(urlFor("localhost", "9999", "missionthread_test"))!;
      expect(
        findApprovedDatabaseTarget(wrongHost, GITHUB_ACTIONS_TEST_TARGETS, {
          GITHUB_ACTIONS: "true",
        }),
      ).toBeNull();
      expect(
        findApprovedDatabaseTarget(wrongPort, GITHUB_ACTIONS_TEST_TARGETS, {
          GITHUB_ACTIONS: "true",
        }),
      ).toBeNull();
    });
  });

  it("[negative] rejects localhost:5432/missionthread_dev outside GitHub Actions (wrong port for dev, and dev isn't a GitHub Actions target at all)", () => {
    const target = sanitizeDatabaseUrl(urlFor("localhost", "5432", "missionthread_dev"))!;
    expect(findApprovedDatabaseTarget(target, ALL_TARGETS, {})).toBeNull();
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

describe("resolveSeedScopeTargets — explicit seed scope, never inferred from DATABASE_URL", () => {
  it("dev scope resolves to exactly LOCAL_DEV_TARGETS", () => {
    expect(resolveSeedScopeTargets("dev")).toBe(LOCAL_DEV_TARGETS);
  });

  it("test scope resolves to exactly LOCAL_TEST_TARGETS", () => {
    expect(resolveSeedScopeTargets("test")).toBe(LOCAL_TEST_TARGETS);
  });

  it("github-actions scope resolves to exactly GITHUB_ACTIONS_TEST_TARGETS", () => {
    expect(resolveSeedScopeTargets("github-actions")).toBe(GITHUB_ACTIONS_TEST_TARGETS);
  });

  it("a missing scope resolves to null", () => {
    expect(resolveSeedScopeTargets(undefined)).toBeNull();
  });

  it("an unknown scope resolves to null", () => {
    expect(resolveSeedScopeTargets("production")).toBeNull();
    expect(resolveSeedScopeTargets("")).toBeNull();
    expect(resolveSeedScopeTargets("Dev")).toBeNull(); // case-sensitive: not a silent alias for "dev"
  });

  it("dev scope's targets cannot seed the test database", () => {
    const testTarget = sanitizeDatabaseUrl(urlFor("localhost", "55432", "missionthread_test"))!;
    const devTargets = resolveSeedScopeTargets("dev")!;
    expect(findApprovedDatabaseTarget(testTarget, devTargets, {})).toBeNull();
  });

  it("test scope's targets cannot seed the dev database", () => {
    const devTarget = sanitizeDatabaseUrl(urlFor("localhost", "55432", "missionthread_dev"))!;
    const testTargets = resolveSeedScopeTargets("test")!;
    expect(findApprovedDatabaseTarget(devTarget, testTargets, {})).toBeNull();
  });

  it("local scopes (dev, test) cannot seed port 5432", () => {
    const devOn5432 = sanitizeDatabaseUrl(urlFor("localhost", "5432", "missionthread_dev"))!;
    const testOn5432 = sanitizeDatabaseUrl(urlFor("localhost", "5432", "missionthread_test"))!;
    expect(
      findApprovedDatabaseTarget(devOn5432, resolveSeedScopeTargets("dev")!, {
        GITHUB_ACTIONS: "true",
      }),
    ).toBeNull();
    expect(
      findApprovedDatabaseTarget(testOn5432, resolveSeedScopeTargets("test")!, {
        GITHUB_ACTIONS: "true",
      }),
    ).toBeNull();
  });

  it("the github-actions scope cannot seed port 55432", () => {
    const testOn55432 = sanitizeDatabaseUrl(urlFor("localhost", "55432", "missionthread_test"))!;
    expect(
      findApprovedDatabaseTarget(testOn55432, resolveSeedScopeTargets("github-actions")!, {
        GITHUB_ACTIONS: "true",
      }),
    ).toBeNull();
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

  it("[positive] allows the GitHub Actions seed against its target when GITHUB_ACTIONS=true and the flag is set", () => {
    const result = checkDestructiveOperationAllowed({
      operationName: "GitHub Actions database seed",
      databaseUrl: urlFor("localhost", "5432", "missionthread_test"),
      approvedTargets: GITHUB_ACTIONS_TEST_TARGETS,
      env: { ...baseEnv, GITHUB_ACTIONS: "true" },
    });
    expect(result.allowed).toBe(true);
  });

  it("[negative] rejects the GitHub Actions target when GITHUB_ACTIONS is absent, even with CI=true and the flag set", () => {
    const result = checkDestructiveOperationAllowed({
      operationName: "GitHub Actions database seed",
      databaseUrl: urlFor("localhost", "5432", "missionthread_test"),
      approvedTargets: GITHUB_ACTIONS_TEST_TARGETS,
      env: { ...baseEnv, CI: "true" },
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
      {
        databaseUrl: urlFor("localhost", "5432", "missionthread_test"),
        approvedTargets: GITHUB_ACTIONS_TEST_TARGETS,
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
