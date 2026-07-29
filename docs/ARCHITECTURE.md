# Architecture

This document describes the **target** architecture established during
Phase 0 planning. Sections are marked with what phase actually builds them;
see [`docs/TASKS.md`](TASKS.md) for what exists in the repository right now.
As of this writing, Phase 1 (workspaces, schema, seed data, auth, base
shell), Phase 2 (deterministic program-analysis services), Phase 3 (core
workflow UI: dashboard, program overview, event entry, audit shell), Phase 4
(AI impact analysis: provider abstraction, mock/live providers,
structured-output validation, orchestration, analysis workspace, readiness
briefing), Phase 5 (approval/apply workflow: decision state machine, apply
preview, transactional apply, append-only audit), Phase 6 (security and
evaluations: threat model, prompt-injection defenses, in-memory analysis
rate limiter, mock evaluation suite, guarded live-eval command, dependency
review), and Phase 7 (database-driven digital-thread graph and a local
read-only MCP server) are complete.

## Workspaces

- `apps/web` — Next.js App Router UI + route handlers/server actions. _(Phase 1: scaffold, auth, base shell. Phase 3: dashboard, program overview, event entry, audit shell — done. Phase 4: Analyze trigger, analysis workspace, readiness briefing — done. Phase 5: decision page, apply-preview page, program-overview Actions section — done.)_
- `packages/core` — Zod schemas, deterministic services, AI provider abstraction, Prisma schema/client. _(Phase 1: schema, auth, seed, db-safety. Phase 2: deterministic services — done. Phase 3: event-entry contract + `recordProgramEvent()` mutation — done. Phase 4: `packages/core/src/ai` — `LLMProvider`, mock/live providers, model-input projection, output schema, semantic validation, orchestration — done. Phase 5: `packages/core/src/approvals` — decision/proposed-change schemas, server-generated snapshots, stale-data detection, `recordMitigationDecision()`, `applyApprovedChanges()` — done.)_
- `packages/mcp-server` — local, read-only MCP server over stdio, reusing `packages/core`. _(Phase 7: six read-only tools — done.)_

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

**Complete per-string output bounds (Phase 6 correction).** Every output
string that previously had no maximum length now does: a shared
`outputRecordIdSchema` (`z.string().min(1).max(OUTPUT_LIMITS.maxRecordIdLength)`,
128 characters) bounds `affectedRequirementIds[*]`, `affectedMilestoneIds[*]`,
`verificationGaps[*].requirementId`, top-level `sourceRecordIds[*]`, and
`mitigationOptions[*].sourceRecordIds[*]`; `verificationGaps[*].category`,
`assumptions[*]`, and `unknowns[*]` each got their own explicit length
ceiling (`maxVerificationCategoryLength`/`maxAssumptionLength`/
`maxUnknownLength`, all in `OUTPUT_LIMITS`). Array-count limits are
unchanged — this only closes the "one string inside an already-bounded
array could still be arbitrarily long" gap. Oversized output fails
structural validation outright; nothing is ever silently truncated. On top
of that, `validateProviderOutput()`
(`packages/core/src/ai/validate-provider-output.ts`) runs a pre-validation
total-size guard (`MAX_PROVIDER_OUTPUT_BYTES = 65,536`) before Zod ever
touches the raw response — a circular or unserializable value, or a
response whose combined serialized size exceeds the ceiling, is rejected
immediately with a fixed safe message, never partially walked and never
echoed back. See `docs/DECISIONS.md`, "Phase 6 correction: provider-spend
and output-bounds", and `docs/THREAT_MODEL.md`.

**Provider-facing JSON Schema.** `openai-schema.ts`'s
`buildOpenAiImpactAnalysisJsonSchema()` generates a JSON Schema from
`impactAnalysisOutputSchema` via `z.toJSONSchema()` — still the single
authoritative source, never a second hand-maintained schema — and
conservatively strips `minLength`/`maxLength` from the provider-facing
copy for every model. OpenAI's Structured Outputs documentation describes
these (and related type-specific keywords) as additionally unsupported
for fine-tuned models specifically, within its broader "some type-specific
keywords are not yet supported" guidance — this project doesn't assume
that carve-out is the whole story for every base/fine-tuned combination it
might ever use, and stripping them everywhere costs nothing: the
authoritative runtime Zod `.min()`/`.max()` checks are completely
unaffected and remain the real enforcement regardless, backed by
`IMPACT_ANALYSIS_MAX_OUTPUT_TOKENS` as the provider-level size ceiling. See
`docs/DECISIONS.md`, "Phase 6 correction: provider-terminal-state and
validation-error safety," for the corrected wording (the original Phase 6
correction pass had stated this as an unqualified universal fact, which
overstated what could actually be verified). The generator then
recursively verifies the result contains
none of `prefixItems`, `unevaluatedItems`, `contains`, `minContains`,
`maxContains`, `propertyNames`, `patternProperties` (keywords
draft-2020-12 permits but OpenAI's strict mode doesn't document support
for), and that every object schema declares `additionalProperties: false`
with every property listed in `required`. Throws rather than silently
patching if a disallowed-keyword violation is ever found. Whatever this
generates is only steering for the API — every parsed response is still
re-validated against the authoritative Zod schema afterward, regardless of
what the provider claims to have enforced.

