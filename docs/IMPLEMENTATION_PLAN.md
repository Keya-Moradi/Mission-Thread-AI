# Implementation Plan

Mirrors `SPEC.md` §19 phase-by-phase. Each phase lists deliverables and its quality gate. Only one phase is authorized at a time — see `PROJECT_GUIDE.md` hard-stop rules. `continue` authorizes exactly the next phase.

## Phase 0 — Plan (this session)

Deliverables: `PROJECT_GUIDE.md` and `docs/SPEC.md` placed; architecture, Prisma model, risks, Node LTS, and Phase 1 commands proposed and approved; `docs/IMPLEMENTATION_PLAN.md`, `docs/TASKS.md`, `docs/DECISIONS.md`, `docs/ARCHITECTURE.md` written. No implementation files written.

## Phase 1 — Foundation

npm workspaces (`apps/web`, `packages/core`, `packages/mcp-server`); strict TypeScript/lint/format; PostgreSQL + Prisma schema/migration/deterministic seed; Auth.js Credentials provider with `crypto.scrypt`; 3 seeded demo users (one per role); base layout; dev/test database configuration; `.env.example` / `.env.test.example`; Docker Compose Postgres service; minimal `.github/workflows/ci.yml`.

Gate: install with lockfile, `prisma validate`, migrate, seed, test-reset safety check, lint, format check, type check, foundational tests, production build.

## Phase 2 — Deterministic program logic

All traceability, schedule, budget, risk, readiness, verification, and evidence functions in `packages/core` (§8), fully unit-tested (direct/transitive impacts, cycles, missing data, date/budget math, risk scoring, readiness, verification gaps, evidence completeness). No AI dependency.

## Phase 3 — Core workflow UI

Dashboard, program overview, event entry, audit shell — real database data, server-side authorization on every mutation.

## Phase 4 — AI impact analysis

`LLMProvider` abstraction; mock and live adapters; prompts under `packages/core/src/ai/prompts`; strict Zod schema + source-ID validation; one-retry failure path; analysis workspace UI; readiness briefing; trace IDs; structured logs.

## Phase 5 — Approval and audit

Approval/decision state machine, apply-preview screen, transactional apply, append-only audit, integration tests, Playwright happy-path test.

## Phase 6 — Security and evals

`docs/THREAT_MODEL.md`, prompt-injection defenses, in-memory rate limiter (documented limitation), full mock eval suite (`evals/`), `npm run eval:live` command.

## Phase 7 — Graph and MCP

Database-driven React Flow thread view (`/programs/edgelink-x/thread`), then read-only `packages/mcp-server` if scope allows.

## Phase 8 — Delivery

CI expansion (integration tests, mock evals, Playwright, Docker build, dependency scanning), Docker completion, browser tests, diagrams/screenshots/demo script, one sanitized live-eval run (`docs/EVAL_RESULTS.md`), README polish, final verification against Definition of Done (`SPEC.md` §20).
