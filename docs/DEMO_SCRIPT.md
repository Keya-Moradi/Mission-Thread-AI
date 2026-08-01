# Demo script

A ~10-minute, click-through walkthrough of the protected workflow spine —
`event → deterministic analysis → bounded AI interpretation → three
mitigation options → approval → apply preview → audit` — end to end, on the
seeded EdgeLink-X demo program. Written for a live demo (interview,
portfolio review) or for anyone resuming the project who wants to see the
whole system work before reading code.

This walkthrough **records a new event and applies a real change** to the
`missionthread_dev` database, so it's repeatable but not side-effect-free.
Reset to the pristine seed afterward with `npm run db:seed:dev:destructive`
if you want the next run to start clean (fresh authorization required —
see `docs/DECISIONS.md`, "Destructive-operation authorization policy"). The
exact same flow, scripted and non-interactive, already runs on every
`npm run test:e2e` — see `apps/web/e2e/decision-workflow.spec.ts` — so
nothing below is unverified; this script just walks a human through it.

## Prerequisites

- Local environment set up per README.md's Installation/Environment
  configuration/Database sections, with `missionthread_dev` seeded
  (`npm run db:seed:dev:destructive`).
- `npm run dev` (or `npm run build && npm run start --workspace @missionthread/web`)
  running, `AI_MODE=mock` (the default in `.env.example` — needs no API
  key, and every mitigation option shown below comes from the same
  deterministic mock pipeline the automated evals and tests exercise, not a
  live model call).
- Sign in as the Program Manager: `pm@missionthread.example` /
  `MissionThread-Demo-2026!` (README.md "Demo accounts").

## 1. Orient on the dashboard (`/`)

Point out: the readiness score (56/100) and its five equal-weighted
factors, requirement/verification-gap/milestone/risk/defect counts, budget
planned/actual/variance, and the latest supplier-delay schedule exposure —
all real Postgres reads through deterministic services
(`packages/core/src/analysis`), never an LLM guess. Say the sentence:
_"Every number on this page is computed by ordinary TypeScript, not asked
of a model."_

## 2. Tour the program overview (`/programs/edgelink-x`)

Scroll through components, requirements (with verification-gap badges),
milestones, the dependency graph's underlying edges, the risk register,
test outcomes, open defects, budget items, and suppliers. Point out the
existing `SUPPLIER_DELAY` event for `EC-440 Compute Module` and its
**"Submitted note (untrusted, unverified content)"** box — read the note
aloud if it contains the seeded prompt-injection sentence, and note that
it's rendered as plain text, in a clearly labeled box, never as
instructions to anything downstream.

## 3. Record a new event (`/programs/edgelink-x/events/new`)

Click **Record event**. Choose **Supplier delay**, pick a component (e.g.
the battery subsystem), a supplier, an original/revised date pair a few
weeks apart, and a short reason. Submit. You land back on the overview with
a success banner and the new event at the top of **Recent events**, with a
`EVENT_RECORDED` audit row already created (server-side, in the same
transaction as the event itself — see `recordProgramEvent()`).

## 4. Trigger an analysis

On the new event's row, click **Analyze** (Program-Manager-only control).
This calls `runImpactAnalysis()`: re-verifies your role from the database,
builds a bounded evidence package (`buildAnalysisEvidence()` →
`buildModelInputProjection()`), calls the mock provider, and validates the
structured output (schema, then source-ID/semantic checks) before
persisting anything. You're redirected to the new analysis workspace.

## 5. Read the analysis workspace (`/programs/edgelink-x/analyses/[id]`)

Point out, in order:

- **Run status and attempt history** — trace ID, provider/model, duration.
- **Deterministic facts** — schedule exposure, budget exposure, a
  persisted readiness snapshot from the moment this attempt ran (not
  recalculated later).
- **Evidence supplied to the analysis** — every record the model input
  actually contained, each tagged **Cited** or **Supplied only**. Say:
  _"The model can't cite something it wasn't given, and I can see exactly
  what it chose to use versus ignore."_
- **Exactly three mitigation options**, one marked recommended, each with
  its own source citations, schedule/budget figures (or an honest `null`),
  and confidence.

## 6. Open the readiness briefing (`/programs/edgelink-x/briefings/[id]`)

Follow the **Readiness briefing** link. This is the printable,
decision-maker-facing view — same trace ID, confidence, assumptions,
unknowns, cited (not all-supplied) risks and sources, and the same three
options — explicitly stated as pending human review. Mention it's built
for `Cmd/Ctrl+P` — the print stylesheet hides nav and interactive controls.

## 7. Approve a mitigation option

Back on the analysis workspace, open the recommended option's **Record
decision** link. Choose **Approve**, add one **Milestone date** proposed
change (pick an impacted milestone, propose a new date), and submit. Note
the structured editor — never a free-form JSON box — and that once decided,
this page will only ever show the decision on record, never a second form.

## 8. Review the apply preview

Follow through to `/programs/edgelink-x/analyses/[id]/options/[optionId]/apply`.
Point out: the decision rationale and trace ID, the proposed change's
target/captured-old/proposed-new values, the explicit **"nothing has been
applied yet"** statement, and (if applicable) a stale-data warning. This
page is read-only for every role; only the apply control below requires the
Program Manager.

## 9. Apply the change

Type the exact confirmation string into the field and click **Apply**.
`applyApprovedChanges()` runs the whole batch in one transaction — the real
`Milestone.currentDate` changes for real, atomically, or not at all.

## 10. Verify the audit trail (`/audit`)

Filter by the trace ID shown on the analysis workspace (or just scroll —
newest first). You should see, in order: `EVENT_RECORDED` →
`ANALYSIS_STARTED` → `ANALYSIS_SUCCEEDED` → `DECISION_RECORDED` →
`CHANGES_APPLIED` — one unbroken, append-only chain for the exact event you
just walked through. Say: _"Nothing in this table can be edited or deleted
through the application — there's no update or delete path at all."_

## 11. See it as a graph (`/programs/edgelink-x/thread`)

Search for the component or event you used. Point out the new
`ANALYSIS_RUN` → `MITIGATION_OPTION` → `DECISION` → `PROPOSED_CHANGE` chain
now connected into the rest of the program graph, the dashed citation
edges back to the evidence records the analysis actually used, and that the
canvas is strictly read-only (no drag-to-reconnect, no delete) — plus the
accessible text fallback below it for the same data.

## Optional: show the guardrails, not just the happy path

- **Rate limiting** — trigger **Analyze** on a fourth event within 60
  seconds of three prior ones; the fourth is rejected before any provider
  call or database write (`packages/core/src/security/analysis-rate-limiter.ts`).
- **Prompt-injection isolation** — `npm run eval:mock`'s
  `prompt-injection-in-supplier-notes` scenario proves a canary instruction
  embedded in untrusted notes never reaches the validated output.
- **MCP server** — `npm run mcp:stdio` starts the local, read-only MCP
  server (`packages/mcp-server`) for a client like Claude Desktop; six
  bounded read tools, zero mutation tools, zero write paths — see
  `README.md`'s MCP section.

## Resetting afterward

```bash
npm run db:seed:dev:destructive   # fresh authorization required, per docs/DECISIONS.md
```

Restores the pristine seed (the original `EVT-SUPPLIER-001` fixture, no
extra events/analyses/decisions) so the next demo run starts identical to
this one.