**Providers.** `MockLLMProvider` (`AI_MODE=mock`, default for dev/CI/tests)
wraps the pure `generateMockImpactAnalysis()`, which never invents a value
not already present in the deterministic input. `OpenAiImpactAnalysisProvider`
(`AI_MODE=live`) uses the official `openai` package's Responses API with
the strict JSON-schema structured output described above, `store: false`,
no streaming/tools/web-search/conversations, a server-controlled
`max_output_tokens: IMPACT_ANALYSIS_MAX_OUTPUT_TOKENS` (8192, covering both
visible output and reasoning tokens) on every request, and its own SDK
client constructed via `buildOpenAiClientOptions()` — `maxRetries: 0`,
`timeout: OPENAI_REQUEST_TIMEOUT_MS` (60 seconds), `logLevel: "off"` —
explicitly overriding the SDK's own defaults (2 automatic retries, a
10-minute timeout, and a log level that resolves from the ambient
`OPENAI_LOG` environment variable) so one provider invocation always
equals exactly one HTTP request, the orchestrator (below) remains the sole
retry authority, and no request/response body (which would include the
prompt's embedded `untrustedData` and the model's raw output) can reach
stdout/stderr through the SDK's own logging regardless of what `OPENAI_LOG`
is set to in the ambient environment — verified directly against the SDK's
own source that the explicit client option is checked before the
environment variable, and with a test that sets `OPENAI_LOG=debug`
immediately before constructing a client and confirms the resolved log
level is still `"off"`.

**Terminal-state gate (Phase 6 correction).** `assertOpenAiResponseCompleted(response)`
is the one point between a raw SDK response and `JSON.parse(response.output_text)`
— `output_text` is read nowhere else in the file. Checks, in order: an
explicit model refusal (any output item's content containing a
`type: "refusal"` entry, checked before `status` at all) throws
non-retryable `PROVIDER_REFUSAL`; `status === "completed"` (with no
refusal) is the only path that proceeds to parsing; `incomplete` with
reason `max_output_tokens` throws retryable `INCOMPLETE_OUTPUT`;
`incomplete` with reason `content_filter` throws non-retryable
`PROVIDER_REFUSAL`; `incomplete` with an absent/unrecognized reason throws
retryable `TRANSIENT_PROVIDER_FAILURE` (a documented judgment call — an
unrecognized reason is treated as more likely a provider-side quirk than a
permanent block, and the cost of being wrong is bounded by the
orchestrator's existing 2-attempt cap); any other status (`failed`,
`cancelled`, `in_progress`, `queued`, or `undefined`) also throws
`TRANSIENT_PROVIDER_FAILURE`. No branch ever includes `response.error`,
`response.output_text`, `response.incomplete_details`, or refusal text in
a thrown message. See `docs/DECISIONS.md`, "Phase 6 correction:
provider-terminal-state and validation-error safety."

No automated test, smoke check, or CI step ever exercises this provider
path against the real API — every test here uses a fake,
dependency-injected `responses.create`, including the SDK-configuration
tests (which construct a real `OpenAI` client with a fake API key — safe,
since construction alone never opens a network connection — and read its
resolved `maxRetries`/`timeout`/`logLevel` fields directly).

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
persistence. This 2-attempt cap is the **only** retry authority in the
system (Phase 6 correction) — every `LLMProvider` implementation, live and
mock alike, is required to make at most one underlying call per
`generateImpactAnalysis()` invocation, so "at most 2 attempts" and "at most
2 real HTTP requests" are the same guarantee, not two guarantees that
happen to usually agree.

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

