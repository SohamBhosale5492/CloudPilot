import type { PrismaRemediationProposalRepository } from "../api/remediation-proposal-repo.js";
import type { IdentityResolver } from "../identity/identity-resolver.js";
import type { VerifiedExternalIdentity } from "../identity/external-identity.js";
import type { TrustedRepositorySnapshot } from "./execution-artifact.js";

export interface TrustedRepositorySnapshotRequest {
  identityUserId: string;
  tenantId: string;
  organizationId: string;
  projectId: string;
  repositoryBindingId: string;
  installationRecordId: string;
  immutableRepositoryId: string;
  filePath: string;
}

/**
 * Implementations must re-authorize the user and all project/adoption/binding/
 * installation scope through trusted persistence, resolve the persisted immutable
 * repository's default branch to a commit, read only at that pinned commit, and
 * prove the path is a regular non-symlink file.
 * Implementations are internal-only and are invoked by artifact preparation or
 * the separately staged execution authorization contract; neither performs a
 * GitHub write.
 */
export interface TrustedRepositorySnapshotReader {
  readSnapshot(request: TrustedRepositorySnapshotRequest): Promise<TrustedRepositorySnapshot>;
}

export interface PrepareRemediationArtifactInput {
  tenantId: string;
  remediationId: string;
  identity: VerifiedExternalIdentity;
}

export class RemediationExecutionArtifactPreparationService {
  constructor(
    private readonly proposals: PrismaRemediationProposalRepository,
    private readonly identities: IdentityResolver,
    private readonly expectedIssuer: string
  ) {}

  async prepare(input: PrepareRemediationArtifactInput): Promise<{ artifactHash: string; replayed: boolean }> {
    if (!input.identity || input.identity.issuer !== this.expectedIssuer || !input.identity.subject) {
      throw new Error("Verified remediation identity is required.");
    }
    const user = await this.identities.resolve(input.identity, false);
    return this.proposals.prepareExecutionArtifact({
      tenantId: input.tenantId,
      remediationId: input.remediationId,
      identityUserId: user.id
    });
  }
}
