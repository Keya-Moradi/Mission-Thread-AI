import { requireSession } from "@/lib/auth-helpers";
import { Nav } from "@/components/nav";

// Shared layout for every authenticated route. requireSession() runs once
// per request here instead of once per page, and Nav is rendered once
// instead of being duplicated in every page component. This route group
// (the parens in the folder name) is invisible in the URL, so /, /audit,
// and /programs/edgelink-x are unchanged — only /login sits outside it.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();

  return (
    <div className="flex min-h-screen flex-col">
      <Nav user={{ name: session.user.name, role: session.user.role }} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}
