import { requireSession } from "@/lib/auth-helpers";
import { Nav } from "@/components/nav";

export default async function AuditPage() {
  const session = await requireSession();

  return (
    <div className="flex min-h-screen flex-col">
      <Nav user={{ name: session.user.name, role: session.user.role }} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
        <h1 className="text-xl font-semibold text-foreground">Audit History</h1>
        <div className="mt-6 rounded-lg border border-border bg-surface p-6 text-sm text-muted">
          The filterable, append-only audit history is built in Phase 5, once analyses, approvals,
          and applied changes exist to audit. Phase 1 confirms this route is reachable,
          authenticated, and styled consistently with the rest of the shell.
        </div>
      </main>
    </div>
  );
}
