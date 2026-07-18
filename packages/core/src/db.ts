import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

declare global {
  var __missionThreadPrisma: PrismaClient | undefined;
}

function createPrismaClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  return new PrismaClient({ adapter });
}

// A single PrismaClient instance is reused across hot reloads in dev and
// across serverless invocations in the same process, instead of opening a
// new connection pool on every import.
export const prisma = globalThis.__missionThreadPrisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__missionThreadPrisma = prisma;
}
