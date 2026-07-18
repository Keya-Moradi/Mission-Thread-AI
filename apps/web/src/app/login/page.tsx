import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { LoginForm } from "./login-form";

export const metadata: Metadata = {
  title: "Sign in — MissionThread AI",
};

export default async function LoginPage() {
  const session = await auth();
  if (session?.user) {
    redirect("/");
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm rounded-lg border border-border bg-surface p-8 shadow-sm">
        <h1 className="text-lg font-semibold text-foreground">MissionThread AI</h1>
        <p className="mt-1 text-sm text-muted">Sign in to the EdgeLink-X program workspace.</p>

        <div className="mt-6">
          <LoginForm />
        </div>

        <div className="mt-6 rounded-md border border-border bg-background p-3 text-xs leading-relaxed text-muted">
          <p className="font-medium text-foreground">Demo accounts (local development only)</p>
          <p className="mt-1">pm@missionthread.example — Program Manager</p>
          <p>lead@missionthread.example — Engineering Lead</p>
          <p>exec@missionthread.example — Executive Viewer</p>
          <p className="mt-1">
            Password for all demo accounts is documented in <code>README.md</code>.
          </p>
        </div>
      </div>
    </main>
  );
}