**Playwright database isolation.** The Playwright worker process and the
`next start` web server it drives are separate processes with separate
environment-inheritance rules — an ambient shell `DATABASE_URL` (e.g.
already pointed at `missionthread_dev` for normal local development) can
survive into one without affecting the other unless something explicitly
overrides it in both. `apps/web/e2e/playwright-test-environment.ts`'s
`resolvePlaywrightTestEnvironment()` is the one place that decides this
suite's database target, reusing `packages/core/src/db-safety.ts`'s exact
approved-target tuples (via a `@missionthread/core/db-safety` package
subpath that never pulls in `db.ts`'s eagerly-constructed Prisma client);
`playwright.config.ts` loads `.env.test` with explicit `override: true`
and applies the one resolved environment to both the worker process and
`webServer.env`. `e2e/decision-workflow.spec.ts` never statically imports
`@missionthread/core` — `assertPlaywrightTestDatabaseTarget()` re-verifies
the target immediately before a guarded, lazy import ever constructs a
Prisma client, and a live `SELECT current_database()` confirms the actual
connection. See `docs/DECISIONS.md`, "Playwright database-isolation
repair".

## Observability — implemented (Phase 4)

`packages/core/src/ai/logging.ts`'s `logAnalysisEvent()` emits one line of
structured JSON per lifecycle event (`analysis.started`, `.succeeded`,
`.failed`, `.retrying`) with trace ID, analysis run ID, analysis ID,
attempt, event ID, requesting user ID, AI mode, provider, model, duration,
status, and safe error category — never an API key, token, prompt, raw
provider output, full untrusted text, database URL, or credential. Takes an
injectable sink so it's directly unit-testable. Trace IDs are surfaced in
the analysis workspace (every attempt) and the readiness briefing.

## Security — implemented (Phase 6)

Full detail, including per-threat likelihood/impact/controls/residual risk,
is in `docs/THREAT_MODEL.md`. Summary of what's newly implemented:

**Trust boundaries.** `docs/THREAT_MODEL.md` documents and diagrams
(Mermaid) the full chain: browser → server actions/pages → authorization +
validation → bounded model-input projection → LLM provider → output
validation → human approval → transactional apply → audit. Every boundary
already established in Phases 1-5 (client/server, session/database-role,
trusted-facts/untrusted-text, application/database,
application/provider, dev/test/CI database) is restated there as the
authoritative reference, not re-engineered.

**Centralized provider-output validation.** `validateProviderOutput(rawOutput:
unknown, modelInput: ModelInputProjection)`
(`packages/core/src/ai/validate-provider-output.ts`) is now the single
authoritative implementation of structural (Zod) + semantic/source
validation — never throws, never touches the database. `orchestrator.ts`'s
`runProviderAndValidate()` calls it directly instead of inlining the two
stages; `evals/scenarios.ts` and dedicated tests call the identical
function, so there is exactly one place "what makes a provider response
safe" is defined. As of the Phase 6 correction pass, this same function
also runs the pre-validation total-size guard and sanitizes every returned
error (see "Provider-spend and output-bounds" below) — so orchestration
and evals inherit both automatically, with no separate integration step.

**Provider-spend and output-bounds (Phase 6 correction).** Four
previously-open gaps closed together, since each compounds the others: (1)
**the OpenAI SDK's own automatic retries and 10-minute default timeout
were left enabled**, silently doubling the orchestrator's real worst-case
HTTP-request count and letting a single attempt hang far past what the
orchestrator's own 2-attempt cap implied — fixed via
`buildOpenAiClientOptions()` (`OPENAI_SDK_MAX_RETRIES = 0`,
`OPENAI_REQUEST_TIMEOUT_MS = 60_000`), making the orchestrator the sole
retry authority; (2) **the live request had no `max_output_tokens`
ceiling** — fixed with a server-controlled
`IMPACT_ANALYSIS_MAX_OUTPUT_TOKENS = 8192` (covering both visible output
and reasoning tokens) sent on every request, with a truncated response
classified as a new retryable `INCOMPLETE_OUTPUT` category rather than
ever being treated as successful; (3) **several output string fields had
no maximum length** — closed with a shared `outputRecordIdSchema` and new
named limits in `OUTPUT_LIMITS` (see the AI section above); (4) **semantic
validation echoed untrusted, provider-controlled values (fabricated IDs,
mitigation-option titles) directly into persisted and retried validation
errors** — every message in `output-validation.ts` now describes a field
path/array index only (e.g. `"mitigationOptions[1].sourceRecordIds[0] is
not in the supplied evidence allowlist."`), and a new shared
`sanitizeProviderValidationErrors()` (`MAX_VALIDATION_ERROR_COUNT = 20`,
`MAX_VALIDATION_ERROR_LENGTH = 240`, `MAX_VALIDATION_FEEDBACK_BYTES =
4096`) bounds the count/length/total-size of every returned error list
before it's persisted (`ImpactAnalysis.validationErrors`), fed back as
retry guidance, or surfaced in an eval report. A new pre-validation
`MAX_PROVIDER_OUTPUT_BYTES = 65,536` guard in `validateProviderOutput()`
rejects an oversized or circular/unserializable raw response before Zod
ever touches it — never throwing, never including the raw output in its
error. See `docs/DECISIONS.md`, "Phase 6 correction: provider-spend and
output-bounds", and `docs/THREAT_MODEL.md` for the updated
denial-of-wallet/denial-of-service residual-risk assessment.

**Provider-terminal-state and validation-error safety (second Phase 6
correction pass).** Three further confirmed defects, closed together: (1)
**a response's completion state was checked too narrowly** — only the
specific `incomplete`/`max_output_tokens` case was rejected, so a
`content_filter`-truncated response, a `failed`/`cancelled`/non-terminal
response, or an explicit model refusal could fall through to
`JSON.parse()` as though it were a normal success if `output_text`
happened to already contain syntactically valid JSON — fixed with
`assertOpenAiResponseCompleted()` (see "Terminal-state gate" above), the
one gate between a raw response and JSON parsing, and a new non-retryable
`PROVIDER_REFUSAL` error category (added to `AI_ERROR_CATEGORIES`,
deliberately excluded from `RETRYABLE_CATEGORIES`); (2) **structural (Zod)
validation errors still forwarded `issue.message` verbatim** — Zod's
default `unrecognized_keys` message embeds the offending property's own
_name_, so a provider could inject arbitrary text into persisted
`ImpactAnalysis.validationErrors` and retried `validationFeedback` using
nothing but a well-chosen extra property name, no value needed — fixed by
replacing `summarizeOutputSchemaErrors()`'s implementation with a
`summarizeStructuralIssue()` formatter that builds every message from
`issue.code`/`issue.path`/schema-authored limits only, never
`issue.message`/`issue.input`/`issue.keys`/a received enum value; (3)
**`sanitizeProviderValidationErrors()` measured only the sum of each raw
string's own bytes**, not the actual serialized array
(`JSON.stringify(result)`) that gets persisted and retried — `JSON.stringify`
adds structural overhead and can expand a string's byte count further via
escape sequences, so a list that looked safely under
`MAX_VALIDATION_FEEDBACK_BYTES` by the old measurement could still exceed
it once actually serialized — fixed by checking
`Buffer.byteLength(JSON.stringify([...result, candidateError]), "utf8")`
before accepting each candidate error, rather than summing raw bytes.
Also disabled the OpenAI SDK's own request/response logging outright
(`logLevel: "off"` in `buildOpenAiClientOptions()`, overriding
`OPENAI_LOG` — see "Providers" above), since `debug`/`info` SDK log levels
print full prompt and response bodies. See `docs/DECISIONS.md`, "Phase 6
correction: provider-terminal-state and validation-error safety."

**Prompt-injection defenses.** Unchanged in design from Phase 4 (data
isolation + fixed system instructions + bounded projection + strict
structural validation + semantic/source validation + human approval + no
provider write capability), now with direct tests
(`packages/core/src/ai/prompt-injection-boundary.test.ts`) proving: the
seeded event's real injection phrase appears only in `untrustedData`, never
elsewhere in the model-input projection; the fixed system prompt has zero
event-specific data for any event; the user prompt embeds `untrustedData`
exactly once, as labeled JSON data, never interpolated prose. A
phrase-based canary check is used only as an evaluation expectation
(`evals/scenarios.ts`'s `prompt-injection-in-supplier-notes` scenario),
never as the actual authorization/safety boundary — see
`docs/THREAT_MODEL.md`.

**In-memory analysis rate limiter.**
`packages/core/src/security/analysis-rate-limiter.ts`'s `AnalysisRateLimiter`
— fixed-window, injectable clock, `ANALYSIS_RATE_LIMIT_MAX_REQUESTS = 3` /
`ANALYSIS_RATE_LIMIT_WINDOW_SECONDS = 60` as named constants, keyed by the
authenticated actor's user ID (never a client IP), lazily pruned. A single
shared `defaultAnalysisRateLimiter` instance is the only one the production
web path ever uses; `runImpactAnalysis(..., { rateLimiter })` accepts an
isolated instance for tests/evals, mirroring the existing
`options.provider`/`options.persistence` shape. Integrated into
`runImpactAnalysis()` immediately after actor/role/event-ID/event-existence
validation and before any evidence construction, attempt persistence, or
provider call — checked once per top-level call, never once per retry
attempt, so an unauthorized/malformed/nonexistent-event request never
consumes quota and a provider retry inside one authorized run never
consumes a second slot. A denied request returns a new `RATE_LIMITED`
`DomainErrorCode` (with a safe `retryAfterSeconds` field) and logs a new
`analysis.rate_limited` structured event containing only the actor ID,
event ID, retry-after seconds, AI mode, and a fresh trace ID — never
internal limiter state or another actor's activity. **Process-local and
in-memory by design** (per `docs/SPEC.md` §12) — a process restart clears
every counter, and a horizontally scaled deployment would need a shared
store instead; not engineered around in this MVP.

**Authorization/mutation regression coverage.**
`packages/core/src/ai/orchestrator-authorization.test.ts` (role reloaded
fresh on every request, including a mid-session demotion; AI output
creates zero `Decision`/`ProposedChange` rows under any outcome;
`packages/core/src/ai/*.ts` has no import from `../approvals` at all — a
structural proof the AI layer has no code path capable of invoking the
approval/apply services), `packages/core/src/security/audit-immutability.test.ts`
(a static source scan proving no application code anywhere calls
`auditEvent.update`/`.delete`/`.upsert`), and `apps/web/src/security-boundary.test.ts`
(no `page.tsx` imports a mutation function directly; no `actions.ts` reads
a client-supplied `actorId`/`userId`/`role` field from `FormData`).

## Evaluations — implemented (Phase 6)

`evals/` — full detail in `evals/README.md`. `npm run eval:mock`:
deterministic, offline, zero network calls, independent of any database,
exits nonzero on any scenario failure. Reuses the production
`generateMockImpactAnalysis()` and `validateProviderOutput()` directly —
never a second, eval-only reimplementation. Eight required scenarios
(`evals/scenarios.ts`): supplier delay affecting multiple milestones,
failed-test verification gap, missing budget data, prompt injection in
supplier notes, insufficient evidence/low confidence, invalid source ID,
wrong mitigation-option count, unauthorized-mutation-shaped extra output
fields — the last three adversarial, each built by mutating one field of a
real, valid mock output rather than a hand-typed object. Every check tags
itself with one of twelve fixed metric categories
(structural/semantic validity, source-ID/record-type correctness,
deterministic date/cost equality, exactly-three-options,
exactly-one-recommendation, unknown handling, confidence behavior,
prompt-injection resistance, no-fabrication, approval/mutation-boundary
enforcement); `evals/runner.ts` aggregates per-scenario and per-metric
results, `evals/reporters.ts` prints a console summary and writes
machine-readable JSON to the gitignored `evals/.output/`.

`npm run eval:live` (`evals/run-live.ts`) fails closed unless `AI_MODE=live`,
`RUN_LIVE_EVALS=true`, and a real `OPENAI_API_KEY` are all set (exact-value
checks, never truthy checks, verified before `createProviderFromEnv()` is
ever called). It calls `createProviderFromEnv()` →
`provider.generateImpactAnalysis()` directly — never `runImpactAnalysis()`
— so it never touches Prisma or any database, and never creates a
`Decision`/`ProposedChange` row. **At most six real HTTP requests per
invocation**: exactly six fictional fixtures (the five non-adversarial
scenarios' fixtures plus the adversarial-notes prompt-injection fixture),
one `for`-loop iteration per fixture with no retry/while construct around
the provider call, and the provider itself (`OpenAiImpactAnalysisProvider`,
same class production analyses use) makes exactly one `responses.create()`
call per `generateImpactAnalysis()` invocation with SDK-level retries
disabled (`OPENAI_SDK_MAX_RETRIES = 0`) — three independently-verified
facts (`packages/core/src/ai/openai-provider.test.ts`,
`packages/core/src/security/live-eval-call-cap.test.ts`) that together
make "6 fixtures" and "at most 6 HTTP requests" the same number, not a
hopeful approximation. Every response is still validated through the same
`validateProviderOutput()`. **Not executed during Phase 6** — Phase 8 owns
the one authorized, sanitized live run and `docs/EVAL_RESULTS.md`, per
`docs/SPEC.md` §13.

Mock evals demonstrate pipeline and policy behavior, not general live-model
quality — see `evals/README.md`'s "What these prove (and don't)".

## Digital-thread graph and MCP server — implemented (Phase 7)

### Graph read model (`packages/core/src/thread/`)

`buildProgramThread(programId)` returns a `ServiceResult<ProgramThreadGraph>` built entirely from Prisma queries plus the Phase 2 deterministic services (`computeRiskScore`, `truncateText`) — the package still never imports React Flow or any UI framework; `apps/web` maps the returned DTOs onto `@xyflow/react` node/edge shapes, never the reverse. Node kinds (`THREAD_NODE_KINDS`, 14 values: `PROGRAM, COMPONENT, REQUIREMENT, MILESTONE, RISK, SUPPLIER, TEST_CASE, DEFECT, BUDGET_ITEM, PROGRAM_EVENT, ANALYSIS_RUN, MITIGATION_OPTION, DECISION, PROPOSED_CHANGE`) and edge kinds (`THREAD_EDGE_KINDS`, 16 values: `CONTAINS, ASSOCIATED_WITH, SATISFIES, SCHEDULED_ON, DEPENDS_ON, VERIFIED_BY, HAS_DEFECT, HAS_RISK, HAS_BUDGET, SUPPLIED, TRIGGERED, ANALYZED_BY, CITED, PROPOSED, DECIDED, TARGETS`) are fixed TypeScript discriminated unions in `types.ts` — no join-table row (`RequirementComponent`, `TestRequirement`, `Dependency`, `SourceReference`) ever becomes a node; each is represented as an edge or edge metadata instead. Node/edge IDs are deterministic (`${kind}:${recordId}` for nodes, `${kind}::${source}::${target}` for edges — the latter doubling as the duplicate-logical-edge dedup key), labels are bounded to `MAX_THREAD_LABEL_LENGTH` via the existing `truncateText()`, and metadata objects use a fixed per-kind allowlist of primitive values only (never a raw Prisma row, never `passwordHash`/session/provider data, never `ProgramEvent.reason`/`rawNotes`, never a complete `Decision.rationale` — only a `truncateText()`-bounded excerpt).

Every `ImpactAnalysis` attempt collapses to exactly one `ANALYSIS_RUN` node keyed by `analysisRunId`: attempts are grouped, the highest `attempt` number is the terminal one, and the node's `attemptCount`/`terminalStatus`/`terminalTraceId` describe the whole group. Every workflow node's `href` (`ANALYSIS_RUN`, `MITIGATION_OPTION`, `PROPOSED_CHANGE`) links using this same logical `analysisRunId` — never a specific attempt's own `ImpactAnalysis.id` — matching exactly what `apps/web`'s `/programs/edgelink-x/analyses/[id]` route family checks; see `docs/DECISIONS.md`, "Phase 7 correction pass," for the defect this corrected. Mitigation options, decisions, and proposed changes are only linked when the terminal attempt's status is `SUCCEEDED` — a failed run gets zero mitigation-option edges, never a phantom option. Evidence citations reuse the same `SourceReference.wasCited` rows the analysis pipeline already wrote: a cited domain record becomes a `CITED` edge from the `ANALYSIS_RUN` node; a cited `DEPENDENCY` record (which has no node of its own) instead sets `cited: true` in the metadata of the matching `DEPENDS_ON` edge; a citation whose target record isn't represented in the graph is safely dropped and counted in the node's `omittedCitationCount` rather than fabricating an edge.

`GraphBuilder` (an internal, unexported class) enforces every invariant while nodes/edges are added — duplicate node IDs are ignored rather than silently overwritten, a self-edge or an edge to a nonexistent node throws — and a final `connectOrphans()` pass runs one BFS from the `PROGRAM` node over the edge set (undirected) and adds an `ASSOCIATED_WITH` edge from `PROGRAM` to any node BFS never reached, so nothing is ever silently orphaned regardless of which optional relationships a given record happens to have. `buildProgramThread()` then re-validates the finished graph with the pure, independently unit-tested `validateGraphInvariants()` (unique node/edge IDs, no duplicate logical edges, every edge endpoint exists, no self-edges, size within `MAX_THREAD_NODES`/`MAX_THREAD_EDGES`) and fails safe with `VALIDATION_ERROR` — never returning a partial/corrupt graph — if anything is violated, including an unexpected exception from `GraphBuilder` itself.

### Deterministic layout and the graph page (`apps/web/.../thread/`)

`thread-layout.ts`'s `computeThreadLayout()` is a pure function of the node list alone — a fixed column-per-kind table (`PROGRAM` → `SUPPLIER`/`PROGRAM_EVENT` → `COMPONENT` → `REQUIREMENT`/`MILESTONE`/`RISK`/`BUDGET_ITEM` → `TEST_CASE`/`DEFECT` → `ANALYSIS_RUN` → `MITIGATION_OPTION` → `DECISION`/`PROPOSED_CHANGE`) plus a deterministic row order within each column (kind order, then `recordId`). It never reads database return order, `Date.now()`, `Math.random()`, or viewport size, and dagre/ELK were deliberately not added — this monorepo's seeded program (dozens, not thousands, of nodes) lays out cleanly without them. This file (and the client components that import it) must never import a runtime value from `@missionthread/core`'s root barrel — only `import type` — because that barrel also re-exports `./db`, which would otherwise pull `@prisma/client`/`pg` into the browser bundle; this was caught during manual dev-server verification (a Turbopack "Module not found: tls/util/types" build error) and fixed by switching to `import type` and deriving the internal kind-order map from the local `COLUMN_BY_KIND` object instead of importing `THREAD_NODE_KINDS`.

`/programs/edgelink-x/thread` (`page.tsx`, a server component, `requireSession()` only — all 3 roles) calls `buildProgramThread()` and renders a safe error state on failure. `thread-graph.tsx` (client) is strictly read-only: `nodesDraggable={false}`, `nodesConnectable={false}`, `elementsSelectable={true}`, `deleteKeyCode={null}`, no `onConnect`/edge-creation/node-deletion/save/layout-persistence/mutation server action anywhere in the component tree. It renders `ReactFlow` + `Controls` + `MiniMap` + `Background` + `fitView`, a legend, live node/edge counts, a label/record-ID search box, domain/workflow node-kind filter toggles, a citation-edge visibility toggle, a "Reset view" control, and a selected-node detail panel (`thread-details.tsx`) linking to the existing analysis/decision/apply/program pages. Every node shows its kind and status as visible text/badges (`thread-node.tsx`) — color is never the only signal. Below the canvas, `page.tsx` renders an accessible, keyboard-navigable `<details>` fallback ("Thread records and relationships") listing every node (grouped by kind, with record ID/label/status/safe link) and every edge (source/relationship label/target) as plain server-rendered HTML, without duplicating any metadata not already safe.

### MCP server (`packages/mcp-server/`)

Uses the current stable v1 `@modelcontextprotocol/sdk` (1.30.0 — no v2 exists yet) over local stdio only; no Streamable HTTP, no legacy SSE. `packages/core/src/mcp/` holds six framework-independent read services (`get-program-summary.ts`, `get-requirement.ts`, `get-schedule-dependencies.ts`, `list-failed-tests.ts`, `get-budget-variance.ts`, `get-risk-register.ts`) that never import the MCP SDK, reuse the Phase 2 deterministic services (`calculateBudgetVariance`, `calculateReadinessScore`, `getDependencyChain`, `getVerificationGaps`, `getRelatedDefects`, `computeRiskScore`) wherever available, use explicit Prisma `select` objects, and share `MCP_LIMITS` (`maxRecords: 100`, `maxDependencyDepth: 10`, `defaultDependencyDepth: 5`, `maxTextLength: 300`) plus the same `ServiceResult<T>` contract as every other Phase 2–7 service.

`packages/mcp-server/src/server.ts` exports `createMissionThreadMcpServer()`, which registers exactly the six tools named in `docs/SPEC.md` §15 (`get_program_summary`, `get_requirement`, `get_schedule_dependencies`, `list_failed_tests`, `get_budget_variance`, `get_risk_register`) with strict Zod input schemas (unknown fields rejected, and every ID field bounded by `mcpEntityIdSchema` — see below), factual one-sentence descriptions with no embedded instructions, and `readOnlyHint: true` / `destructiveHint: false` annotations — and never connects a transport. The package is split into a side-effect-free library and a separate executable, not one file that does both (see "Phase 7 correction pass" in `docs/DECISIONS.md` for why): `src/index.ts` is the package's `main`/`exports` entry — it only re-exports `createMissionThreadMcpServer` and `startMissionThreadStdioServer`, with no other statement, so merely importing it (as a future consumer or test would) has zero side effects; `src/stdio-server.ts` holds `startMissionThreadStdioServer()` (constructs a `StdioServerTransport` and connects only when explicitly called) and a `disconnectDatabase()` shutdown helper, and registers no process handler on import; `src/cli.ts` is the sole executable entry point — the only file in the package that registers `SIGINT`/`SIGTERM`, calls `startMissionThreadStdioServer()`, or sets the process exit code. On a startup failure, `cli.ts` prints exactly one fixed stderr line — never `error.message`, a stack trace, a database URL, or raw Prisma/SDK error text — and prefers `process.exitCode = 1` over an immediate `process.exit()` so the preceding database disconnect is never truncated mid-flight. `src/tool-result.ts` maps every `ServiceResult<T>` to the MCP `{ content: [{ type: "text", text: JSON.stringify(data) }] }` format through one shared `boundedTextResult()` guard applied identically to successful results, expected `ServiceResult` errors, and unexpected thrown exceptions alike — enforcing a 32,000-byte output ceiling (withholding an oversized result, measured by real serialized UTF-8 bytes via `Buffer.byteLength`, rather than truncating it into invalid JSON) and discarding any thrown exception's message/stack, so a raw Prisma error can never reach an MCP client. An error's `entityId` is only ever echoed once it independently re-passes `mcpEntityIdSchema` — an overlong one is silently omitted, never truncated into a misleading value.

`packages/core/src/mcp/schemas.ts`'s `mcpEntityIdSchema` (`entityIdSchema.max(MCP_LIMITS.maxIdLength, ...)`, `maxIdLength: 128`) bounds every ID an MCP tool accepts — an oversized caller-supplied ID (up to and including 1,000,000 characters) is rejected with a fixed, non-value-echoing message before any database query runs; this is a Phase-7-MCP-specific bound layered on top of the shared `entityIdSchema`, not a change to it, since every other Phase 2–5 internal caller still uses it unbounded against IDs already read back out of the database. `packages/core/src/mcp/types.ts`'s `boundMcpText()` (reusing the Phase 4 evidence pipeline's surrogate-pair-safe `truncateText()`) bounds every database-derived free-text field the six services return (names, titles, categories) — never a record ID, enum value, ISO date, or fixed-decimal money string, none of which is ever truncated.

Because `@missionthread/core`'s own source uses extensionless relative imports (fine for the bundler-mode resolution every other consumer in this monorepo uses, but not natively loadable by plain `node`), `packages/mcp-server`'s `build.mjs` uses esbuild to bundle this package's own source together with `@missionthread/core`'s source into two independent, self-contained outputs — `dist/index.js` (the library entry) and `dist/cli.js` (the executable) — while keeping genuine npm dependencies (`@prisma/client`, `@prisma/adapter-pg`, `pg`, `openai`, `@modelcontextprotocol/sdk`, `zod`) external so Node resolves them normally from `node_modules` — `@prisma/client` in particular cannot be bundled, since it loads a native query-engine binary at runtime. `npm run start` (`node dist/cli.js`) is a real emitted build, not a `tsx`/`ts-node` runtime; `npm run dev` (`tsx watch src/cli.ts`) is for iteration; `npm run typecheck` stays `tsc --noEmit` against a `moduleResolution: "bundler"` tsconfig (matching `packages/core`'s own, not the placeholder's original `NodeNext`, which cannot resolve `packages/core`'s extensionless imports even for type-checking).

**Local trust boundary**: this server is a local developer/operator integration, not a remotely hosted service. Whoever can supply its `DATABASE_URL` is the trust boundary — application-level read-only tool behavior is not a substitute for a database-enforced read-only credential, and this MVP does not provision one. It exposes only the fictional, synthetic EdgeLink-X program data this repository seeds. It has no write capability: no tool creates/updates/deletes anything, `packages/mcp-server` imports no mutation function (`recordProgramEvent`, `recordMitigationDecision`, `applyApprovedChanges`) from `packages/core`, and no source file executes raw/arbitrary SQL, shells out, or touches the filesystem beyond its own build/start scripts. A future remote transport would need real authentication and authorization; none exists today. See `docs/THREAT_MODEL.md` for the full MCP host/client/server/database boundary diagram and tool-poisoning considerations.

**Test isolation**: `packages/mcp-server/src/test/setup-env.ts` reuses the exact same `resolveTestDatabaseConfiguration()`/`findApprovedDatabaseTarget()`/`sanitizeDatabaseUrl()` helpers `packages/core`'s own test suite uses (exposed via two narrow `@missionthread/core` subpath exports, `./db-safety` and `./test-db-config`, chosen specifically so neither pulls in Prisma eagerly) and validates the target before any test file can import Prisma. `npm run test:mcp` never resets the database and is safe to run repeatedly — every mcp-server test only reads.

## Deployment (MVP)

Local Docker Compose only (Postgres service). No cloud infrastructure, no
Kubernetes, no queues, no pgvector. See `README.md` for the current state
of the application Dockerfile.
