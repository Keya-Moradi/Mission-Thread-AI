"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/programs/edgelink-x", label: "EdgeLink-X" },
  { href: "/audit", label: "Audit" },
];

export function NavLinks() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Primary"
      // overflow-x-auto rather than flex-wrap: on narrow viewports the links
      // scroll horizontally as one row instead of wrapping into a second,
      // uneven row — simpler and more predictable than a hamburger menu for
      // a 3-item nav.
      className="flex items-center gap-1 overflow-x-auto"
    >
      {NAV_LINKS.map((link) => {
        const isActive = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={isActive ? "page" : undefined}
            className={`shrink-0 rounded-md px-3 py-1.5 text-sm transition-colors ${
              isActive
                ? "bg-background text-foreground"
                : "text-muted hover:bg-background hover:text-foreground"
            }`}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
