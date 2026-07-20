"use client";

export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-background"
    >
      Print
    </button>
  );
}
