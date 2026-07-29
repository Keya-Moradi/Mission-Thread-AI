"use client";

import Link from "next/link";
import type { ThreadNode } from "@missionthread/core";
import { StatusBadge } from "@/components/status-badge";

function formatMetadataValue(value: string | number | boolean | null): string {
  if (value === null) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

export function ThreadDetails({ node, onClose }: { node: ThreadNode | null; onClose: () => void }) {
  if (!node) {
    return (
      <div className="rounded-lg border border-border bg-surface p-4 text-sm text-muted">
        Select a node to see its details.
      </div>
    );
  }

  const metadataEntries = Object.entries(node.metadata);

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <span className="text-[10px] font-semibold tracking-wide text-muted uppercase">
            {node.kind.replaceAll("_", " ")}
          </span>
          <h3 className="text-sm font-semibold text-foreground">{node.label}</h3>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close details"
          className="shrink-0 rounded-md px-2 py-1 text-xs text-muted hover:bg-background"
        >
          Close
        </button>
      </div>

      <dl className="mt-3 flex flex-col gap-2 text-sm">
        <div className="flex items-center justify-between gap-2">
          <dt className="text-xs text-muted">Record ID</dt>
          <dd className="font-mono text-xs text-foreground">{node.recordId}</dd>
        </div>
        {node.status && (
          <div className="flex items-center justify-between gap-2">
            <dt className="text-xs text-muted">Status</dt>
            <dd>
              <StatusBadge status={node.status} />
            </dd>
          </div>
        )}
        {node.subtitle && (
          <div className="flex items-center justify-between gap-2">
            <dt className="text-xs text-muted">Detail</dt>
            <dd className="text-xs text-foreground">{node.subtitle}</dd>
          </div>
        )}
        {metadataEntries.map(([key, value]) => (
          <div key={key} className="flex items-center justify-between gap-2">
            <dt className="text-xs text-muted">{key}</dt>
            <dd className="text-xs text-foreground">{formatMetadataValue(value)}</dd>
          </div>
        ))}
      </dl>

      {node.href && (
        <Link
          href={node.href}
          className="mt-3 inline-block rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground transition-opacity hover:opacity-90"
        >
          Open record
        </Link>
      )}
    </div>
  );
}
