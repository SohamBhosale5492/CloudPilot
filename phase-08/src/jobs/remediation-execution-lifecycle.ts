import type { Prisma } from "@prisma/client";
import type { RemediationLease } from "./remediation-repo.js";
import type { ExpiredRemediationClaim } from "./remediation-repo.js";
import type { RemediationExecutionPersistenceService } from "../remediation/remediation-execution-persistence.js";
import type { TrustedClaimExecutionContextService } from "../remediation/trusted-claim-execution-context.js";

/** Transactional boundary joining the compatibility queue row to the authoritative execution aggregate. */
export interface RemediationExecutionLifecycle {
  startClaimed(tx: Prisma.TransactionClient, lease: RemediationLease): Promise<void>;
  expireClaim(tx: Prisma.TransactionClient, lease: ExpiredRemediationClaim): Promise<"requeued" | "failed" | "manual_review" | "terminal">;
}

export class PrismaRemediationExecutionLifecycle implements RemediationExecutionLifecycle {
  constructor(
    private readonly contexts: TrustedClaimExecutionContextService,
    private readonly executions: RemediationExecutionPersistenceService
  ) {}

  async startClaimed(tx: Prisma.TransactionClient, lease: RemediationLease): Promise<void> {
    const context = await this.contexts.prepareWithinTransaction(tx, lease);
    if (!context) throw new Error("Claimed remediation failed durable execution authorization.");
    const execution = await this.executions.startWithinTransaction(tx, lease, context);
    if (!execution) throw new Error("Claimed remediation could not start its durable execution.");
  }

  expireClaim(tx: Prisma.TransactionClient, lease: ExpiredRemediationClaim) {
    return this.executions.expireClaimWithinTransaction(tx, lease);
  }
}
