import type { PrismaClient } from "@prisma/client";
import { requireIntegrationFixtureDatabaseUrl } from "../../../test-support/integration-database.js";

export const APPROVED_PHASE06_TEST_DATABASE = "cloudpilot_runtime_role_test";

export function requireDedicatedPhase06TestDatabase(value: string | undefined): string {
  return requireIntegrationFixtureDatabaseUrl(value);
}

export async function cleanupTestOwnedFixtures(prisma: PrismaClient, tenantIds: readonly string[]): Promise<void> {
  if (tenantIds.length === 0) return;
  await prisma.tenant.deleteMany({ where: { id: { in: [...tenantIds] } } });
}
