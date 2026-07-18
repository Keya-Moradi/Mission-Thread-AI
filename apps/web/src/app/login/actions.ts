"use server";

import { CredentialsSignin } from "next-auth";
import { signIn } from "@/auth";

export async function credentialsSignIn(
  _prevState: { error: string | null },
  formData: FormData,
): Promise<{ error: string | null }> {
  try {
    await signIn("credentials", {
      email: formData.get("email"),
      password: formData.get("password"),
      redirectTo: "/",
    });
    return { error: null };
  } catch (error) {
    if (error instanceof CredentialsSignin) {
      return { error: "Invalid email or password." };
    }
    throw error;
  }
}
