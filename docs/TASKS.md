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
- [x] Test-reset script (`packages/core/scripts/reset-test-db.ts`) refuses to run unless target DB name contains "test" — verified it refuses against `missionthread_dev` and succeeds against `missionthread_test`
- [x] `.github/workflows/ci.yml`: install with lockfile, `node-version-file: .nvmrc`, `prisma validate` + `generate`, lint, format check, type check, unit tests, production build; `AI_MODE=mock` always
- [x] `.dockerignore`, `Dockerfile` stub (not build-tested; full Docker build verification is Phase 8)
- [x] Ran full Phase 1 quality gate locally — see Phase 1 report in conversation / commit history for details; all checks passed
- [x] Updated this file and `docs/DECISIONS.md`

### Known Phase 1 blockers/risks carried forward

- `next-auth` pinned to the v5 **beta** channel (`5.0.0-beta.31`) — the version Auth.js's own current docs recommend for the App Router, but pre-1.0.
- Moderate `npm audit` advisories in transitive dev-tooling dependencies (nested `@prisma/dev` → old `@hono/node-server`; Next's bundled `postcss` copy). Suggested auto-fixes downgrade Prisma/Next to breaking versions — not applied. Revisit when upstream ships non-breaking patches.
- A real deployment needs `AUTH_TRUST_HOST=true` or an explicit `AUTH_URL` set at runtime (Auth.js v5 rejects untrusted `Host` headers by default) — not needed for local dev, noted for Phase 8.

## Phase 1 correction pass — done (2026-07-18)

Independent review requested against the Phase 1 implementation; findings were verified against the actual repository (not accepted blindly) before fixing. Full disposition and verification detail is in the conversation's correction-pass report and `docs/DECISIONS.md`'s 2026-07-18 "(correction pass)" entries. Summary of what changed:

- [x] **Critical:** fixed a malformed-hash authentication bypass in `verifyPassword` (empty-buffer `timingSafeEqual` true-positive) — reproduced, fixed with full field validation, switched to async `crypto.scrypt`, 22 new regression tests.
- [x] Replaced substring-based test-database-name matching with a token-boundary rule + allowlist; built one shared `checkDestructiveOperationAllowed()` guard (production check, host allowlist, database-name allowlist, explicit `ALLOW_DESTRUCTIVE_DATABASE_OPERATION=true` opt-in, sanitized error messages) now used by both `reset-test-db.ts` and `seed.ts`'s previously-unguarded clear step; positive + negative unit tests.
- [x] Deterministic IDs for `User` (`USER-PM`/`USER-ENG-LEAD`/`USER-EXEC`) and `Dependency` (`DEP-001`..`DEP-008`); each demo user now gets its own `hashPassword()` call (was one shared hash/salt for all three).
- [x] `RecordType` expanded (added `DEPENDENCY` + workflow-entity kinds) plus three Zod context allowlists (`evidenceRecordTypeSchema`, `proposedChangeTargetTypeSchema`, `auditTargetTypeSchema`); `SourceReference` uniqueness constraint; `Decision.traceId` index. Migration `20260718055852_expand_record_type_and_add_constraints`, applied to both databases.
- [x] Documented the `ImpactAnalysis` one-row-per-attempt lifecycle decision (no schema change).
- [x] Repaired the Dockerfile (Next standalone output, non-secret build-time `DATABASE_URL`, no root `package.json` needed at runtime) — build, container start, and `GET /login` all verified live; container and test image cleaned up afterward.
- [x] Neutralized remaining tool-identifying wording (`docs/DECISIONS.md` x2, `docs/assets/README.md`); removed the tracked `.gitignore` entry for `.claude/` in favor of a local, unshared `.git/info/exclude` entry.
- [x] Wired up the real banner image (1280×640, now present at `docs/assets/missionthread-ai-banner.png`); removed the stale placeholder note; replaced `apps/web/README.md` boilerplate.
- [x] Corrected Node-25-EOL wording in `docs/TASKS.md`/`docs/DECISIONS.md`; marked `docs/ARCHITECTURE.md` sections as implemented vs. planned; changed `package.json` description from "agentic" to "AI-assisted".
- [x] Expanded `packages/core`'s lint script to cover `prisma/seed.ts`, `scripts/`, `prisma.config.ts`, `vitest.config.ts` (previously only `src/`).
- [x] Consolidated `/`, `/audit`, `/programs/edgelink-x` under one `(app)` route group + shared layout (`requireSession()`/`Nav` called once, not 3×); added active-link nav state and a horizontal-scroll mobile nav treatment.
- [x] Added an automated 21-check smoke test (`apps/web/scripts/smoke-test.mjs`, `npm run smoke:test`) covering auth, session contents, dashboard data, and sign-out against the dedicated test database; hardened CI with a real `postgres:17-alpine` service, `permissions: contents: read`, a non-secret CI `AUTH_SECRET`, migrate+seed steps, and a smoke-test step.
- [x] Re-ran the full quality gate after all changes: lint, format check, typecheck (3 workspaces), 60 unit tests, production build, and the smoke test (21/21) all pass.

## Phase 2 — Deterministic program logic (not started)

Will be filled in with the same granularity when Phase 2 is authorized.

## Phase 3 — Core workflow UI (not started)

## Phase 4 — AI impact analysis (not started)

## Phase 5 — Approval and audit (not started)

## Phase 6 — Security and evals (not started)

## Phase 7 — Graph and MCP (not started)

## Phase 8 — Delivery (not started)
