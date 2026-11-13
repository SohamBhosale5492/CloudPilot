import { PrismaClient } from "@prisma/client";

let globalPrisma: PrismaClient | null = null;

export function requireDatabaseUrl(value?: string): string {
  const candidate = arguments.length === 0 ? process.env.DATABASE_URL : value;
  if (typeof candidate !== "string" || candidate.trim() === "") {
    throw new Error("DATABASE_URL is required before database access.");
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL.");
  }

  if ((parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") || !parsed.hostname || parsed.pathname.length < 2) {
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL with a database name.");
  }

  return candidate;
}

export function getPrismaClient(): PrismaClient {
  const databaseUrl = requireDatabaseUrl();
  if (!globalPrisma) {
    globalPrisma = new PrismaClient({
      datasources: { db: { url: databaseUrl } },
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
