# Tasks

Status legend: `[ ]` not started · `[~]` in progress · `[x]` done

This file must stay detailed enough for a new session to resume without chat history.

## Phase 0 — Plan

- [x] Place `PROJECT_GUIDE.md`, `docs/SPEC.md`
- [x] Inspect repository (empty except README; Node v25.2.1 was the local default — Node 25 is EOL, not LTS; nvm, docker, docker compose, local Postgres@5432 all present)
- [x] Propose architecture, Prisma model (20 models, 3 merges proposed), risks, Node 24.x LTS, Docker Compose port 55432, Phase 1 commands
- [x] Write `docs/IMPLEMENTATION_PLAN.md`, `docs/TASKS.md`, `docs/DECISIONS.md`, `docs/ARCHITECTURE.md`
- [x] User approved the Phase 0 plan
- [x] User said `continue` to authorize Phase 1

## Phase 1 — Foundation — done

- [x] Node 24.18.0 installed via nvm; `.nvmrc` pinned to the exact patch
- [x] Root `package.json` with `workspaces: ["apps/*", "packages/*"]`, `engines.node: ">=24 <25"`
- [x] `apps/web`: `create-next-app` (TypeScript, Tailwind, ESLint, App Router, `src/`, `@/*` alias)
- [x] `packages/core`: `src/`, `prisma/`, deps `zod`, `@prisma/client`, `@prisma/adapter-pg`; devDeps `prisma`, `typescript`, `vitest`, `tsx`, `dotenv`
- [x] `packages/mcp-server`: placeholder scaffold only, no logic yet
- [x] Prisma schema at `packages/core/prisma/schema.prisma` — 20-model set from Phase 0, all 3 approved merges applied (`TestResult`→`TestCase`, `SupplierUpdate`→`ProgramEvent`, `Approval`→`Decision`)
- [x] `docker-compose.yml`: Postgres service, host port `55432`, `missionthread_dev` + `missionthread_test` logical databases (via `docker/init-test-db.sh`)
- [x] `.env.example`, `.env.test.example` at repo root reflecting the 55432 port and `DATABASE_URL` / `TEST_DATABASE_URL`; `apps/web/.env` is a symlink to the root `.env` (Next.js only reads env files from its own directory)
- [x] Migration + deterministic seed script using fixed seed IDs from `SPEC.md` §4, exact seed counts (8 requirements, 6 components, 8 milestones, 8 dependency edges, 8 tests mixed outcomes, 4 risks, 5 budget items, 3 suppliers, 3 defects, 4 events, 3 users) — verified in both `missionthread_dev` and `missionthread_test`
- [x] Auth.js v5 (`next-auth@5.0.0-beta.31`) Credentials provider, JWT session strategy explicit, Zod-validated input, `crypto.scrypt` + `crypto.timingSafeEqual` password verification, no Account/Session/VerificationToken models, no middleware/proxy (auth checked via `auth()` in server layouts/pages)
- [x] 3 seeded demo users, one per role — login flow verified end-to-end via real HTTP requests (correct credentials succeed, wrong password rejected, session role surfaced correctly for all 3 roles)
- [x] Base layout / nav shell — clean/flat Tailwind design, `/`, `/programs/edgelink-x`, `/audit` all render behind auth
- [x] Test-reset script (`packages/core/scripts/reset-test-db.ts`) refuses to run unless target DB name contains "test" — verified it refuses against `missionthread_dev` and succeeds against `missionthread_test`.
      **Superseded by the 2026-07-18 correction pass** (substring→token-boundary+allowlist) **and the 2026-07-18 second correction pass** (allowlist→exact approved `(host, port, database)` target tuples; a name merely containing "test" on an unapproved port/host no longer passes). See "Phase 1 second correction pass" below.
