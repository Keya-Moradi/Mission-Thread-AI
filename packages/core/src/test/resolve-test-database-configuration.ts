import {
  GITHUB_ACTIONS_TEST_TARGETS,
  LOCAL_TEST_TARGETS,
  type ApprovedDatabaseTarget,
} from "../db-safety";

export interface TestDatabaseConfiguration {
  /** Path (relative to the repo root) to load, or null when no file should be read. */
  environmentFile: string | null;
  /** Whether the loaded file should clobber an already-set DATABASE_URL. */
  overrideEnvironment: boolean;
  approvedTargets: readonly ApprovedDatabaseTarget[];
}

/**
 * Pure environment-selection logic for the Vitest database-backed test
 * suite — no file I/O, no database connection, so it's directly
 * unit-testable. See docs/DECISIONS.md, "Local vs GitHub Actions test
 * database selection".
 *
 * Exactly two contexts exist:
 *
 * - GitHub Actions (`GITHUB_ACTIONS === "true"`, the variable GitHub
 *   Actions itself sets for every job — not the generic `CI`, which other
 *   providers and local shells also set): `.github/workflows/ci.yml`
 *   already supplies the correct `DATABASE_URL` for its own Postgres
 *   service container via the workflow's `env:` block. Loading `.env.test`
 *   here — a file that isn't even guaranteed to exist in a CI checkout —
 *   would either be a no-op or, if it did exist, could clobber a correct
 *   CI-supplied value with the local-only port-55432 target. So this
 *   context never touches `.env.test` at all, and validates against the
 *   GitHub-Actions-only tuple (`localhost:5432/missionthread_test`, which
 *   itself only matches when `GITHUB_ACTIONS=true`).
 * - Everywhere else (local development, and defensively any other CI
 *   provider): load `.env.test` with `override: true`, so an ambient
 *   `DATABASE_URL` left over from something else (e.g. a manual
 *   `db:seed:dev:destructive` invocation in the same shell) can never leak
 *   into a test run, and validate against the local test tuple only
 *   (`localhost:55432` / `127.0.0.1:55432` / `missionthread_test`).
 */
export function resolveTestDatabaseConfiguration(
  env: NodeJS.ProcessEnv,
): TestDatabaseConfiguration {
  if (env.GITHUB_ACTIONS === "true") {
    return {
      environmentFile: null,
      overrideEnvironment: false,
      approvedTargets: GITHUB_ACTIONS_TEST_TARGETS,
    };
  }

  return {
    environmentFile: ".env.test",
    overrideEnvironment: true,
    approvedTargets: LOCAL_TEST_TARGETS,
  };
}
