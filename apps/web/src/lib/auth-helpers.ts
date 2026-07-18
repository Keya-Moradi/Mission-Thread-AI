import { redirect } from "next/navigation";
import { auth } from "@/auth";

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
