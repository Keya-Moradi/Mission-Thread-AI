"use client";

import { useActionState, useId, useState } from "react";
import { submitDecisionAction, type DecisionFormState } from "./actions";

// Defined here, not in actions.ts: a "use server" file may only export
// async functions — a plain object export like this would break module
// evaluation entirely ("A 'use server' file can only export async
// functions, found object") — see docs/DECISIONS.md and the identical
// pattern in events/new/event-entry-form.tsx.
const initialDecisionFormState: DecisionFormState = { error: null };

type Verdict = "APPROVED" | "REJECTED" | "REVISION_REQUESTED";

interface TargetOption {
  id: string;
  label: string;
}

interface TargetOptions {
  milestones: TargetOption[];
  risks: TargetOption[];
  budgetItems: TargetOption[];
}

type ProposedChangeEntry =
  | { changeType: "MILESTONE_DATE"; targetRecordId: string; currentDate: string }
  | {
      changeType: "RISK_UPDATE";
      targetRecordId: string;
      status: string;
      severity: string;
      probability: string;
      impact: string;
    }
  | {
      changeType: "BUDGET_UPDATE";
      targetRecordId: string;
      plannedAmount: string;
      actualAmount: string;
    }
  | { changeType: "NEW_ACTION"; title: string; description: string; dueDate: string };

function emptyEntry(changeType: ProposedChangeEntry["changeType"]): ProposedChangeEntry {
  switch (changeType) {
    case "MILESTONE_DATE":
      return { changeType, targetRecordId: "", currentDate: "" };
    case "RISK_UPDATE":
      return {
        changeType,
        targetRecordId: "",
        status: "",
        severity: "",
        probability: "",
        impact: "",
      };
    case "BUDGET_UPDATE":
      return { changeType, targetRecordId: "", plannedAmount: "", actualAmount: "" };
    case "NEW_ACTION":
      return { changeType, title: "", description: "", dueDate: "" };
  }
}

/**
 * Serializes the structured entries into the exact shape
 * proposedChangeInputSchema (packages/core/src/approvals/schemas.ts)
 * expects — omitting untouched optional fields rather than sending empty
 * strings, and converting risk numeric fields to real numbers (Zod does not
 * coerce strings). This is the only place JSON is constructed; the user
 * never sees or edits JSON directly.
 */
function serializeEntries(entries: ProposedChangeEntry[]): unknown[] {
  return entries.map((entry) => {
    switch (entry.changeType) {
      case "MILESTONE_DATE":
        return {
          changeType: "MILESTONE_DATE",
          targetRecordId: entry.targetRecordId,
          currentDate: entry.currentDate,
        };
      case "RISK_UPDATE": {
        const result: Record<string, unknown> = {
          changeType: "RISK_UPDATE",
          targetRecordId: entry.targetRecordId,
        };
        if (entry.status) result.status = entry.status;
        if (entry.severity) result.severity = entry.severity;
        if (entry.probability) result.probability = Number(entry.probability);
        if (entry.impact) result.impact = Number(entry.impact);
        return result;
      }
      case "BUDGET_UPDATE": {
        const result: Record<string, unknown> = {
          changeType: "BUDGET_UPDATE",
          targetRecordId: entry.targetRecordId,
        };
        if (entry.plannedAmount) result.plannedAmount = entry.plannedAmount;
        if (entry.actualAmount) result.actualAmount = entry.actualAmount;
        return result;
      }
      case "NEW_ACTION":
        return {
          changeType: "NEW_ACTION",
          targetRecordId: null,
          targetRecordType: null,
          title: entry.title,
          description: entry.description,
          dueDate: entry.dueDate || null,
        };
    }
  });
}

const inputClasses =
  "rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:border-accent";
const labelClasses = "text-xs font-medium text-foreground";

