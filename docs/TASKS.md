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
- [x] Destructive seed commands are now target-specific instead of one command authorizing whichever target `DATABASE_URL` happened to point at. `seed.ts` requires an explicit `MISSIONTHREAD_SEED_SCOPE` (`dev`/`test`/`github-actions`, resolved via the new `resolveSeedScopeTargets()`), set only for the seed child process by an extended `scripts/with-destructive-auth.mjs --scope=<value>`. Public, local-development commands: `npm run db:seed:dev:destructive` (dev only) and `npm run db:reset:test` (test only, unchanged name). Separately, `npm run db:seed:github-actions:internal` is an internal, CI-only command — it is never intended to be run locally by a developer, only by `.github/workflows/ci.yml` against the GitHub Actions service-container database. The old unscoped `db:seed:destructive` no longer exists.
- [x] `.github/workflows/ci.yml`'s seed step now calls `db:seed:github-actions:internal` instead of the old generic command; the workflow-level `env:` block still sets no destructive-authorization variables.
- [x] Marked the first correction pass's now-fully-superseded "Shared destructive-database-operation guard" entry in `docs/DECISIONS.md` with a prominent superseded notice pointing to the second and third pass entries, rather than leaving it to be mistaken for current behavior.
- [x] Replaced remaining private-conversation-dependent and tool-identifying wording in this file ("the conversation['s ...] report" ×2, `.claude/`, "AI-agent consent mechanism") with durable, neutral wording pointing at `docs/DECISIONS.md` and commit history.
- [x] README.md: renamed `db:seed:destructive` references to `db:seed:dev:destructive`, documented the three-command split (dev/test/CI) and that scope is never inferred from `DATABASE_URL`, and replaced the hardcoded "21 checks" smoke-test count with non-stale wording pointing at the script itself.
- [x] Re-ran the full quality gate after all changes; re-verified the target-specific destructive commands live against their intended local databases.

## Phase 2 — Deterministic program logic — done (2026-07-18)

All eleven `SPEC.md` §8 functions implemented in `packages/core/src/analysis/`, read-only, no AI dependency, no new Prisma models/migrations. Full disposition and every formula/ambiguity decision is in `docs/DECISIONS.md`'s "(Phase 2)" entries.

