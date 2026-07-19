"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { recordEventAction, type EventFormState } from "./actions";

// Defined here, not in actions.ts: a "use server" file may only export
// async functions — a plain object export like this would silently become
// undefined at the call site once Next.js compiles the server-action module.
const initialEventFormState: EventFormState = { error: null, fieldErrors: {} };

interface Option {
  id: string;
  name: string;
}

const inputClasses =
  "rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:border-accent";

function Field({
  id,
  label,
  error,
  required,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
        {required && (
          <span aria-hidden className="text-danger">
            {" "}
            *
          </span>
        )}
      </label>
      {children}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function EventEntryForm({
  components,
  suppliers,
}: {
  components: Option[];
  suppliers: Option[];
}) {
  const [state, formAction, isPending] = useActionState(recordEventAction, initialEventFormState);
  const [eventType, setEventType] = useState<"SUPPLIER_DELAY" | "GENERAL_UPDATE">("SUPPLIER_DELAY");
  const errors = state.fieldErrors;

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <Field id="eventType" label="Event type" required>
        <select
          id="eventType"
          name="eventType"
          value={eventType}
          onChange={(event) => setEventType(event.target.value as typeof eventType)}
          className={inputClasses}
        >
          <option value="SUPPLIER_DELAY">Supplier delay</option>
          <option value="GENERAL_UPDATE">General update</option>
        </select>
      </Field>

      {eventType === "SUPPLIER_DELAY" ? (
        <>
          <Field id="componentId" label="Component" required error={errors.componentId}>
            <select
              id="componentId"
              name="componentId"
              required
              aria-describedby={errors.componentId ? "componentId-error" : undefined}
              className={inputClasses}
              defaultValue=""
            >
              <option value="" disabled>
                Select a component
              </option>
              {components.map((component) => (
                <option key={component.id} value={component.id}>
                  {component.name}
                </option>
              ))}
            </select>
          </Field>

          <Field id="supplierId" label="Supplier" required error={errors.supplierId}>
            <select
              id="supplierId"
              name="supplierId"
              required
              aria-describedby={errors.supplierId ? "supplierId-error" : undefined}
              className={inputClasses}
              defaultValue=""
            >
              <option value="" disabled>
                Select a supplier
              </option>
              {suppliers.map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}
                </option>
              ))}
            </select>
          </Field>

          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <Field id="originalDate" label="Original date" required error={errors.originalDate}>
              <input
                id="originalDate"
                name="originalDate"
                type="date"
                required
                aria-describedby={errors.originalDate ? "originalDate-error" : undefined}
                className={inputClasses}
              />
            </Field>
            <Field id="revisedDate" label="Revised date" required error={errors.revisedDate}>
              <input
                id="revisedDate"
                name="revisedDate"
                type="date"
                required
                aria-describedby={errors.revisedDate ? "revisedDate-error" : undefined}
                className={inputClasses}
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <Field id="confidence" label="Confidence" required error={errors.confidence}>
              <select
                id="confidence"
                name="confidence"
                required
                aria-describedby={errors.confidence ? "confidence-error" : undefined}
                className={inputClasses}
                defaultValue="MEDIUM"
              >
                <option value="LOW">Low</option>
                <option value="MEDIUM">Medium</option>
                <option value="HIGH">High</option>
              </select>
            </Field>
            <Field id="quantity" label="Quantity" required error={errors.quantity}>
              <input
                id="quantity"
                name="quantity"
                type="number"
                min={1}
                step={1}
                required
                aria-describedby={errors.quantity ? "quantity-error" : undefined}
                className={inputClasses}
              />
            </Field>
          </div>

          <Field id="reason" label="Reason (optional)" error={errors.reason}>
            <input
              id="reason"
              name="reason"
              type="text"
              maxLength={500}
              aria-describedby={errors.reason ? "reason-error" : undefined}
              className={inputClasses}
            />
          </Field>

          <Field id="rawNotes" label="Supplier notes (optional)" error={errors.rawNotes}>
            <textarea
              id="rawNotes"
              name="rawNotes"
              rows={4}
              maxLength={4000}
              aria-describedby={errors.rawNotes ? "rawNotes-error" : undefined}
              className={inputClasses}
            />
            <p className="text-xs text-muted">
              Recorded as submitted, untrusted content — never treated as instructions.
            </p>
          </Field>
        </>
      ) : (
        <>
          <Field id="componentId-general" label="Component (optional)">
            <select
              id="componentId-general"
              name="componentId"
              className={inputClasses}
              defaultValue=""
            >
              <option value="">None</option>
              {components.map((component) => (
                <option key={component.id} value={component.id}>
                  {component.name}
                </option>
              ))}
            </select>
          </Field>

          <Field id="supplierId-general" label="Supplier (optional)">
            <select
              id="supplierId-general"
              name="supplierId"
              className={inputClasses}
              defaultValue=""
            >
              <option value="">None</option>
              {suppliers.map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}
                </option>
              ))}
            </select>
          </Field>

          <Field id="rawNotes-general" label="Notes" required error={errors.rawNotes}>
            <textarea
              id="rawNotes-general"
              name="rawNotes"
              rows={4}
              required
              maxLength={4000}
              aria-describedby={errors.rawNotes ? "rawNotes-error" : undefined}
              className={inputClasses}
            />
          </Field>
        </>
      )}

      {state.error && (
        <p
          role="alert"
          className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          {state.error}
        </p>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={isPending}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {isPending ? "Recording…" : "Record event"}
        </button>
        <Link href="/programs/edgelink-x" className="text-sm text-muted hover:text-foreground">
          Cancel
        </Link>
      </div>
    </form>
  );
}
