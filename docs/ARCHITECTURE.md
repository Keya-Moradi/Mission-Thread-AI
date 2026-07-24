# Architecture

This document describes the **target** architecture established during
Phase 0 planning. Sections are marked with what phase actually builds them;
see [`docs/TASKS.md`](TASKS.md) for what exists in the repository right now.
As of this writing, Phase 1 (workspaces, schema, seed data, auth, base
shell), Phase 2 (deterministic program-analysis services), Phase 3 (core
workflow UI: dashboard, program overview, event entry, audit shell), Phase 4
(AI impact analysis: provider abstraction, mock/live providers,
structured-output validation, orchestration, analysis workspace, readiness
briefing), and Phase 5 (approval/apply workflow: decision state machine,
apply preview, transactional apply, append-only audit) are complete.

## Workspaces

- `apps/web` — Next.js App Router UI + route handlers/server actions. _(Phase 1: scaffold, auth, base shell. Phase 3: dashboard, program overview, event entry, audit shell — done. Phase 4: Analyze trigger, analysis workspace, readiness briefing — done. Phase 5: decision page, apply-preview page, program-overview Actions section — done.)_
- `packages/core` — Zod schemas, deterministic services, AI provider abstraction, Prisma schema/client. _(Phase 1: schema, auth, seed, db-safety. Phase 2: deterministic services — done. Phase 3: event-entry contract + `recordProgramEvent()` mutation — done. Phase 4: `packages/core/src/ai` — `LLMProvider`, mock/live providers, model-input projection, output schema, semantic validation, orchestration — done. Phase 5: `packages/core/src/approvals` — decision/proposed-change schemas, server-generated snapshots, stale-data detection, `recordMitigationDecision()`, `applyApprovedChanges()` — done.)_
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

## Analysis workspace and readiness briefing UI — implemented (Phase 4)

- `/programs/edgelink-x` — Recent Events section gained a Program-Manager-only
  "Analyze" control per event (`analyze-button.tsx`, a small client component
  wrapping a server-action form with `useFormStatus()` disable-while-pending),
  and an `analysisError` banner for a request-level failure (bad session,
  unknown event, non-manager role). `actions.ts`'s `analyzeEventAction()`
  takes the actor ID only from the session and relies entirely on
  `runImpactAnalysis()`'s own authorization re-check — it duplicates nothing.
- `/programs/edgelink-x/analyses/[id]` — analysis workspace, `[id]` is the
  logical `analysisRunId`. All authenticated roles may view: overall run
  status, every attempt's number/status/trace ID/provider/model/duration/
  safe failure detail, event facts, deterministic schedule/budget exposure, a
  persisted "program readiness at analysis time" snapshot, verification
  gaps, assumptions, unknowns, **evidence supplied to analysis** (every
  record the attempt's model input actually contained, each tagged "Cited
  (‹contexts›)" or "Supplied only" from the persisted `wasCited`/
  `citationContexts` columns — not just the cited subset), executive
  summary, mission impact, and — on success — exactly three mitigation
  options with the recommended one marked
  (`data-testid="mitigation-option"` / `"mitigation-recommended-badge"`, used
  by the smoke test to count real DOM elements rather than raw text
  occurrences — see the smoke-test.mjs comment on why: Next's RSC flight
  payload re-embeds every rendered string a second time for hydration).
  A pending/failed run shows a safe non-success state, never a fabricated
  result.
- `/programs/edgelink-x/briefings/[id]` — printable readiness briefing,
  read-only, based only on a successful validated attempt. Displays only the
  persisted `readinessSnapshot` (no current-state readiness calculation);
  its "Source references"/"Relevant risks" sections are filtered to the
  cited subset only, since a briefing is a decision document showing what
  was actually used, not everything that was merely supplied (the full
  supplied set is one click away, in the linked analysis workspace).
  Print-specific CSS (`print:hidden` on `Nav` and the page's own back-link/
  print-button row) excludes navigation and interactive controls from the
  printed output. A pending or failed run renders a safe "readiness
  briefing unavailable" state with a link back to the workspace, never a
  fabricated completed view.

### Event-entry contract and mutation — implemented (Phase 3)

