# Architecture

This document describes the **target** architecture established during
Phase 0 planning. Sections are marked with what phase actually builds them;
see [`docs/TASKS.md`](TASKS.md) for what exists in the repository right now.
As of this writing, Phase 1 (workspaces, schema, seed data, auth, base
shell) and Phase 2 (deterministic program-analysis services) are complete;
everything under "AI", most of "Observability", and the UI/route-handler
side of "Request / data flow" below is still planned, not implemented.

## Workspaces

- `apps/web` — Next.js App Router UI + route handlers/server actions. _(Phase 1: scaffold, auth, base shell. Phases 3–5: dashboard, event entry, analysis workspace, approval UI.)_
- `packages/core` — Zod schemas, deterministic services, Prisma schema/client. _(Phase 1: schema, auth, seed, db-safety. Phase 2: deterministic services — done. Phase 4: AI evidence builder + `LLMProvider`, mock fixtures, prompts.)_
- `packages/mcp-server` — Phase 7: read-only MCP tools reusing `packages/core`. _(Not started — placeholder package only.)_

## Deterministic program-analysis services — implemented (Phase 2)

`packages/core/src/analysis/` implements every function `SPEC.md` §8 requires, read-only and with no AI dependency:

```text
getImpactedRequirements(componentId)    traceability.ts
getImpactedMilestones(componentId)      traceability.ts
getDependencyChain(milestoneId)         dependencies.ts
getVerificationGaps(requirementIds)     verification.ts
getRelatedDefects(requirementIds)       defects.ts
calculateBudgetVariance(programId)      budget.ts
calculateBudgetExposure(eventId)        budget.ts
calculateScheduleExposure(eventId)      schedule.ts
calculateRiskScore(riskId)              risk.ts
calculateReadinessScore(programId)      readiness.ts
buildAnalysisEvidence(eventId)          evidence.ts
```

Every function returns a `ServiceResult<T>` (`{ ok: true, data } | { ok: false, error }`) instead of throwing for expected failures (missing record, invalid input) — see `docs/DECISIONS.md` for the full error-strategy, dependency-traversal-direction, schedule/budget/risk-formula, and evidence-bounding decisions, all documented before implementation. Pure calculation cores (dependency-graph traversal, budget decimal arithmetic, risk-score/band mapping, UTC date-difference math, verification-gap classification, defect grouping, evidence-bounds truncation, test-database context selection) are separated from their Prisma-backed wrappers and unit-tested independently of the database; the wrappers themselves are tested against the dedicated `missionthread_test` database's deterministic seed fixtures. `packages/core/src/test/setup-env.ts` selects between two validated database contexts before any test file runs — local development (`.env.test` loaded with `override: true`, `localhost:55432`) or GitHub Actions (`GITHUB_ACTIONS=true`, `.env.test` never touched, `localhost:5432`) — via the pure `resolveTestDatabaseConfiguration()` in the same directory, so these tests can never accidentally hit `missionthread_dev` in either context.

`buildAnalysisEvidence(eventId)` is the composition point: it returns not just the bounded, allowlisted `evidence[]` array but the complete structured result of every sub-service it calls (`eventFacts`, `impactedRequirements`, `impactedMilestones`, `verificationGaps`, `relatedDefects`, `scheduleExposure`, `budgetExposure`, `riskScores`, `readinessScore`), reusing each service's own public type rather than a summarized/lossy copy — see docs/DECISIONS.md, "buildAnalysisEvidence now returns the full structured deterministic analysis." Free text (`event.reason`, `event.rawNotes`) is isolated in a separate `untrustedText` field, never embedded in a trusted summary and never read by any calculation. `evidence[]` itself is bounded (100 items total, 25 per record type, 500-character summaries, 4,000-character untrusted-text fields) with deterministic, surrogate-pair-safe truncation.

