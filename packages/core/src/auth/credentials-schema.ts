import { z } from "zod";

export const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

export type Credentials = z.infer<typeof credentialsSchema>;

export const sessionUserSchema = z.object({
  id: z.string(),
  role: z.enum(["PROGRAM_MANAGER", "ENGINEERING_LEAD", "EXECUTIVE_VIEWER"]),
});

export type SessionUser = z.infer<typeof sessionUserSchema>;
