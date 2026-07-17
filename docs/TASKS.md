# Tasks

Status legend: `[ ]` not started · `[~]` in progress · `[x]` done

This file must stay detailed enough for a new session to resume without chat history.

## Phase 0 — Plan
- [x] Place `CLAUDE.md`, `docs/SPEC.md`
- [x] Inspect repository (empty except README; Node v25.2.1 local/Current, not LTS; nvm, docker, docker compose, local Postgres@5432 all present)
- [x] Propose architecture, Prisma model (20 models, 3 merges proposed), risks, Node 24.x LTS, Docker Compose port 55432, Phase 1 commands
- [x] Write `docs/IMPLEMENTATION_PLAN.md`, `docs/TASKS.md`, `docs/DECISIONS.md`, `docs/ARCHITECTURE.md`
- [x] User approved the Phase 0 plan
- [ ] User says `continue` to authorize Phase 1

## Phase 1 — Foundation (not started)
- [ ] `nvm install 24 && nvm use 24`; `.nvmrc` pinned to resolved 24.x patch
- [ ] Root `package.json` with `workspaces: ["apps/*", "packages/*"]`, `engines.node` matching `.nvmrc`
- [ ] `apps/web`: `create-next-app` (TypeScript, Tailwind, ESLint, App Router, `src/`, `@/*` alias)
- [ ] `packages/core`: `src/`, `prisma/`, deps `zod`, `@prisma/client`; devDeps `prisma`, `typescript`, `vitest`
- [ ] `packages/mcp-server`: placeholder scaffold only, no logic yet
- [ ] Prisma schema at `packages/core/prisma/schema.prisma` — 20-model set from Phase 0 (confirm 3 merges: `TestResult`→`TestCase`, `SupplierUpdate`→`ProgramEvent`, `Approval`→`Decision`)
- [ ] `docker-compose.yml`: Postgres service, host port `55432` (local Postgres already owns 5432), dev + test logical databases
- [ ] `.env.example`, `.env.test.example` reflecting the 55432 port and `DATABASE_URL` / `TEST_DATABASE_URL`
- [ ] Migration + deterministic seed script using fixed seed IDs from `SPEC.md` §4 (`PROGRAM-EDGELINK-X`, `SUP-NORTHSTAR`, `COMP-EC440`, `REQ-001`, `MS-001`, `TEST-001`, `RISK-001`, `BUDGET-001`, `EVT-SUPPLIER-001`, plus the full seed counts in §4)
- [ ] Auth.js Credentials provider + `crypto.scrypt` password hashing (check current Auth.js docs/types before wiring — don't assume a remembered API)
- [ ] 3 seeded demo users, one per role (Program Manager, Engineering Lead, Executive Viewer)
- [ ] Base layout / nav shell
- [ ] Test-reset script refuses to run unless target DB name contains a test marker (e.g. `missionthread_test`)
- [ ] `.github/workflows/ci.yml`: install with lockfile, pinned Node, `prisma validate`, lint, format check, type check, available unit tests, production build; `AI_MODE=mock` always
- [ ] `.dockerignore`, `Dockerfile` stub (full Docker build completes in Phase 8)
- [ ] Run Phase 1 quality gate; fix failures or document a genuine blocker
- [ ] Update this file and `docs/DECISIONS.md`; summarize files/commands/checks/risks; STOP

## Phase 2 — Deterministic program logic (not started)
Will be filled in with the same granularity when Phase 2 is authorized.

## Phase 3 — Core workflow UI (not started)
## Phase 4 — AI impact analysis (not started)
## Phase 5 — Approval and audit (not started)
## Phase 6 — Security and evals (not started)
## Phase 7 — Graph and MCP (not started)
## Phase 8 — Delivery (not started)