None of this is called from `apps/web` yet — Phase 3 wires a dashboard, event entry, and audit shell onto real data; Phase 4 is what actually calls `buildAnalysisEvidence()` from an event-intake route and feeds its structured output (and separately, its isolated `untrustedText`) to an `LLMProvider`.

## Request / data flow — the AI/approval/apply portion is planned (Phases 3–5), not yet implemented

```
Program Manager submits supplier delay
  -> apps/web: POST /programs/edgelink-x/events (Zod-validated, server-side auth check)
  -> packages/core: buildAnalysisEvidence(eventId)              [Phase 2 — done]
       - getImpactedRequirements / getImpactedMilestones / getDependencyChain
       - getVerificationGaps / getRelatedDefects
       - calculateScheduleExposure / calculateBudgetExposure
       - assembles bounded, allowlisted evidence (record id + type + safe summary)
  -> LLMProvider (mock in dev/CI, live optional) -> strict Zod-validated structured output
       (exec summary, exposures, 3 mitigation options, assumptions, unknowns, confidence, source IDs)
       on failure: 1 retry -> persist FAILED analysis + AuditEvent, schema never loosened
  -> Analysis workspace UI -> Program Manager approves / rejects / requests revision
  -> Decision + AuditEvent recorded -> apply-preview screen (old/new values) -> explicit confirm
  -> DB transaction applies ProposedChanges (milestones/risks/budget/new actions) + AuditEvent
```

The event-intake route, the AI call, and the approval/apply path are not
wired up yet. Today, `apps/web` only reads a handful of counts from
Postgres for the dashboard shell — there is no event intake, no route that
calls `buildAnalysisEvidence()`, no AI call, and no approval or apply path.

## Domain model — implemented (Phase 1)

See `docs/DECISIONS.md` for the approved 20-model Prisma set, the three
merges applied to the `SPEC.md` §6 baseline (`TestResult`→`TestCase`,
`SupplierUpdate`→`ProgramEvent`, `Approval`→`Decision`), and the
`RecordType` allowlist design. Schema lives at
`packages/core/prisma/schema.prisma` and is migrated/seeded.

## Auth — implemented (Phase 1)

Auth.js Credentials provider; `crypto.scrypt` password hashes (validated
strictly on verify — see `docs/DECISIONS.md`); JWT sessions; server-side
session check via `auth()` in server layouts and pages. UI role-gating is
cosmetic only, never authoritative. Roles: Program Manager (full workflow —
not yet built), Engineering Lead (review + request revision — not yet
built), Executive Viewer (read-only). Role-based **authorization on
mutations** is planned for Phase 3+, once mutations exist.

## Persistence — implemented (Phase 1)

PostgreSQL via Prisma, single schema in `packages/core/prisma`. Dev and
test databases are separate logical databases in the same local Docker
Compose Postgres instance (host port `55432`, chosen to avoid colliding
with a local Postgres already on 5432), selected via `DATABASE_URL` vs
`TEST_DATABASE_URL`. Every destructive operation (test reset, dev reseed)
passes through the shared guard in `packages/core/src/db-safety.ts`.

## AI — planned (Phase 4), not yet implemented

`LLMProvider` interface with a mock implementation (deterministic, no API
key, used in CI/demo) and an optional live implementation (single provider
adapter, server-only secret). Prompts will live under
`packages/core/src/ai/prompts`. The model will receive only validated,
bounded evidence — never raw database dumps — and untrusted text (e.g.
supplier notes) will be passed as clearly isolated data, never as
instructions. None of this exists in the codebase yet.

## Observability — partially implemented

Structured JSON logging, per-analysis trace IDs, and UI trace-ID surfacing
are planned for Phase 4+, once there are analysis attempts to log. Today,
the only "observability" is Next's own dev/build console output and the
safe (credential-free) messages returned by the destructive-operation
guard.

## Deployment (MVP)

Local Docker Compose only (Postgres service). No cloud infrastructure, no
Kubernetes, no queues, no pgvector. See `README.md` for the current state
of the application Dockerfile.