`packages/core/src/events/` — `eventEntrySchema` (a strict Zod discriminated union keyed by `eventType`, `SUPPLIER_DELAY` | `GENERAL_UPDATE`) plus `recordProgramEvent(input, actorUserId)`, the only mutation Phase 3 performs. It validates input, re-fetches the actor's role from the database on every call (never a session/JWT claim), verifies component/supplier membership in `PROGRAM-EDGELINK-X`, computes `delayDays` server-side (reusing Phase 2's `utcDayDifference()`), and writes the `ProgramEvent` plus one matching `EVENT_RECORDED` `AuditEvent` in a single Prisma transaction — the only audit mutation this phase performs, with a redacted `afterValue` payload (structured facts and `hasReason`/`hasRawNotes` booleans, never full free text). Extends the Phase 2 `ServiceResult<T>`/`DomainError` strategy with a `FORBIDDEN` code rather than inventing a second error shape. See `docs/DECISIONS.md` for the full authorization and transaction design.

## Request / data flow — event intake through transactional apply, implemented (Phase 3–5)

```
Program Manager submits supplier delay
  -> apps/web: event-entry server action (Zod-validated, server-side auth re-check)  [Phase 3 — done]
  -> packages/core: recordProgramEvent(input, actorUserId)                          [Phase 3 — done]
       - creates ProgramEvent + EVENT_RECORDED AuditEvent in one transaction

Program Manager clicks "Analyze" on a recorded event
  -> apps/web: analyzeEventAction server action (actor ID from session only)         [Phase 4 — done]
  -> packages/core: runImpactAnalysis(eventId, actorUserId)                          [Phase 4 — done]
       - re-verifies actor role from the database; only PROGRAM_MANAGER may proceed
       - buildAnalysisEvidence(eventId)                                              [Phase 2 — done]
       - buildModelInputProjection(evidence) -> validated, bounded ModelInputProjection
       - per attempt (max 2): create PENDING ImpactAnalysis + ANALYSIS_STARTED AuditEvent
         -> call LLMProvider.generateImpactAnalysis() OUTSIDE any DB transaction
            (MockLLMProvider in dev/CI/tests; OpenAiImpactAnalysisProvider if AI_MODE=live)
         -> structural validation (impactAnalysisOutputSchema, Zod)
         -> semantic validation (source IDs allowlisted; scheduleExposureDays ==
            ScheduleExposureResult.directDelayDays; budgetExposureAmount ==
            BudgetExposureResult.totalDeterministicExposure)
         -> on success: persist SUCCEEDED + exactly 3 MitigationOptions (1 recommended)
            + SourceReferences + ANALYSIS_SUCCEEDED AuditEvent, in one transaction
         -> on a retryable failure: persist FAILED + ANALYSIS_FAILED AuditEvent, retry
            once with concise validation feedback; a configuration failure is never retried
  -> apps/web: analysis workspace (/programs/edgelink-x/analyses/[id]) — every role can view
  -> apps/web: readiness briefing (/programs/edgelink-x/briefings/[id]) — printable, read-only

A Program Manager (or, for revision requests, Engineering Lead) opens a
PENDING mitigation option's decision page
  -> apps/web: decision page (.../options/[optionId]/decision) — role-gated       [Phase 5 — done]
  -> apps/web: submitDecisionAction server action (actor ID from session only)
  -> packages/core: recordMitigationDecision(input, actorUserId)
       - re-verifies actor role from the database; enforces verdict permissions
       - confirms the option is still PENDING and has no existing Decision
       - approval only: validates every proposed change, loads/verifies each
         target belongs to PROGRAM-EDGELINK-X, builds server-generated old/new
         value snapshots (never trusting client-supplied old values)
       - in one transaction: creates Decision, transitions MitigationOption
         status, creates ProposedChange rows (approval only), creates one
         DECISION_RECORDED AuditEvent
  -> apps/web: apply-preview page (.../options/[optionId]/apply) — approval only,
     read-only stale-data check against every target's current value

Program Manager confirms the exact "APPLY" string and applies
  -> apps/web: submitApplyAction server action (actor ID from session only)       [Phase 5 — done]
  -> packages/core: applyApprovedChanges(mitigationOptionId, actorUserId, confirmation)
       - re-verifies actor role (PROGRAM_MANAGER only) before opening a transaction
       - in one transaction: reloads the option and its APPROVED decision, loads
         every PENDING ProposedChange, re-checks every target against its
         captured old value, aborts entirely on any conflict
       - applies each domain mutation (milestone date / risk fields / budget
         fields; NEW_ACTION mutates no domain table), marks every proposed
         change APPLIED with one shared appliedAt, creates one CHANGES_APPLIED
         AuditEvent linked to the Decision
  -> apps/web: program overview's "Actions" section — applied NEW_ACTION records
```