function ChangeEntryFields({
  entry,
  onChange,
  targetOptions,
}: {
  entry: ProposedChangeEntry;
  onChange: (entry: ProposedChangeEntry) => void;
  targetOptions: TargetOptions;
}) {
  const idPrefix = useId();

  if (entry.changeType === "MILESTONE_DATE") {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className={labelClasses}>Target milestone</span>
          <select
            className={inputClasses}
            value={entry.targetRecordId}
            onChange={(e) => onChange({ ...entry, targetRecordId: e.target.value })}
            required
          >
            <option value="" disabled>
              Select a milestone
            </option>
            {targetOptions.milestones.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClasses}>New current date</span>
          <input
            type="date"
            className={inputClasses}
            value={entry.currentDate}
            onChange={(e) => onChange({ ...entry, currentDate: e.target.value })}
            required
          />
        </label>
      </div>
    );
  }

  if (entry.changeType === "RISK_UPDATE") {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 sm:col-span-2">
          <span className={labelClasses}>Target risk</span>
          <select
            className={inputClasses}
            value={entry.targetRecordId}
            onChange={(e) => onChange({ ...entry, targetRecordId: e.target.value })}
            required
          >
            <option value="" disabled>
              Select a risk
            </option>
            {targetOptions.risks.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClasses}>New status (optional)</span>
          <select
            className={inputClasses}
            value={entry.status}
            onChange={(e) => onChange({ ...entry, status: e.target.value })}
          >
            <option value="">Unchanged</option>
            <option value="OPEN">Open</option>
            <option value="MITIGATING">Mitigating</option>
            <option value="CLOSED">Closed</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClasses}>New severity (optional)</span>
          <select
            className={inputClasses}
            value={entry.severity}
            onChange={(e) => onChange({ ...entry, severity: e.target.value })}
          >
            <option value="">Unchanged</option>
            <option value="LOW">Low</option>
            <option value="MEDIUM">Medium</option>
            <option value="HIGH">High</option>
            <option value="CRITICAL">Critical</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClasses}>New probability 1–5 (optional)</span>
          <input
            type="number"
            min={1}
            max={5}
            step={1}
            className={inputClasses}
            value={entry.probability}
            onChange={(e) => onChange({ ...entry, probability: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClasses}>New impact 1–5 (optional)</span>
          <input
            type="number"
            min={1}
            max={5}
            step={1}
            className={inputClasses}
            value={entry.impact}
            onChange={(e) => onChange({ ...entry, impact: e.target.value })}
          />
        </label>
      </div>
    );
  }

  if (entry.changeType === "BUDGET_UPDATE") {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1">
          <span className={labelClasses}>Target budget item</span>
          <select
            className={inputClasses}
            value={entry.targetRecordId}
            onChange={(e) => onChange({ ...entry, targetRecordId: e.target.value })}
            required
          >
            <option value="" disabled>
              Select a budget item
            </option>
            {targetOptions.budgetItems.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClasses}>New planned amount (optional)</span>
          <input
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            pattern="\d{1,10}\.\d{2}"
            className={inputClasses}
            value={entry.plannedAmount}
            onChange={(e) => onChange({ ...entry, plannedAmount: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClasses}>New actual amount (optional)</span>
          <input
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            pattern="\d{1,10}\.\d{2}"
            className={inputClasses}
            value={entry.actualAmount}
            onChange={(e) => onChange({ ...entry, actualAmount: e.target.value })}
          />
        </label>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3">
      <label className="flex flex-col gap-1">
        <span className={labelClasses}>Action title</span>
        <input
          id={`${idPrefix}-title`}
          type="text"
          maxLength={200}
          className={inputClasses}
          value={entry.title}
          onChange={(e) => onChange({ ...entry, title: e.target.value })}
          required
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className={labelClasses}>Action description</span>
        <textarea
          rows={2}
          maxLength={2000}
          className={inputClasses}
          value={entry.description}
          onChange={(e) => onChange({ ...entry, description: e.target.value })}
          required
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className={labelClasses}>Due date (optional)</span>
        <input
          type="date"
          className={inputClasses}
          value={entry.dueDate}
          onChange={(e) => onChange({ ...entry, dueDate: e.target.value })}
        />
      </label>
    </div>
  );
}

export function DecisionForm({
  analysisRunId,
  optionId,
  canApproveOrReject,
  targetOptions,
  rationaleMinLength,
  rationaleMaxLength,
}: {
  analysisRunId: string;
  optionId: string;
  canApproveOrReject: boolean;
  targetOptions: TargetOptions | null;
  // Passed down from the server page component (packages/core's exported
  // constants) rather than imported directly here — this is a "use client"
  // component, and importing from the @missionthread/core barrel would pull
  // in packages/core/src/db.ts's Prisma/pg dependency graph into the
  // browser bundle.
  rationaleMinLength: number;
  rationaleMaxLength: number;
}) {
  const boundAction = submitDecisionAction.bind(null, analysisRunId, optionId);
  const [state, formAction, isPending] = useActionState(boundAction, initialDecisionFormState);
  const [verdict, setVerdict] = useState<Verdict>(
    canApproveOrReject ? "APPROVED" : "REVISION_REQUESTED",
  );
  const [entries, setEntries] = useState<ProposedChangeEntry[]>([emptyEntry("MILESTONE_DATE")]);

  const showEditor = verdict === "APPROVED" && targetOptions !== null;

  function updateEntry(index: number, next: ProposedChangeEntry) {
    setEntries((prev) => prev.map((entry, i) => (i === index ? next : entry)));
  }
  function removeEntry(index: number) {
    setEntries((prev) => prev.filter((_, i) => i !== index));
  }
  function addEntry(changeType: ProposedChangeEntry["changeType"]) {
    setEntries((prev) => [...prev, emptyEntry(changeType)]);
  }

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-foreground">Verdict</span>
        <div className="flex flex-wrap gap-4 text-sm text-foreground">
          {canApproveOrReject && (
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="verdict"
                value="APPROVED"
                checked={verdict === "APPROVED"}
                onChange={() => setVerdict("APPROVED")}
              />
              Approve
            </label>
          )}
          {canApproveOrReject && (
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="verdict"
                value="REJECTED"
                checked={verdict === "REJECTED"}
                onChange={() => setVerdict("REJECTED")}
              />
              Reject
            </label>
          )}
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="verdict"
              value="REVISION_REQUESTED"
              checked={verdict === "REVISION_REQUESTED"}
              onChange={() => setVerdict("REVISION_REQUESTED")}
            />
            Request revision
          </label>
        </div>
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-foreground">Rationale</span>
        <textarea
          name="rationale"
          rows={3}
          minLength={rationaleMinLength}
          maxLength={rationaleMaxLength}
          required
          className={inputClasses}
          placeholder="Explain the reasoning behind this decision."
        />
      </label>

      {showEditor && targetOptions && (
        <div className="flex flex-col gap-4 rounded-md border border-border bg-background p-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-foreground">Proposed changes</span>
          </div>
          {entries.map((entry, index) => (
            <div key={index} className="rounded-md border border-border p-3">
              <div className="flex items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-xs">
                  <span className={labelClasses}>Change type</span>
                  <select
                    className={inputClasses}
                    value={entry.changeType}
                    onChange={(e) =>
                      updateEntry(
                        index,
                        emptyEntry(e.target.value as ProposedChangeEntry["changeType"]),
                      )
                    }
                  >
                    <option value="MILESTONE_DATE">Milestone date</option>
                    <option value="RISK_UPDATE">Risk update</option>
                    <option value="BUDGET_UPDATE">Budget update</option>
                    <option value="NEW_ACTION">New action</option>
                  </select>
                </label>
                {entries.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeEntry(index)}
                    className="text-xs text-danger hover:underline"
                  >
                    Remove
                  </button>
                )}
              </div>
              <div className="mt-3">
                <ChangeEntryFields
                  entry={entry}
                  onChange={(next) => updateEntry(index, next)}
                  targetOptions={targetOptions}
                />
              </div>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => addEntry("MILESTONE_DATE")}
              className="rounded-md border border-border px-2 py-1 text-xs text-foreground hover:bg-border/40"
            >
              + Milestone date
            </button>
            <button
              type="button"
              onClick={() => addEntry("RISK_UPDATE")}
              className="rounded-md border border-border px-2 py-1 text-xs text-foreground hover:bg-border/40"
            >
              + Risk update
            </button>
            <button
              type="button"
              onClick={() => addEntry("BUDGET_UPDATE")}
              className="rounded-md border border-border px-2 py-1 text-xs text-foreground hover:bg-border/40"
            >
              + Budget update
            </button>
            <button
              type="button"
              onClick={() => addEntry("NEW_ACTION")}
              className="rounded-md border border-border px-2 py-1 text-xs text-foreground hover:bg-border/40"
            >
              + New action
            </button>
          </div>
          <input
            type="hidden"
            name="proposedChangesJson"
            value={JSON.stringify(serializeEntries(entries))}
          />
        </div>
      )}

      {state.error && (
        <p
          role="alert"
          className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          {state.error}
        </p>
      )}

      <div>
        <button
          type="submit"
          disabled={isPending}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {isPending ? "Submitting…" : "Submit decision"}
        </button>
      </div>
    </form>
  );
}
