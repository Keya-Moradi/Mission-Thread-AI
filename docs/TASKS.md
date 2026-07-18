# Tasks

Status legend: `[ ]` not started · `[~]` in progress · `[x]` done

This file must stay detailed enough for a new session to resume without chat history.

## Phase 0 — Plan

- [x] Place `PROJECT_GUIDE.md`, `docs/SPEC.md`
- [x] Inspect repository (empty except README; Node v25.2.1 local/Current, not LTS; nvm, docker, docker compose, local Postgres@5432 all present)
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
- 3 moderate `npm audit` advisories in transitive dev-tooling dependencies (nested `@prisma/dev` → old `@hono/node-server`; Next's bundled `postcss` copy). Suggested auto-fixes downgrade Prisma/Next to breaking versions — not applied. Revisit when upstream ships non-breaking patches.
- Dockerfile is written but not build-verified yet.

## Phase 2 — Deterministic program logic (not started)

Will be filled in with the same granularity when Phase 2 is authorized.

## Phase 3 — Core workflow UI (not started)

## Phase 4 — AI impact analysis (not started)

## Phase 5 — Approval and audit (not started)

## Phase 6 — Security and evals (not started)

## Phase 7 — Graph and MCP (not started)

## Phase 8 — Delivery (not started)
