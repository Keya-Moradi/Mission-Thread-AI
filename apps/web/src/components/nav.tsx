import Link from "next/link";
import { ROLE_LABELS } from "@/lib/auth-helpers";
import { NavLinks } from "./nav-links";
import { SignOutButton } from "./sign-out-button";

export function Nav({ user }: { user: { name?: string | null; role?: string } }) {
  return (
    <header className="border-b border-border bg-surface print:hidden">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <Link href="/" className="shrink-0 text-sm font-semibold tracking-tight text-foreground">
          MissionThread AI
        </Link>
        <div className="flex shrink-0 items-center gap-3">
          <div className="hidden text-right text-sm leading-tight sm:block">
            <div className="font-medium text-foreground">{user.name}</div>
            <div className="text-muted">{user.role ? ROLE_LABELS[user.role] : ""}</div>
          </div>
          <SignOutButton />
        </div>
      </div>
      {/* Second row so nav links get their own horizontal-scroll area on
          narrow viewports instead of competing for space with the brand
          and user info in one row. */}
      <div className="mx-auto max-w-6xl px-4 pb-2 sm:px-6">
        <NavLinks role={user.role} />
      </div>
    </header>
  );
}
