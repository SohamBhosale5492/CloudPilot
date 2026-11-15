import type { Prisma } from "@prisma/client";

type Transaction = Prisma.TransactionClient;

const MAX_SERIALIZATION_RETRIES = 3;

function isSerializationFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { code?: unknown; meta?: { code?: unknown } };
  return record.code === "P2034" || record.code === "40001" || record.meta?.code === "40001";
}

/**
 * Retries a pure Serializable transaction a bounded number of times on PostgreSQL
 * serialization conflicts (`40001` / Prisma `P2034`).
 */
export async function withSerializationRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!isSerializationFailure(error) || attempt >= MAX_SERIALIZATION_RETRIES) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
}

export async function lockActiveOrganization(tx: Transaction, organizationId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ locked: boolean }>>`
    SELECT public.cloudpilot_lock_active_organization(${organizationId}::uuid) AS locked
  `;
  return rows.length === 1 && rows[0]!.locked;
}

export async function lockActiveMember(tx: Transaction, organizationId: string, userId: string): Promise<string | null> {
  const rows = await tx.$queryRaw<Array<{ role: string | null }>>`
    SELECT public.cloudpilot_lock_active_member(${organizationId}::uuid, ${userId}::uuid) AS role
  `;
  return rows.length === 1 ? rows[0]!.role : null;
}

export async function lockActiveActorForUpdate(
  tx: Transaction, organizationId: string, userId: string
): Promise<string | null> {
  const rows = await tx.$queryRaw<Array<{ role: string | null }>>`
    SELECT public.cloudpilot_lock_active_actor_for_update(${organizationId}::uuid, ${userId}::uuid) AS role
  `;
  return rows.length === 1 ? rows[0]!.role : null;
}

export async function lockScopedFinding(
  tx: Transaction, tenantId: string, projectId: string, scanId: string, findingId: string
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ locked: boolean }>>`
    SELECT public.cloudpilot_lock_scoped_finding(${tenantId}, ${projectId}, ${scanId}, ${findingId}) AS locked
  `;
  return rows.length === 1 && rows[0]!.locked;
}

export async function lockActiveBindingInstallation(
  tx: Transaction,
  input: { tenantId: string; organizationId: string; projectId: string; bindingId: string;
    installationId: string; githubRepositoryId: string }
): Promise<boolean> {
  if (!/^[1-9][0-9]*$/.test(input.githubRepositoryId)) return false;
  const rows = await tx.$queryRaw<Array<{ locked: boolean }>>`
    SELECT public.cloudpilot_lock_active_binding_installation(
      ${input.tenantId}, ${input.organizationId}::uuid, ${input.projectId},
      ${input.bindingId}::uuid, ${input.installationId}::uuid, ${input.githubRepositoryId}::bigint
    ) AS locked
  `;
  return rows.length === 1 && rows[0]!.locked;
}
