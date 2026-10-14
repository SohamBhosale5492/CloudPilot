import { PrismaClient } from "@prisma/client";

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgresql://cloudpilot:cloudpilot_password@localhost:5432/cloudpilot_test";
}

let globalPrisma: PrismaClient | null = null;

export function getPrismaClient(): PrismaClient {
  if (!globalPrisma) {
    globalPrisma = new PrismaClient({
      log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"]
    });
  }
  return globalPrisma;
}

export async function disconnectPrisma(): Promise<void> {
  if (globalPrisma) {
    await globalPrisma.$disconnect();
    globalPrisma = null;
  }
}

export interface DbHealthResult {
  ok: boolean;
  error?: string;
  remedy?: string;
}

/**
 * Checks whether PostgreSQL is reachable via Prisma.
 * If unreachable, returns an actionable message advising how to start PostgreSQL.
 */
export async function checkDatabaseConnection(client?: PrismaClient): Promise<DbHealthResult> {
  const prisma = client ?? getPrismaClient();
  try {
    await prisma.$queryRawUnsafe("SELECT 1;");
    return { ok: true };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: errorMsg,
      remedy:
        "PostgreSQL is unavailable. Please verify DATABASE_URL or start the local container with: 'docker compose -f phase-06/docker-compose.yml up -d'."
    };
  }
}
