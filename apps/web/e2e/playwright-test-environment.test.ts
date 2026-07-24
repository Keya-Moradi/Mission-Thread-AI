import { describe, expect, it } from "vitest";
import {
  resolvePlaywrightTestEnvironment,
  assertPlaywrightTestDatabaseTarget,
  PlaywrightTestEnvironmentError,
} from "./playwright-test-environment";

// @types/node's ProcessEnv requires NODE_ENV, unlike the plain
// Record<string, string> the parsed-.env.test-content parameter accepts —
// this helper builds a minimal, valid NodeJS.ProcessEnv-shaped fixture for
// the ambientEnv/direct-env arguments below without repeating NODE_ENV in
// every test case.
function fakeEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...overrides } as NodeJS.ProcessEnv;
}

const VALID_TEST_ENV = { DATABASE_URL: "postgresql://u:p@localhost:55432/missionthread_test" };
const DEV_ENV = { DATABASE_URL: "postgresql://u:p@localhost:55432/missionthread_dev" };
const SECRET = "super-secret-password-1234";

describe("resolvePlaywrightTestEnvironment", () => {
  it("resolves to the .env.test target even when the ambient shell already has a dev DATABASE_URL", () => {
    const ambientEnv = fakeEnv({
      DATABASE_URL: "postgresql://u:p@localhost:55432/missionthread_dev",
    });
    const resolved = resolvePlaywrightTestEnvironment(ambientEnv, VALID_TEST_ENV);
    expect(resolved.env.DATABASE_URL).toBe(VALID_TEST_ENV.DATABASE_URL);
    expect(resolved.target).toEqual({
      host: "localhost",
      port: "55432",
      database: "missionthread_test",
    });
  });

  it("[regression] ambient DATABASE_URL points at missionthread_dev, .env.test points at missionthread_test — the resolved worker environment is missionthread_test", () => {
    const ambientEnv = fakeEnv({
      DATABASE_URL: "postgresql://u:p@localhost:55432/missionthread_dev",
    });
    const parsedTestEnv = {
      DATABASE_URL: "postgresql://u:p@127.0.0.1:55432/missionthread_test",
      AUTH_SECRET: "unrelated-value",
    };
    const resolved = resolvePlaywrightTestEnvironment(ambientEnv, parsedTestEnv);
    expect(resolved.env.DATABASE_URL).toContain("missionthread_test");
    expect(resolved.env.DATABASE_URL).not.toContain("missionthread_dev");
    expect(resolved.target.database).toBe("missionthread_test");
    // Every other .env.test key is still carried through unchanged.
    expect(resolved.env.AUTH_SECRET).toBe("unrelated-value");
  });

  it("an ambient missionthread_test on the wrong port never changes the resolved target — .env.test's own value is exact and authoritative", () => {
    const ambientEnv = fakeEnv({
      DATABASE_URL: "postgresql://u:p@localhost:5432/missionthread_test",
    });
    const resolved = resolvePlaywrightTestEnvironment(ambientEnv, VALID_TEST_ENV);
    expect(resolved.target).toEqual({
      host: "localhost",
      port: "55432",
      database: "missionthread_test",
    });
  });

  it("fails when .env.test failed to load (parsedTestEnv is undefined)", () => {
    expect(() => resolvePlaywrightTestEnvironment(fakeEnv(), undefined)).toThrow(
      PlaywrightTestEnvironmentError,
    );
  });

  it("fails when .env.test has no DATABASE_URL", () => {
    expect(() => resolvePlaywrightTestEnvironment(fakeEnv(), { SOME_OTHER_VAR: "x" })).toThrow(
      PlaywrightTestEnvironmentError,
    );
  });

  it("fails on a malformed DATABASE_URL", () => {
    expect(() =>
      resolvePlaywrightTestEnvironment(fakeEnv(), { DATABASE_URL: "not a url at all" }),
    ).toThrow(PlaywrightTestEnvironmentError);
  });

  it("fails when .env.test's own DATABASE_URL points at missionthread_dev", () => {
    expect(() => resolvePlaywrightTestEnvironment(fakeEnv(), DEV_ENV)).toThrow(
      PlaywrightTestEnvironmentError,
    );
  });

  it("fails on a remote host", () => {
    expect(() =>
      resolvePlaywrightTestEnvironment(fakeEnv(), {
        DATABASE_URL: "postgresql://u:p@db.example.com:55432/missionthread_test",
      }),
    ).toThrow(PlaywrightTestEnvironmentError);
  });

  it("fails on missionthread_test at the wrong local port", () => {
    expect(() =>
      resolvePlaywrightTestEnvironment(fakeEnv(), {
        DATABASE_URL: "postgresql://u:p@localhost:5432/missionthread_test",
      }),
    ).toThrow(PlaywrightTestEnvironmentError);
  });

  it("passes for localhost:55432/missionthread_test", () => {
    expect(() =>
      resolvePlaywrightTestEnvironment(fakeEnv(), {
        DATABASE_URL: "postgresql://u:p@localhost:55432/missionthread_test",
      }),
    ).not.toThrow();
  });

  it("passes for 127.0.0.1:55432/missionthread_test", () => {
    expect(() =>
      resolvePlaywrightTestEnvironment(fakeEnv(), {
        DATABASE_URL: "postgresql://u:p@127.0.0.1:55432/missionthread_test",
      }),
    ).not.toThrow();
  });

  it("rejects the GitHub Actions test tuple outside a real GitHub Actions context", () => {
    expect(() =>
      resolvePlaywrightTestEnvironment(fakeEnv({ GITHUB_ACTIONS: undefined }), {
        DATABASE_URL: "postgresql://u:p@localhost:5432/missionthread_test",
      }),
    ).toThrow(PlaywrightTestEnvironmentError);
  });

  it('accepts the GitHub Actions test tuple only when GITHUB_ACTIONS is exactly "true"', () => {
    const resolved = resolvePlaywrightTestEnvironment(fakeEnv({ GITHUB_ACTIONS: "true" }), {
      DATABASE_URL: "postgresql://u:p@localhost:5432/missionthread_test",
    });
    expect(resolved.target).toEqual({
      host: "localhost",
      port: "5432",
      database: "missionthread_test",
    });
  });

  it("never leaks the username, password, query string, or raw URL in an error message", () => {
    const parsedTestEnv = {
      DATABASE_URL: `postgresql://admin:${SECRET}@localhost:55432/missionthread_dev?sslmode=require`,
    };
    try {
      resolvePlaywrightTestEnvironment(fakeEnv(), parsedTestEnv);
      expect.unreachable("expected resolvePlaywrightTestEnvironment to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PlaywrightTestEnvironmentError);
      const message = (error as Error).message;
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain("admin");
      expect(message).not.toContain("sslmode");
      expect(message).not.toContain(parsedTestEnv.DATABASE_URL);
    }
  });
});

describe("assertPlaywrightTestDatabaseTarget", () => {
  it("passes for an approved local test target", () => {
    expect(() =>
      assertPlaywrightTestDatabaseTarget(
        fakeEnv({ DATABASE_URL: "postgresql://u:p@localhost:55432/missionthread_test" }),
      ),
    ).not.toThrow();
  });

  it("fails when DATABASE_URL is missing", () => {
    expect(() => assertPlaywrightTestDatabaseTarget(fakeEnv())).toThrow(
      PlaywrightTestEnvironmentError,
    );
  });

  it("fails when DATABASE_URL points at missionthread_dev", () => {
    expect(() => assertPlaywrightTestDatabaseTarget(fakeEnv(DEV_ENV))).toThrow(
      PlaywrightTestEnvironmentError,
    );
  });

  it("fails on a malformed DATABASE_URL", () => {
    expect(() =>
      assertPlaywrightTestDatabaseTarget(fakeEnv({ DATABASE_URL: "not a url" })),
    ).toThrow(PlaywrightTestEnvironmentError);
  });

  it("never leaks credentials in its error message", () => {
    try {
      assertPlaywrightTestDatabaseTarget(
        fakeEnv({ DATABASE_URL: `postgresql://admin:${SECRET}@localhost:55432/missionthread_dev` }),
      );
      expect.unreachable("expected assertPlaywrightTestDatabaseTarget to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PlaywrightTestEnvironmentError);
      expect((error as Error).message).not.toContain(SECRET);
    }
  });
});
