import Link from "next/link";
import { ROLE_LABELS } from "@/lib/auth-helpers";
import { SignOutButton } from "./sign-out-button";

const NAV_LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/programs/edgelink-x", label: "EdgeLink-X" },
  { href: "/audit", label: "Audit" },
];

export function Nav({ user }: { user: { name?: string | null; role?: string } }) {
  return (
    <header className="border-b border-border bg-surface">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-6">
          <Link href="/" className="text-sm font-semibold tracking-tight text-foreground">
            MissionThread AI
          </Link>
          <nav aria-label="Primary" className="flex items-center gap-1">
            {NAV_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="rounded-md px-3 py-1.5 text-sm text-muted transition-colors hover:bg-background hover:text-foreground"
              >
                {link.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right text-sm leading-tight">
            <div className="font-medium text-foreground">{user.name}</div>
            <div className="text-muted">{user.role ? ROLE_LABELS[user.role] : ""}</div>
          </div>
          <SignOutButton />
        </div>
      </div>
    </header>
  );
}