Event intake, AI analysis, and the approval/apply workflow all work
end-to-end and are fully auditable. Every mitigation option's lifecycle —
proposal, decision, preview, and (for approvals) application — leaves a
complete, append-only `AuditEvent` trail.

## Domain model — implemented (Phase 1); extended (Phase 5)

See `docs/DECISIONS.md` for the approved 20-model Prisma set, the three
merges applied to the `SPEC.md` §6 baseline (`TestResult`→`TestCase`,
`SupplierUpdate`→`ProgramEvent`, `Approval`→`Decision`), and the
`RecordType` allowlist design. Schema lives at
`packages/core/prisma/schema.prisma` and is migrated/seeded. Phase 5 added
one migration (`20260722000000_phase5_decision_state_machine`):
`Decision.mitigationOptionId` gained `@unique` (`MitigationOption.decision`
is now `Decision?`, not an array — at most one decision per option, enforced
by the database, not just application logic), `Decision.rationale` became
required, and `ProposedChange.targetRecordId`/`targetRecordType` became
nullable (`NEW_ACTION` has no existing record to target — see
`docs/DECISIONS.md`, "Resolved: `ProposedChangeType.NEW_ACTION` target-field
conflict").

## Auth — implemented (Phase 1); mutation authorization — implemented (Phase 3–5)

Auth.js Credentials provider; `crypto.scrypt` password hashes (validated
strictly on verify — see `docs/DECISIONS.md`); JWT sessions; server-side
session check via `auth()` in server layouts and pages. Roles: Program
Manager (event entry, analysis, decisions, apply — all done), Engineering
Lead (read-only across Phase 3–4 pages; may request revision on a
mitigation option), Executive Viewer (read-only everywhere, including the
approval workflow). UI role-gating (hiding the "Record event" link/
redirecting a non-manager away from the event-entry page; hiding
approve/reject/apply controls from non-Program-Managers) is a UX
convenience only, never the actual authorization boundary —
`recordProgramEvent()`, `recordMitigationDecision()`, and
`applyApprovedChanges()` in `packages/core` each independently re-verify
the actor's current database role on every call, never trusting a
session/JWT claim. See `docs/DECISIONS.md`, "Mutation authorization" and
"Phase 5 decision permissions."

## Persistence — implemented (Phase 1)

PostgreSQL via Prisma, single schema in `packages/core/prisma`. Dev and
test databases are separate logical databases in the same local Docker
Compose Postgres instance (host port `55432`, chosen to avoid colliding
with a local Postgres already on 5432), selected via `DATABASE_URL` vs
`TEST_DATABASE_URL`. Every destructive operation (test reset, dev reseed)
passes through the shared guard in `packages/core/src/db-safety.ts`.

## AI — implemented (Phase 4)

`packages/core/src/ai/`:

```text
provider.ts              LLMProvider / LLMProviderRequest / LLMProviderResponse
errors.ts                AiConfigurationError, AiProviderError, safe error-category allowlist
provider-factory.ts      resolveAiMode() (strict "mock"|"live"), createProviderFromEnv()
mock-provider.ts         generateMockImpactAnalysis() (pure) + MockLLMProvider
openai-provider.ts       OpenAiImpactAnalysisProvider (Responses API, live mode only)
openai-schema.ts         buildOpenAiImpactAnalysisJsonSchema() + OpenAI-subset verification
model-input.ts           buildModelInputProjection(), ModelInputProjection Zod schema, bounds,
                          readinessSnapshotSchema (also the persisted readiness-snapshot schema)
output-schema.ts         impactAnalysisOutputSchema (the authoritative Zod output schema)
output-validation.ts     validateImpactAnalysisSemantics() (source-ID + deterministic checks)
attempt-persistence.ts   buildAttemptSourceReferenceSnapshot(), buildSucceededImpactAnalysisData()
orchestrator.ts          runImpactAnalysis() — authorization, attempts, retry, persistence
logging.ts                logAnalysisEvent() — structured JSON, injectable sink
prompts/                 impact-analysis-system.ts, impact-analysis-user.ts
```

**Model input.** `buildModelInputProjection(evidence: AnalysisEvidence)` never
serializes the full `AnalysisEvidence` object — only structured event facts,
deterministic results (impacted requirement/milestone IDs, schedule/budget
exposure, verification gaps, related defects, risk scores, readiness score),
the already-bounded evidence allowlist (`{ recordId, recordType, summary }`),
and a separate `untrustedData: { reason, rawNotes }` object. Collections not
already bounded by `EVIDENCE_LIMITS` (impacted requirements/milestones,
verification gaps, related defects, risk scores, readiness factors,
assumptions, unknowns) get their own explicit bounds
(`MODEL_INPUT_LIMITS`, reusing `EVIDENCE_LIMITS.maxItemsPerRecordType`
rather than inventing a second number) — every truncation records a warning
in `unknowns` rather than silently dropping data, and ordering is always the
producing service's own deterministic order. A final
`checkModelInputSize()` byte-length check runs before every provider call.

**Prompts.** The system prompt (`prompts/impact-analysis-system.ts`) states
that all data is fictional, that `untrustedData` is data never instructions,
that IDs/dates/costs must never be invented, that facts and assumptions must
stay separated, and that exactly three mitigation options with exactly one
recommendation are required. The user prompt
(`prompts/impact-analysis-user.ts`) serializes only the validated
`ModelInputProjection` — no interpolated prose wrapping individual untrusted
fields. Neither prompt is ever logged in full.

**Output schema and validation.** `impactAnalysisOutputSchema` is `.strict()`
throughout (no extra keys, no optional fields — `nullable()` instead),
requires exactly three mitigation options
(`z.array(mitigationOptionOutputSchema).length(3)` — not `z.tuple([...])`,
which converts to JSON Schema `prefixItems`, outside OpenAI Structured
Outputs' supported subset; see `docs/DECISIONS.md`, "Phase 4 correction:
mitigationOptions array instead of tuple") with exactly one
`isRecommended: true`, fixed-2-decimal monetary strings, and documented
length/array limits. A second, semantic pass
(`validateImpactAnalysisSemantics()`) checks what Zod alone cannot: every
`sourceRecordIds` entry (top-level and per-option) must exist in the
request's own evidence allowlist; `affectedRequirementIds`/
`affectedMilestoneIds` must exist as `REQUIREMENT`/`MILESTONE` evidence;
`scheduleExposureDays` must exactly equal
`ScheduleExposureResult.directDelayDays`, and `budgetExposureAmount` must
exactly equal `BudgetExposureResult.totalDeterministicExposure` — the
persisted value is always the deterministic one, never the model's own
copy of it, even when they agree (see `docs/DECISIONS.md`).

**Database-safe output constraints.** Every monetary field
(`budgetExposureAmount`, each mitigation option's `costImpact`) uses
`persistedMoneyStringSchema` (`/^\d{1,10}\.\d{2}$/`, exported alongside
`MAX_DECIMAL_12_2_INTEGER_DIGITS = 10`) — bounded to fit
`Decimal(12, 2)`'s actual 10-integer-digit capacity, not just "any number
of digits plus two decimals." Each mitigation option's `scheduleImpact`
(a model-proposed figure with no deterministic counterpart to check it
against, unlike `scheduleExposureDays`) is bounded to
`MIN_MITIGATION_SCHEDULE_IMPACT_DAYS`/`MAX_MITIGATION_SCHEDULE_IMPACT_DAYS`
(±3650 days, ±10 years). Schema validation exists specifically so a
structurally-and-semantically "valid" response can never still fail at
the actual Prisma write — matching the schema to the persistence-column
limits, not just to what looks reasonable, is what closes that gap (see
`docs/DECISIONS.md`, "Persistence-boundary repair: database-safe output
constraints").

**Provider-facing JSON Schema.** `openai-schema.ts`'s
`buildOpenAiImpactAnalysisJsonSchema()` generates a JSON Schema from
`impactAnalysisOutputSchema` via `z.toJSONSchema()` — still the single
authoritative source, never a second hand-maintained schema — and then
recursively verifies it contains none of `prefixItems`, `unevaluatedItems`,
`contains`, `minContains`, `maxContains`, `propertyNames`,
`patternProperties` (keywords draft-2020-12 permits but OpenAI's strict
mode doesn't document support for), and that every object schema declares
`additionalProperties: false` with every property listed in `required`.
Throws rather than silently patching if a violation is ever found. Whatever
this generates is only steering for the API — every parsed response is
still re-validated against the authoritative Zod schema afterward,
regardless of what the provider claims to have enforced.

**Providers.** `MockLLMProvider` (`AI_MODE=mock`, default for dev/CI/tests)
wraps the pure `generateMockImpactAnalysis()`, which never invents a value
not already present in the deterministic input. `OpenAiImpactAnalysisProvider`
(`AI_MODE=live`) uses the official `openai` package's Responses API with
the strict JSON-schema structured output described above, `store: false`,
no streaming/tools/web-search/conversations. No automated test, smoke
check, or CI step ever exercises this path.

**Attempt-evidence persistence.** `attempt-persistence.ts`'s
`buildAttemptSourceReferenceSnapshot(modelInput, output?)` builds the
`SourceReference` rows for one attempt: called once before the provider
call (no `output`) to produce the _complete_ supplied-evidence snapshot —
every allowlisted record, `wasCited: false` — and again after a validated
response (`output` present) to mark which records were actually cited and
in which context (`"analysis"` or `"option:<index>"`, bounded fixed
vocabulary, never model text). `buildSucceededImpactAnalysisData(output,
modelInput)` builds a successful attempt's persisted fields, always
sourcing `scheduleExposureDays`/`budgetExposureAmount`/`readinessSnapshot`
from `modelInput.deterministicResults` — never from the model's own copy —
since the application, never the model, is the source of truth for a
deterministic calculation.

**Orchestration.** `runImpactAnalysis(eventId, actorUserId, options?)`
re-verifies the actor's current database role (only `PROGRAM_MANAGER`,
same pattern as `recordProgramEvent()`), builds evidence, a model-input
projection, and re-validates it at runtime against
`modelInputProjectionSchema` before any attempt is created. Per attempt
(max 2), five explicit stages: pending-attempt persistence, provider
invocation, structural validation, semantic validation, success
persistence.

- **Pending-attempt persistence** — one transaction creates the `PENDING`
  `ImpactAnalysis` row, the **complete** supplied-evidence
  `SourceReference` snapshot, and the `ANALYSIS_STARTED` audit event, all
  before the provider is ever called. If this transaction fails, the
  provider is never invoked, no attempt is counted, and — since Prisma
  rolls the whole transaction back — no partial row of any kind survives.
- **Provider invocation** — the _only_ stage wrapped in the `try/catch`
  that calls `classifyProviderError()` (`runProviderAndValidate()`).
  Structural and semantic validation happen immediately afterward, outside
  that `catch` — they use `safeParse`/a validity-result object and never
  throw, so nothing downstream of the provider call can be
  misclassified as a provider failure.
- **Success persistence** — its own, separate `try/catch`, entirely
  outside the provider stage. A failure here is never retried and never
  re-invokes the provider: `PERSISTENCE_FAILURE` is recorded through a
  fresh call into the persistence interface, `ANALYSIS_FAILED` is created
  only if that succeeds, the already-committed evidence snapshot is
  untouched, and zero `MitigationOption` rows survive (the success
  transaction itself rolled back). See `docs/DECISIONS.md`,
  "Persistence-boundary repair: provider vs. persistence failure
  separation".

One `analysisRunId` per logical run links an attempt and its one retry,
each with its own full evidence snapshot; each attempt keeps its own
`traceId`. Retryable failure categories (transient provider error,
malformed JSON, schema violation, invalid source IDs, deterministic
mismatch) get exactly one retry with concise validation feedback;
`CONFIGURATION_ERROR` and `PERSISTENCE_FAILURE` are never retried —
neither creates a second provider call, since neither is something a
retry against the same provider would fix.

**Directly testable persistence injection.** `AnalysisPersistence`
(`persistPendingAttempt`/`persistSucceededAttempt`/`persistFailedAttempt`)
and `defaultAnalysisPersistence`, the real Prisma-backed implementation,
let tests fail exactly one persistence stage via
`runImpactAnalysis(..., { persistence: {...} })` — the same override-point
shape already established for `options.provider`. `apps/web` never passes
`options` at all, so this is unreachable from the web client without any
separate gating. No global Prisma mock is used anywhere in this test
suite.

**Immutable readiness snapshot.** `ImpactAnalysis.readinessSnapshot`
persists `modelInput.deterministicResults.readinessScore` exactly as
computed when the attempt ran (`readinessSnapshotSchema`, exported from
`model-input.ts` and reused unchanged as the persisted-content schema — not
a second representation), or a real SQL `NULL` (`Prisma.DbNull`) if
readiness genuinely couldn't be computed. Never recalculated on read: the
analysis workspace and the readiness briefing both display only this
persisted value — the briefing performs no current-state readiness
calculation at all. Verified directly: a historical analysis's stored
snapshot is unchanged after a later program mutation that provably changes
`calculateReadinessScore()`'s current result (see `docs/DECISIONS.md`,
"Phase 4 correction: immutable readiness snapshot").

## Approval and apply workflow — implemented (Phase 5)

`packages/core/src/approvals/`:

```text
schemas.ts          recordDecisionInputSchema, proposedChangeInputSchema (4-way
                     discriminated union), rationale/confirmation constants
snapshot.ts          buildProposedChangeSnapshot() — server-generated old/new values
stale.ts              checkProposedChangeStale() — normalized staleness comparison
record-decision.ts   recordMitigationDecision() — decision state machine + transaction
apply-changes.ts      applyApprovedChanges() — transactional, all-or-nothing apply
index.ts              public barrel
```

**State machine.** Every `MitigationOption` starts `PENDING`. Allowed
transitions: `PENDING → APPROVED | REJECTED | REVISION_REQUESTED`; no
transition out of a terminal state; at most one `Decision` per option,
enforced by `Decision.mitigationOptionId @unique` at the database level
(not just an application-layer check) — see `docs/DECISIONS.md`.

**Decision permissions.** Program Manager: approve, reject, request
revision, apply. Engineering Lead: request revision only. Executive Viewer:
read-only. Revalidated from the database on every call, exactly like
`recordProgramEvent()`/`runImpactAnalysis()` — never a session/JWT role
claim.

**Decision input contract.** `recordDecisionInputSchema` is a strict Zod
discriminated union keyed by `verdict`; only `APPROVED` accepts
`proposedChanges` (required, at least one); rationale is required on every
verdict (10–2000 characters). Each proposed change is itself a
discriminated union keyed by `changeType`
(`MILESTONE_DATE`/`RISK_UPDATE`/`BUDGET_UPDATE`/`NEW_ACTION`) — the client
may only submit the _proposed_ new value (or, for risk/budget updates, an
allowlisted writable-field subset); `oldValue`, `targetRecordType`,
`programId`, `status`, and every server-generated field are never part of
this schema's shape at all.

**Server-generated snapshots.** `buildProposedChangeSnapshot()` loads the
target record, verifies program membership, and builds both `oldValue`
(from the current database row) and `newValue` (from the validated client
input) — the client's own claimed old value is never trusted or persisted.
`NEW_ACTION` has no existing target (`targetRecordId`/`targetRecordType`
nullable since the Phase 5 migration); its safe `oldValue` is always `{}`
and its durable payload is the `ProposedChange` row's own `newValue` — no
separate `ActionItem` model, surfaced in the program overview's "Actions"
section.

**Overlap rejection.** A batch of proposed changes may never contain two
entries that write the same field on the same record (e.g. two
`MILESTONE_DATE` entries for the same milestone, or two `RISK_UPDATE`
entries both proposing a new `status`) — without this, both would pass
their own (per-change) stale check and apply in array order, making the
final persisted value depend on list order rather than on what a human
actually approved. `getProposedChangeWriteKeys()`
(`packages/core/src/approvals/overlap.ts`) derives one
`<targetType>:<targetId>:<field>` key per field a change actually supplies
(`NEW_ACTION` always returns none — it creates a new record every time, so
it can never overlap with anything); `validateNoOverlappingProposedChanges()`
rejects the first duplicate, called immediately after Zod parsing and
before any database access at all. Disjoint fields on the same record,
updates to different records, and multiple `NEW_ACTION` entries remain
valid in one batch.

**Apply-time persisted-snapshot revalidation.** Decision-time validation is
the normal boundary for what gets written; the apply step revalidates it
anyway rather than trusting a TypeScript type. `persisted-schemas.ts`
defines strict, `changeType`-keyed schemas for exactly what a stored
`ProposedChange` row must contain (correct `targetRecordType`, matching
non-empty `oldValue`/`newValue` key sets restricted to allowlisted fields,
valid value ranges/formats). `applyApprovedChanges()` parses every
`PENDING` row this way — and re-checks the parsed rows for a stored
cross-row overlap — before any stale check or domain mutation; a
malformed or overlapping stored row is rejected with zero mutations. The
resulting validated shape is what the domain-mutation code actually
operates on, replacing every non-null assertion/blind cast that previously
stood in for a runtime guarantee.

**Decision transaction.** `recordMitigationDecision()` — actor/permission
check, option/program lookup, PENDING/no-existing-decision checks,
proposed-change validation and snapshotting, `Decision` creation, status
transition, `ProposedChange` creation (approval only), one
`DECISION_RECORDED` `AuditEvent` — all in one transaction. The audit
payload is bounded and safe (verdict, IDs, change types, a `hasRationale`
boolean); the full rationale text stays only on the `Decision` row.

**Stale-data conflict detection.** `checkProposedChangeStale()` compares a
proposed change's captured `oldValue` against the target's current value,
using the same normalized representation (UTC date-only strings,
fixed-two-decimal monetary strings, Prisma enum strings) both at
apply-preview render time (read-only) and again inside
`applyApprovedChanges()`'s own transaction. A stale proposed change blocks
the entire apply batch.

**Apply transaction.** `applyApprovedChanges(mitigationOptionId,
actorUserId, confirmation)` requires the exact literal `"APPLY"` — never a
hidden Boolean. Actor/role (`PROGRAM_MANAGER` only) revalidated before any
transaction opens. Inside one transaction: reload the option and its
`APPROVED` decision, load every `PENDING` proposed change (require at
least one), re-check every target for staleness, abort entirely on any
conflict, apply each domain mutation (allowlisted fields only), mark every
proposed change `APPLIED` with one shared `appliedAt`, create one
`CHANGES_APPLIED` `AuditEvent` linked to the decision. No AI or network
request runs inside this transaction.

**Idempotency and concurrency.** A repeated apply finds zero `PENDING`
proposed changes and is rejected — no duplicate mutation, audit event, or
`appliedAt`. Two concurrent decisions on the same option: the `Decision`
unique constraint lets only the first succeed. Two concurrent applies: a
conditional `updateMany(... WHERE status = 'PENDING')` lets only the first
claim the rows; the second's transaction (including any domain mutations
already applied inside it) rolls back entirely. Database constraints and
conditional claims throughout — never a process-local flag or lock.

**Web.** `/programs/edgelink-x/analyses/[id]/options/[optionId]/decision`
(role-gated decision controls, structured proposed-change editor — add/
remove sections per change type, never a free-form JSON textarea) and
`.../apply` (read-only preview for every role; apply control for Program
Manager only; explicit "nothing has been applied yet" statement; per-change
stale/conflict warnings). The analysis workspace shows each option's
decision status, actor, and rationale inline. See `docs/DECISIONS.md` for
the full design and every verified edge case.

## Observability — implemented (Phase 4)

`packages/core/src/ai/logging.ts`'s `logAnalysisEvent()` emits one line of
structured JSON per lifecycle event (`analysis.started`, `.succeeded`,
`.failed`, `.retrying`) with trace ID, analysis run ID, analysis ID,
attempt, event ID, requesting user ID, AI mode, provider, model, duration,
status, and safe error category — never an API key, token, prompt, raw
provider output, full untrusted text, database URL, or credential. Takes an
injectable sink so it's directly unit-testable. Trace IDs are surfaced in
the analysis workspace (every attempt) and the readiness briefing.

## Deployment (MVP)

Local Docker Compose only (Postgres service). No cloud infrastructure, no
Kubernetes, no queues, no pgvector. See `README.md` for the current state
of the application Dockerfile.
