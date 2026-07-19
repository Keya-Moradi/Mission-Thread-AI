import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma, Role } from "@missionthread/core";

export async function requireSession() {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }
  return session;
}

export const ROLE_LABELS: Record<string, string> = {
  PROGRAM_MANAGER: "Program Manager",
  ENGINEERING_LEAD: "Engineering Lead",
  EXECUTIVE_VIEWER: "Executive Viewer",
};

/**
 * Page-level authorization check for the event-entry form. This is a UX
 * convenience — it stops a non-manager from ever seeing the form — not the
 * actual security boundary: `recordProgramEvent()` in packages/core
 * independently re-verifies the actor's current database role before
 * writing anything, regardless of what this check allowed. Deliberately
 * re-reads the role from the database rather than trusting
 * `session.user.role` (a JWT claim cached at login time, which could be
 * stale if an admin changed this user's role after the session was
 * issued) — see docs/DECISIONS.md, "Phase 3 mutation authorization".
 */
export async function requireProgramManager() {
  const session = await requireSession();
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, role: true },
  });
  if (!user || user.role !== Role.PROGRAM_MANAGER) {
    redirect("/programs/edgelink-x");
  }
  return { session, user };
}