- [x] `.github/workflows/ci.yml`: install with lockfile, `node-version-file: .nvmrc`, `prisma validate` + `generate`, lint, format check, type check, unit tests, production build; `AI_MODE=mock` always.
      **Superseded by the correction passes:** CI now also includes a real `postgres:17-alpine` service, `permissions: contents: read`, migration + deterministic seed against that service database, a production build, and an application smoke test — see "Phase 1 correction pass" and "Phase 1 second correction pass" below.
- [x] `.dockerignore`, `Dockerfile` stub (not build-tested; full Docker build verification is Phase 8).
      **Superseded by the 2026-07-18 correction pass:** standalone Docker image built, started, and `/login` verified live (see below) — Docker support exists now, not deferred to Phase 8.
- [x] Ran full Phase 1 quality gate locally — see Phase 1 report in conversation / commit history for details; all checks passed
- [x] Updated this file and `docs/DECISIONS.md`

### Known Phase 1 blockers/risks carried forward

- `next-auth` pinned to the v5 **beta** channel (`5.0.0-beta.31`) — the version Auth.js's own current docs recommend for the App Router, but pre-1.0.
- Moderate `npm audit` advisories in transitive dev-tooling dependencies (nested `@prisma/dev` → old `@hono/node-server`; Next's bundled `postcss` copy). Suggested auto-fixes downgrade Prisma/Next to breaking versions — not applied. Revisit when upstream ships non-breaking patches.
- A real deployment needs `AUTH_TRUST_HOST=true` or an explicit `AUTH_URL` set at runtime (Auth.js v5 rejects untrusted `Host` headers by default) — not needed for local dev. Now documented with a runtime example in README.md "Docker" (2026-07-18 second correction pass).

## Phase 1 correction pass — done (2026-07-18)

Independent review requested against the Phase 1 implementation; findings were verified against the actual repository (not accepted blindly) before fixing. Full disposition and verification detail is in `docs/DECISIONS.md`'s 2026-07-18 "(correction pass)" entries and this repository's commit history. Summary of what changed:

- [x] **Critical:** fixed a malformed-hash authentication bypass in `verifyPassword` (empty-buffer `timingSafeEqual` true-positive) — reproduced, fixed with full field validation, switched to async `crypto.scrypt`, 22 new regression tests.
- [x] Replaced substring-based test-database-name matching with a token-boundary rule + allowlist; built one shared `checkDestructiveOperationAllowed()` guard (production check, host allowlist, database-name allowlist, explicit `ALLOW_DESTRUCTIVE_DATABASE_OPERATION=true` opt-in, sanitized error messages) now used by both `reset-test-db.ts` and `seed.ts`'s previously-unguarded clear step; positive + negative unit tests.
- [x] Deterministic IDs for `User` (`USER-PM`/`USER-ENG-LEAD`/`USER-EXEC`) and `Dependency` (`DEP-001`..`DEP-008`); each demo user now gets its own `hashPassword()` call (was one shared hash/salt for all three).
- [x] `RecordType` expanded (added `DEPENDENCY` + workflow-entity kinds) plus three Zod context allowlists (`evidenceRecordTypeSchema`, `proposedChangeTargetTypeSchema`, `auditTargetTypeSchema`); `SourceReference` uniqueness constraint; `Decision.traceId` index. Migration `20260718055852_expand_record_type_and_add_constraints`, applied to both databases.
- [x] Documented the `ImpactAnalysis` one-row-per-attempt lifecycle decision (no schema change).
- [x] Repaired the Dockerfile (Next standalone output, non-secret build-time `DATABASE_URL`, no root `package.json` needed at runtime) — build, container start, and `GET /login` all verified live; container and test image cleaned up afterward.
- [x] Neutralized remaining tool-identifying wording (`docs/DECISIONS.md` x2, `docs/assets/README.md`); removed the tracked `.gitignore` entry for the tool-specific local settings directory in favor of a local, unshared `.git/info/exclude` entry.
- [x] Wired up the real banner image (1280×640, now present at `docs/assets/missionthread-ai-banner.png`); removed the stale placeholder note; replaced `apps/web/README.md` boilerplate.
- [x] Corrected Node-25-EOL wording in `docs/TASKS.md`/`docs/DECISIONS.md`; marked `docs/ARCHITECTURE.md` sections as implemented vs. planned; changed `package.json` description from "agentic" to "AI-assisted".
- [x] Expanded `packages/core`'s lint script to cover `prisma/seed.ts`, `scripts/`, `prisma.config.ts`, `vitest.config.ts` (previously only `src/`).
- [x] Consolidated `/`, `/audit`, `/programs/edgelink-x` under one `(app)` route group + shared layout (`requireSession()`/`Nav` called once, not 3×); added active-link nav state and a horizontal-scroll mobile nav treatment.
- [x] Added an automated 21-check smoke test (`apps/web/scripts/smoke-test.mjs`, `npm run smoke:test`) covering auth, session contents, dashboard data, and sign-out against the dedicated test database; hardened CI with a real `postgres:17-alpine` service, `permissions: contents: read`, a non-secret CI `AUTH_SECRET`, migrate+seed steps, and a smoke-test step.
- [x] Re-ran the full quality gate after all changes: lint, format check, typecheck (3 workspaces), 60 unit tests, production build, and the smoke test (21/21) all pass.

## Phase 1 second correction pass — done (2026-07-18)

A second independent review, verified against the actual repository before fixing (not accepted blindly). Full disposition and verification detail is in `docs/DECISIONS.md`'s "(second correction pass)" entries and this repository's commit history. Summary of what changed:

- [x] Replaced independent host/database-name allowlists with exact `(host, port, database)` target tuples (`ApprovedDatabaseTarget`) — closes a real gap where the port was never validated (`localhost:5432/missionthread_dev`, the wrong port, would previously have passed). Added a CI-only target tuple that only matches when `CI=true`. Dropped a dead `"postgres"` (Compose-internal hostname) allowlist entry — no application container currently resolves it. Intentionally omitted IPv6 support (verified Node's `URL.hostname` bracket-wraps `"::1"` as `"[::1]"`, which the previous unbracketed allowlist entry could never have matched anyway). 39 new/updated unit tests, all passing.
- [x] Removed `ALLOW_DESTRUCTIVE_DATABASE_OPERATION=true` from `.env.example`/`.env.test.example` (previously shipped as permanently enabled). Destructive commands renamed for obvious intent: `packages/core` scripts are now `db:seed:internal`/`db:reset:test:internal`; root scripts `db:seed:destructive` and `db:reset:test` supply the opt-in flag only for their own child process via a new cross-platform `scripts/with-destructive-auth.mjs` wrapper. CI's seed step now sets the flag only on that one step, not workflow-wide.
- [x] Replaced the `docs/DECISIONS.md` entry naming the third-party destructive-operation safety mechanism and quoting the authorization exchange with a neutral, permanent "Destructive-operation authorization policy" (fresh authorization required per invocation, never reused).
- [x] Fixed remaining Node-25 wording in README.md (was "Current-only") to the exact required sentence; audited `docs/IMPLEMENTATION_PLAN.md`/`docs/ARCHITECTURE.md` — neither mentioned Node 25.
- [x] Annotated this file's stale Phase 1 entries (test-reset description, CI description, Dockerfile description) as superseded rather than silently rewriting them — see above.
- [x] README.md: split database commands into safe/non-destructive vs. destructive with the new command names; documented that seeding clears existing data; added `npm run smoke:test` to the quality gate section; added a full "Docker" section (`docker build`, a runtime example using `host.docker.internal` since a container can't reach the host's Postgres via its own `localhost`, required runtime variables, `AUTH_TRUST_HOST`). Fixed the Dockerfile's comment claiming `docker-compose.yml` defines application runtime config (it only defines the Postgres service).
- [x] Hardened `apps/web/scripts/smoke-test.mjs`: added `checkRedirectToLogin()`, which verifies both the redirect status code and that `Location` actually resolves to `/login` with no query string (previously only the status code was checked); replaced the brittle `dashboardHtml.includes(">8<")` requirement-count assertion with `data-testid="stat-value-requirementCount"`/`stat-label-requirementCount` attributes on the dashboard page and a `getTestIdText()` helper that reads the specific labeled value.
- [x] Documented two deferred Phase 4/5 schema decisions without implementing them: `ProposedChangeType.NEW_ACTION` conflicts with `ProposedChange`'s non-nullable target fields (planned fix: nullable fields + Zod discriminated union, Phase 5); `ImpactAnalysis` has no stable grouping key for retry-pair attempts (planned fix: `analysisRunId` + `(analysisRunId, attempt)` uniqueness, Phase 4). Added matching inline schema comments. No schema/migration change made — SPEC.md doesn't require either before Phase 2.
- [x] Added the standing contextual-comment rule to `PROJECT_GUIDE.md` working rules.
- [x] Re-ran the full quality gate after all changes, plus a fresh Docker build/start/`/login` verification cycle — all passing.

## Phase 1 third correction pass — done (2026-07-18)

A third independent review, verified against the actual repository before fixing (not accepted blindly). Full disposition and verification detail is in `docs/DECISIONS.md`'s "(third correction pass)" entries and this repository's commit history. Summary of what changed:

- [x] The GitHub Actions target tuple now requires `GITHUB_ACTIONS=true` specifically, not the generic `CI=true` (which other CI providers and local shells can also set). Renamed `requiresCi`→`requiresGitHubActions` and `CI_TEST_TARGETS`→`GITHUB_ACTIONS_TEST_TARGETS` throughout. 16 new/updated unit tests.
- [x] Destructive seed commands are now target-specific instead of one command authorizing whichever target `DATABASE_URL` happened to point at. `seed.ts` requires an explicit `MISSIONTHREAD_SEED_SCOPE` (`dev`/`test`/`github-actions`, resolved via the new `resolveSeedScopeTargets()`), set only for the seed child process by an extended `scripts/with-destructive-auth.mjs --scope=<value>`. Public commands: `npm run db:seed:dev:destructive` (dev only), `npm run db:reset:test` (test only, unchanged name), `npm run db:seed:github-actions:internal` (CI only, not a local-development command). The old unscoped `db:seed:destructive` no longer exists.
- [x] `.github/workflows/ci.yml`'s seed step now calls `db:seed:github-actions:internal` instead of the old generic command; the workflow-level `env:` block still sets no destructive-authorization variables.
- [x] Marked the first correction pass's now-fully-superseded "Shared destructive-database-operation guard" entry in `docs/DECISIONS.md` with a prominent superseded notice pointing to the second and third pass entries, rather than leaving it to be mistaken for current behavior.
- [x] Replaced remaining private-conversation-dependent and tool-identifying wording in this file ("the conversation['s ...] report" ×2, `.claude/`, "AI-agent consent mechanism") with durable, neutral wording pointing at `docs/DECISIONS.md` and commit history.
- [x] README.md: renamed `db:seed:destructive` references to `db:seed:dev:destructive`, documented the three-command split (dev/test/CI) and that scope is never inferred from `DATABASE_URL`, and replaced the hardcoded "21 checks" smoke-test count with non-stale wording pointing at the script itself.
- [x] Re-ran the full quality gate after all changes; re-verified the target-specific destructive commands live against their intended local databases.

## Phase 2 — Deterministic program logic (not started)

Will be filled in with the same granularity when Phase 2 is authorized.

## Phase 3 — Core workflow UI (not started)

## Phase 4 — AI impact analysis (not started)

## Phase 5 — Approval and audit (not started)

## Phase 6 — Security and evals (not started)

## Phase 7 — Graph and MCP (not started)

## Phase 8 — Delivery (not started)
