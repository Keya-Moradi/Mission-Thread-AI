import { describe, expect, it } from "vitest";
import {
  GITHUB_ACTIONS_TEST_TARGETS,
  LOCAL_TEST_TARGETS,
  findApprovedDatabaseTarget,
  sanitizeDatabaseUrl,
} from "../db-safety";
import { resolveTestDatabaseConfiguration } from "./resolve-test-database-configuration";

// Pure, DB-free: every test below only calls resolveTestDatabaseConfiguration
// and (where noted) findApprovedDatabaseTarget/sanitizeDatabaseUrl, none of
// which touch the filesystem or a database connection.

describe("resolveTestDatabaseConfiguration — local context", () => {
  it("no GITHUB_ACTIONS set: loads .env.test with override, validates against LOCAL_TEST_TARGETS", () => {
    const config = resolveTestDatabaseConfiguration({});
    expect(config).toEqual({
      environmentFile: ".env.test",
      overrideEnvironment: true,
      approvedTargets: LOCAL_TEST_TARGETS,
    });
  });

  it("[local test tuple passes] localhost:55432/missionthread_test is approved", () => {
    const config = resolveTestDatabaseConfiguration({});
    const target = sanitizeDatabaseUrl(
      "postgresql://missionthread:pw@localhost:55432/missionthread_test",
    )!;
    expect(findApprovedDatabaseTarget(target, config.approvedTargets, {})).not.toBeNull();
  });

  it("[local dev database fails] localhost:55432/missionthread_dev is rejected", () => {
    const config = resolveTestDatabaseConfiguration({});
    const target = sanitizeDatabaseUrl(
      "postgresql://missionthread:pw@localhost:55432/missionthread_dev",
    )!;
    expect(findApprovedDatabaseTarget(target, config.approvedTargets, {})).toBeNull();
  });

  it("[local test database on port 5432 fails] the local target list only ever lists port 55432", () => {
    const config = resolveTestDatabaseConfiguration({});
    const target = sanitizeDatabaseUrl(
      "postgresql://missionthread:pw@localhost:5432/missionthread_test",
    )!;
    expect(findApprovedDatabaseTarget(target, config.approvedTargets, {})).toBeNull();
  });

  it("[remote hosts fail] a non-loopback host is rejected", () => {
    const config = resolveTestDatabaseConfiguration({});
    const target = sanitizeDatabaseUrl(
      "postgresql://missionthread:pw@db.example.com:55432/missionthread_test",
    )!;
    expect(findApprovedDatabaseTarget(target, config.approvedTargets, {})).toBeNull();
  });

  it("[ambient DATABASE_URL cannot override .env.test] overrideEnvironment is true for the local context", () => {
    // dotenv's own `override` option performs the actual clobbering of an
    // already-set process.env value; this asserts the local context always
    // requests that behavior, which is what setup-env.ts passes straight
    // through to dotenv's config() call.
    expect(resolveTestDatabaseConfiguration({}).overrideEnvironment).toBe(true);
  });

  it.each([
    { CI: "true" },
    { GITHUB_ACTIONS: "false" },
    { GITHUB_ACTIONS: "TRUE" },
    { GITHUB_ACTIONS: " true" },
  ])("%j is still treated as the local context, not GitHub Actions", (env) => {
    const config = resolveTestDatabaseConfiguration(env);
    expect(config.approvedTargets).toBe(LOCAL_TEST_TARGETS);
    expect(config.environmentFile).toBe(".env.test");
  });
});

describe("resolveTestDatabaseConfiguration — GitHub Actions context", () => {
  it('GITHUB_ACTIONS="true": does not touch .env.test, validates against GITHUB_ACTIONS_TEST_TARGETS', () => {
    const config = resolveTestDatabaseConfiguration({ GITHUB_ACTIONS: "true" });
    expect(config).toEqual({
      environmentFile: null,
      overrideEnvironment: false,
      approvedTargets: GITHUB_ACTIONS_TEST_TARGETS,
    });
  });

  it("[GitHub Actions does not rely on .env.test] environmentFile is null", () => {
    expect(resolveTestDatabaseConfiguration({ GITHUB_ACTIONS: "true" }).environmentFile).toBeNull();
  });

  it("[passes] GITHUB_ACTIONS=true with localhost:5432/missionthread_test is approved", () => {
    const config = resolveTestDatabaseConfiguration({ GITHUB_ACTIONS: "true" });
    const target = sanitizeDatabaseUrl(
      "postgresql://missionthread:pw@localhost:5432/missionthread_test",
    )!;
    expect(
      findApprovedDatabaseTarget(target, config.approvedTargets, { GITHUB_ACTIONS: "true" }),
    ).not.toBeNull();
  });

  it("[only CI=true fails] CI=true alone selects the local context, whose targets can never match the CI tuple", () => {
    const config = resolveTestDatabaseConfiguration({ CI: "true" });
    expect(config.approvedTargets).toBe(LOCAL_TEST_TARGETS);
    const ciTarget = sanitizeDatabaseUrl(
      "postgresql://missionthread:pw@localhost:5432/missionthread_test",
    )!;
    expect(findApprovedDatabaseTarget(ciTarget, config.approvedTargets, { CI: "true" })).toBeNull();
  });

  it("[GITHUB_ACTIONS=false fails] falls back to the local context, whose targets reject the CI tuple", () => {
    const config = resolveTestDatabaseConfiguration({ GITHUB_ACTIONS: "false" });
    expect(config.approvedTargets).toBe(LOCAL_TEST_TARGETS);
  });

  it("[GITHUB_ACTIONS=TRUE fails] case-sensitive match: uppercase falls back to the local context", () => {
    const config = resolveTestDatabaseConfiguration({ GITHUB_ACTIONS: "TRUE" });
    expect(config.approvedTargets).toBe(LOCAL_TEST_TARGETS);
  });

  it("[GitHub Actions with port 55432 fails] the CI target tuple only lists port 5432", () => {
    const config = resolveTestDatabaseConfiguration({ GITHUB_ACTIONS: "true" });
    const target = sanitizeDatabaseUrl(
      "postgresql://missionthread:pw@localhost:55432/missionthread_test",
    )!;
    expect(
      findApprovedDatabaseTarget(target, config.approvedTargets, { GITHUB_ACTIONS: "true" }),
    ).toBeNull();
  });

  it("[GitHub Actions with missionthread_dev fails] the CI target tuple only lists the test database name", () => {
    const config = resolveTestDatabaseConfiguration({ GITHUB_ACTIONS: "true" });
    const target = sanitizeDatabaseUrl(
      "postgresql://missionthread:pw@localhost:5432/missionthread_dev",
    )!;
    expect(
      findApprovedDatabaseTarget(target, config.approvedTargets, { GITHUB_ACTIONS: "true" }),
    ).toBeNull();
  });
});