- [x] Inspected the actual schema and seed relationships before implementing (Component↔Requirement via `RequirementComponent`; Component→Milestone direct + `Dependency` DAG for cascades; Requirement↔TestCase via `TestRequirement`; Defect→TestCase via `relatedTestCaseId`; Risk/BudgetItem→Component; `ProgramEvent`→Component/Supplier). No ambiguity required a schema change; none was made.
- [x] Module structure: `packages/core/src/analysis/{types,schemas,traceability,dependencies,verification,defects,budget,schedule,risk,readiness,evidence,index}.ts`. Public API re-exported through `packages/core/src/index.ts`.
- [x] One consistent error strategy for the whole layer: every function returns `ServiceResult<T> = { ok: true; data } | { ok: false; error: DomainError }` (`NOT_FOUND` / `VALIDATION_ERROR`); nothing throws for an expected failure; raw Prisma errors never reach a caller.
- [x] Input validation via Zod (`entityIdSchema`, `entityIdArraySchema`): rejects empty, whitespace-only, and padded IDs; rejects duplicate IDs in array inputs; empty arrays are accepted (not malformed).
- [x] `getImpactedRequirements(componentId)` / `getImpactedMilestones(componentId)` — direct links plus (for milestones) dependency-derived cascade impacts, deduplicated, deterministically ordered. 11 tests including a live "existing component, zero links" case (temporary isolated fixture, cleaned up).
- [x] `getDependencyChain(milestoneId)` — `fromMilestoneId` is upstream (prerequisite), `toMilestoneId` is downstream (dependent), returned as separate arrays. Cycle/duplicate-edge protection implemented in a pure, DB-free BFS (`traverseDependencyChain`) unit-tested directly with fabricated cyclic/branching/duplicate-edge data — no cycle was ever seeded into Postgres. One query for every edge/milestone in a program, not one per hop. 13 tests.
- [x] `getVerificationGaps(requirementIds)` — worst-outcome-wins gap classification (FAILED > BLOCKED > NOT_RUN > NONE; zero tests = NO_COVERAGE), missing requirement IDs reported explicitly, not dropped. 10 tests.
- [x] `getRelatedDefects(requirementIds)` — Requirement→TestCase→Defect path only, never text matching; pure grouping step (`groupRelatedDefects`) unit-tested with synthetic multi-requirement-per-defect and duplicate-link data the real seed doesn't naturally exercise. 9 tests.
- [x] `calculateBudgetVariance(programId)` / `calculateBudgetExposure(eventId)` — `Prisma.Decimal` arithmetic throughout (no binary-float drift), `varianceAmount = actual - planned` sign convention, mixed-currency handling (`byCurrency` breakdown, top-level fields `null` rather than a wrong cross-currency sum), zero-planned-amount handled as `null` percentage. Exposure is bounded to budget items linked via the event's component; `totalDeterministicExposure` is documented as "budget at risk," not an invented incremental delay cost (schema has no such field). 13 tests.
- [x] `calculateScheduleExposure(eventId)` — UTC calendar-day arithmetic (`utcDayDifference`/`addUtcDays`, pure and unit-tested independent of the DB: 28-day seed case, same-day, reversed, month boundary, leap year); detects and reports (never silently accepts) a stored `delayDays` that disagrees with the two dates; `latestExposedDate` = max(impacted milestone planned date + direct delay). 13 tests.
- [x] `calculateRiskScore(riskId)` — `probability × impact`, documented band mapping (1–4 LOW / 5–9 MEDIUM / 10–14 HIGH / 15–25 CRITICAL), never lets a stored severity label silently override the numeric result. Surfaced a genuine pre-existing seed inconsistency: `RISK-003` computes LOW but is stored as MEDIUM — kept as-is and regression-tested, not "fixed" by changing seed data. 10 tests.
- [x] `calculateReadinessScore(programId)` — 5 equal-weighted (20 pts each) factors: verification coverage, test health, milestone health, defect health, risk health; missing data scores a factor as neutral (full 20 pts) with a warning, never as a penalty; rounded total clamped to [0, 100]. EdgeLink-X's exact seeded score (56/100) locked in as a regression test, with each factor's sub-score independently asserted. 6 tests.
- [x] `buildAnalysisEvidence(eventId)` — composes every above service; evidence items are `{ recordId, recordType, summary }` built only from validated fields; `ProgramEvent.rawNotes` (the seeded prompt-injection sentence) is exposed only as a separate `untrustedSupplierNotes` field, never inside `evidence[]`, and never read by any calculation. Deduplicated by `recordType+recordId`, deterministically ordered. For the seeded `EVT-SUPPLIER-001`, all 11 `EVIDENCE_RECORD_TYPES` categories are present with exactly the expected record IDs, and unrelated records (other suppliers, battery's risk/requirement/budget item, other events) are proven absent. 10 tests.
- [x] Test infrastructure: `packages/core/src/test/setup-env.ts` (new Vitest `setupFiles` entry) force-loads `.env.test` and hard-fails the whole run if `DATABASE_URL` doesn't resolve to the approved local test target — database-backed Phase 2 tests can never accidentally run against `missionthread_dev`. A handful of tests create small, uniquely-IDed temporary fixtures (isolated component, temp programs, temp events) for scenarios the standard seed doesn't naturally cover, always cleaned up in `afterAll`/`finally`.
- [x] 95 new tests added (134 → 229 total), all passing; no existing Phase 1 test weakened or removed.
- [x] Fixed an unrelated, pre-existing local environment issue discovered while typechecking: an apparent file-sync tool had left hundreds of `"<name> 2"`-suffixed duplicate files inside `node_modules` and `apps/web/.next` (both fully regenerable, gitignored build artifacts) on the local machine, breaking `tsc`. Removed and regenerated; not a code or repository issue.
- [x] Re-ran the full quality gate: install, `db:validate`, `db:generate`, lint, format check, typecheck (all 3 workspaces), 229 unit tests, production build, `db:reset:test` + full retest against the freshly reset database, smoke test — all passing.
- [x] Updated `docs/ARCHITECTURE.md` (new "Deterministic program-analysis services" section) and `README.md` (project status, roadmap table, architecture summary) to reflect Phase 2 completion.

## Phase 2 correction pass — done (2026-07-18)

A narrowly-scoped review confirmed two real, reproducible functional blockers in the Phase 2 build (not yet caught because CI had never actually run these tests). Full disposition and detail is in `docs/DECISIONS.md`'s "(Phase 2 correction pass)" entries. Summary of what changed:

- [x] **Blocker 1 fixed:** the Vitest database-selection logic only ever validated against the local `(host, port, database)` tuples, so every database-backed Phase 2 test would have failed the first time CI actually ran them (CI's Postgres service is `localhost:5432`, not the local `localhost:55432`). Extracted a pure, DB-free `resolveTestDatabaseConfiguration(env)` (`packages/core/src/test/resolve-test-database-configuration.ts`) that selects the GitHub Actions context (`GITHUB_ACTIONS=true`, never touches `.env.test`, validates against `GITHUB_ACTIONS_TEST_TARGETS`) or the local context (loads `.env.test` with `override: true`, validates against `LOCAL_TEST_TARGETS`) — no allowlist was broadened. 18 new unit tests, no database connection or file I/O in any of them.
- [x] **Blocker 1, part 2 fixed:** `.github/workflows/ci.yml` ran unit tests _before_ migrating and seeding the CI database — reordered to install → schema validation → Prisma generation → lint → format check → type check → migrate → seed → tests → build → smoke test. Verified live locally by simulating both `GITHUB_ACTIONS=true` (correct CI target passes) and wrong-port/CI-only-without-GITHUB_ACTIONS (correctly rejected) scenarios.
- [x] **Blocker 2 fixed:** `buildAnalysisEvidence()` was discarding the actual structured output of every sub-service (`VerificationGapsResponse`, `RelatedDefectsResponse`, `ScheduleExposureResult`, `BudgetExposureResult`, `ReadinessScoreResult`) and never called `calculateRiskScore()` at all for risk evidence (a hand-rolled query kept only `severity`/`status`, discarding probability, impact, numeric score, computed band, and the severity-consistency flag). `AnalysisEvidence` now carries the complete result of every sub-service directly — `eventFacts`, `impactedRequirements`, `impactedMilestones`, `verificationGaps`, `relatedDefects`, `scheduleExposure`, `budgetExposure`, `riskScores`, `readinessScore` — reusing each service's own public type, alongside the existing bounded `evidence[]`/`assumptions`/`unknowns`.
- [x] `eventFacts.computedDelayDays`/`delayDaysConsistent` are now populated directly from `calculateScheduleExposure()`'s own authoritative result, not a separate read of `event.delayDays`; `storedDelayDays` is still reported alongside it so a disagreement stays visible.
- [x] `event.reason` (previously embedded directly in the trusted event-evidence summary) now joins `event.rawNotes` as untrusted free text — both isolated in a new `untrustedText: { reason, rawNotes }` field, replacing `untrustedSupplierNotes`, never read by any calculation, never in `evidence[]`.
- [x] Added explicit, documented evidence bounds (`EVIDENCE_LIMITS`: 100 total items, 25 per record type, 500-character summaries, 4,000-character untrusted-text fields) via pure, exported `applyEvidenceBounds()`/`truncateText()` — deterministic ordering preserved, every truncation produces an `unknowns` entry, and truncation is proven surrogate-pair-safe (never splits a UTF-16 astral character, e.g. an emoji, in half).
- [x] `evidence.test.ts` rewritten and expanded (10 → 26 tests): exact seeded values for schedule/budget/verification/defects/risk/readiness, a dedicated trust-boundary suite proving the supplier-injection phrase (and `event.reason`'s text) appears only in `untrustedText` and nowhere else, and bounds tests (summary/item-limit truncation, surrogate-pair safety, deterministic repeatability) using synthetic data.
- [x] No existing Phase 2 service (`ServiceResult<T>`, input validation, BFS traversal, cycle/duplicate protection, decimal-safe budget arithmetic, schedule inconsistency detection, risk-score formula, readiness formula, evidence deduplication/ordering) was redesigned or weakened — only the evidence _composition_ layer changed.
- [x] 34 new tests added (229 → 263 total), all passing; no existing test weakened or removed.
- [x] Re-ran the full quality gate: install, `db:validate`, `db:generate`, `db:reset:test`, lint, format check, typecheck (all 3 workspaces), 263 unit/integration tests, production build, smoke test — all passing. Confirmed local tests use only `localhost:55432/missionthread_test`.

## Phase 3 — Core workflow UI (not started)

## Phase 4 — AI impact analysis (not started)

## Phase 5 — Approval and audit (not started)

## Phase 6 — Security and evals (not started)

## Phase 7 — Graph and MCP (not started)

## Phase 8 — Delivery (not started)
