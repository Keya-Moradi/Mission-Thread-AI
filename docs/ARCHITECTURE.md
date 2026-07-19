# Architecture

This document describes the **target** architecture established during
Phase 0 planning. Sections are marked with what phase actually builds them;
see [`docs/TASKS.md`](TASKS.md) for what exists in the repository right now.
As of this writing, Phase 1 (workspaces, schema, seed data, auth, base
shell), Phase 2 (deterministic program-analysis services), and Phase 3
(core workflow UI: dashboard, program overview, event entry, audit shell)
are complete; everything under "AI" and most of "Observability" below is
still planned, not implemented.

## Workspaces

- `apps/web` — Next.js App Router UI + route handlers/server actions. _(Phase 1: scaffold, auth, base shell. Phase 3: dashboard, program overview, event entry, audit shell — done. Phases 4–5: analysis workspace, approval UI.)_
- `packages/core` — Zod schemas, deterministic services, Prisma schema/client. _(Phase 1: schema, auth, seed, db-safety. Phase 2: deterministic services — done. Phase 3: event-entry contract + `recordProgramEvent()` mutation — done. Phase 4: AI evidence builder + `LLMProvider`, mock fixtures, prompts.)_
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

`buildAnalysisEvidence()` itself is still not called from `apps/web` — Phase 3 built the event-intake path (`recordProgramEvent()`, below) that a Phase 4 analysis trigger will eventually sit behind, but Phase 4 is what actually calls `buildAnalysisEvidence()` and feeds its structured output (and separately, its isolated `untrustedText`) to an `LLMProvider`.

## Core workflow UI — implemented (Phase 3)

`apps/web/src/app/(app)/` — real, database-driven pages behind the existing Auth.js session check:

- `/` — executive dashboard: readiness score + factor breakdown, requirement/verification-gap/milestone/risk/defect counts, budget planned/actual/variance, latest supplier-delay schedule exposure, recent events. Calls the Phase 2 services directly (`calculateReadinessScore`, `calculateBudgetVariance`, `calculateScheduleExposure`, `getVerificationGaps`); a failed service call renders an explicit "unavailable" state, never an invented `0`.
- `/programs/edgelink-x` — program overview: components, requirements with traceability and verification badges, milestones, dependency edges, risk register, test outcomes, open defects, budget, suppliers, recent events (untrusted supplier notes clearly labeled, rendered as plain text).
- `/programs/edgelink-x/events/new` — event entry, Program-Manager-only. A server action (`actions.ts`) validates via `eventEntrySchema` and calls `packages/core`'s `recordProgramEvent(input, actorUserId)`, never trusting a client-supplied actor, program, or `delayDays`.
- `/audit` — read-only audit shell: real `AuditEvent` rows, Zod-enum-validated filters (`action`/`actorType`/`targetType`/`traceId`), deterministic `createdAt` desc/`id` desc ordering, a hard 50-row cap.

### Event-entry contract and mutation — implemented (Phase 3)

`packages/core/src/events/` — `eventEntrySchema` (a strict Zod discriminated union keyed by `eventType`, `SUPPLIER_DELAY` | `GENERAL_UPDATE`) plus `recordProgramEvent(input, actorUserId)`, the only mutation Phase 3 performs. It validates input, re-fetches the actor's role from the database on every call (never a session/JWT claim), verifies component/supplier membership in `PROGRAM-EDGELINK-X`, computes `delayDays` server-side (reusing Phase 2's `utcDayDifference()`), and writes the `ProgramEvent` plus one matching `EVENT_RECORDED` `AuditEvent` in a single Prisma transaction — the only audit mutation this phase performs, with a redacted `afterValue` payload (structured facts and `hasReason`/`hasRawNotes` booleans, never full free text). Extends the Phase 2 `ServiceResult<T>`/`DomainError` strategy with a `FORBIDDEN` code rather than inventing a second error shape. See `docs/DECISIONS.md` for the full authorization and transaction design.

## Request / data flow — the AI/approval/apply portion is planned (Phase 4–5), not yet implemented

```
Program Manager submits supplier delay
  -> apps/web: event-entry server action (Zod-validated, server-side auth re-check)  [Phase 3 — done]
  -> packages/core: recordProgramEvent(input, actorUserId)                          [Phase 3 — done]
       - creates ProgramEvent + EVENT_RECORDED AuditEvent in one transaction
  -> packages/core: buildAnalysisEvidence(eventId)                                   [Phase 2 — done, not yet called from apps/web]
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

The AI call and the approval/apply path are not wired up yet — event
intake now works end-to-end and is auditable, but nothing yet analyzes a
recorded event, proposes mitigation options, or applies a change. No
`ImpactAnalysis`, `MitigationOption`, `ProposedChange`, or `Decision` row
exists anywhere in the database as of Phase 3.

## Domain model — implemented (Phase 1)

See `docs/DECISIONS.md` for the approved 20-model Prisma set, the three
merges applied to the `SPEC.md` §6 baseline (`TestResult`→`TestCase`,
`SupplierUpdate`→`ProgramEvent`, `Approval`→`Decision`), and the
`RecordType` allowlist design. Schema lives at
`packages/core/prisma/schema.prisma` and is migrated/seeded.

## Auth — implemented (Phase 1); mutation authorization — implemented (Phase 3)

Auth.js Credentials provider; `crypto.scrypt` password hashes (validated
strictly on verify — see `docs/DECISIONS.md`); JWT sessions; server-side
session check via `auth()` in server layouts and pages. Roles: Program
Manager (event entry — done; analysis/approval workflow — not yet built),
Engineering Lead (read-only across Phase 3 pages), Executive Viewer
(read-only). UI role-gating (hiding the "Record event" link/redirecting a
non-manager away from the event-entry page) is a UX convenience only, never
the actual authorization boundary — `recordProgramEvent()` in
`packages/core` independently re-verifies the actor's current database
role on every call, never trusting a session/JWT claim. See
`docs/DECISIONS.md`, "Mutation authorization."

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
