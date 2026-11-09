import { createHash } from "node:crypto";
import { ArtifactOnlyGitHubClient, type ArtifactGitHubClientOptions, type GitHubRepositoryIdentity } from "./artifact-only-github-client.js";
import { GITHUB_ARTIFACT_WRITER_PERMISSIONS, GITHUB_DRAFT_PR_PERMISSIONS, type GitHubInstallationToken } from "./app-token-service.js";
import type { AuthorizedGitHubRepositoryAccess } from "./organization-authorization-contract.js";
import type { RemediationLease } from "../jobs/remediation-repo.js";
import { isTrustedClaimExecutionContext, type TrustedClaimExecutionContext, type TrustedClaimExecutionContextService } from "../remediation/trusted-claim-execution-context.js";

const capabilityBrand: unique symbol = Symbol("AuthorizedArtifactGitHubCapability");
const capabilityRecords = new WeakMap<object, CapabilityRecord>();
const MAX_ACTIVE_CAPABILITIES = 1024;
const pullRequestCapabilityBrand: unique symbol = Symbol("AuthorizedArtifactPullRequestCapability");
const pullRequestCapabilityRecords = new WeakMap<object, PullRequestCapabilityRecord>();
const MAX_ACTIVE_PULL_REQUEST_CAPABILITIES = 1024;

export interface AuthorizedArtifactGitHubCapability {
  readonly [capabilityBrand]: true;
  readonly proposalId: string;
  readonly tenantId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly repositoryBindingId: string;
  readonly installationRecordId: string;
  readonly installationId: string;
  readonly repositoryId: string;
  readonly repository: GitHubRepositoryIdentity;
  readonly executionContextHash: string;
  readonly artifactHash: string;
  readonly baseRef: string;
  readonly baseCommitSha: string;
  readonly lease: Readonly<{ remediationId: string; workerId: string; leaseTokenHash: string; expiresAt: string }>;
  readonly permissions: typeof GITHUB_ARTIFACT_WRITER_PERMISSIONS;
  readonly expiresAt: string;
  /** Capabilities are deliberately not serializable or transferable. */
  toJSON(): never;
}

export function isAuthorizedArtifactGitHubCapability(value: unknown): value is AuthorizedArtifactGitHubCapability {
  return !!value && typeof value === "object" && capabilityRecords.has(value as object);
}

export interface AuthorizedArtifactPullRequestCapability {
  readonly [pullRequestCapabilityBrand]: true;
  readonly proposalId: string;
  readonly tenantId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly repositoryBindingId: string;
  readonly installationRecordId: string;
  readonly installationId: string;
  readonly repositoryId: string;
  readonly repository: GitHubRepositoryIdentity;
  readonly executionContextHash: string;
  readonly artifactHash: string;
  readonly baseRef: string;
  readonly baseCommitSha: string;
  readonly lease: Readonly<{ remediationId: string; workerId: string; leaseTokenHash: string; expiresAt: string }>;
  readonly permissions: typeof GITHUB_DRAFT_PR_PERMISSIONS;
  readonly expiresAt: string;
  toJSON(): never;
}

export function isAuthorizedArtifactPullRequestCapability(value: unknown): value is AuthorizedArtifactPullRequestCapability {
  return !!value && typeof value === "object" && pullRequestCapabilityRecords.has(value as object);
}

const leaseGuards = new WeakMap<object, { readonly capability: object; readonly assertOwned: (signal?: AbortSignal) => Promise<void> }>();

export interface ServerOwnedExecutionLeaseGuard {
  assertOwned(signal?: AbortSignal): Promise<void>;
}

export function isServerOwnedExecutionLeaseGuard(value: unknown): value is ServerOwnedExecutionLeaseGuard {
  return !!value && typeof value === "object" && leaseGuards.has(value as object);
}

export function isLeaseGuardForCapability(value: unknown, capability: unknown): value is ServerOwnedExecutionLeaseGuard {
  if (!value || typeof value !== "object" || !capability || typeof capability !== "object") return false;
  return leaseGuards.get(value as object)?.capability === capability;
}

interface TrustedContextProvider {
  prepare(lease: RemediationLease): Promise<TrustedClaimExecutionContext | null>;
}

interface TokenProvider {
  getArtifactWriterInstallationToken(input: AuthorizedGitHubRepositoryAccess): Promise<GitHubInstallationToken>;
  getDraftPullRequestInstallationToken(input: AuthorizedGitHubRepositoryAccess): Promise<GitHubInstallationToken>;
  invalidate(installationId: string | number): void;
}

export interface GitHubExecutionCapabilityOptions {
  /** Test transport/time controls only; request authorization guard is always owned by this service. */
  clientOptions?: Omit<ArtifactGitHubClientOptions, "beforeRequest">;
  now?: () => number;
}

interface CapabilityRecord {
  readonly issuer: object;
  readonly context: TrustedClaimExecutionContext;
  readonly lease: RemediationLease;
  readonly token: GitHubInstallationToken;
  client?: ArtifactOnlyGitHubClient;
  readonly expiresAtMs: number;
  active: boolean;
}

interface PullRequestCapabilityRecord {
  readonly issuer: object;
  readonly parent: CapabilityRecord;
  readonly client: ArtifactOnlyGitHubClient;
  readonly expiresAtMs: number;
  active: boolean;
}

/**
 * Persistence-backed, one-lease authorization bridge to the immutable-ID
 * GitHub client. It never accepts a caller-provided context or repo identity.
 * The context service performs the serializable persisted-state validation.
 */
export class GitHubExecutionCapabilityService {
  private readonly now: () => number;
  private readonly issuer = {};
  private readonly records = new Set<CapabilityRecord>();
  private readonly pullRequestRecords = new Set<PullRequestCapabilityRecord>();

  constructor(
    private readonly contexts: TrustedContextProvider,
    private readonly tokens: TokenProvider,
    private readonly options: GitHubExecutionCapabilityOptions = {}
  ) {
    this.now = options.now ?? Date.now;
  }

  async issue(lease: RemediationLease): Promise<AuthorizedArtifactGitHubCapability | null> {
    this.prune();
    if (this.records.size >= MAX_ACTIVE_CAPABILITIES) return null;
    let context: TrustedClaimExecutionContext | null;
    try { context = await this.contexts.prepare(lease); }
    catch { return null; }
    if (!isTrustedClaimExecutionContext(context) || !matchesLease(context, lease)) return null;
    const access = Object.freeze({ installationId: context.githubInstallationId, repositoryId: context.githubRepositoryId }) as AuthorizedGitHubRepositoryAccess;
    let token: GitHubInstallationToken;
    try { token = await this.tokens.getArtifactWriterInstallationToken(access); }
    catch { return null; }
    const tokenExpiry = Date.parse(token.expiresAt);
    if (token.installationId !== context.githubInstallationId || token.repositoryId !== context.githubRepositoryId ||
        !exactPermissions(token.permissions) ||
        !Number.isFinite(tokenExpiry) || tokenExpiry <= this.now() ||
        tokenExpiry > this.now() + 60 * 60_000 + 60_000) return null;

    const expiresAtMs = Math.min(tokenExpiry, Date.parse(context.lease.expiresAt));
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= this.now()) return null;
    let record: CapabilityRecord | undefined = { issuer: this.issuer, context, lease, token, expiresAtMs, active: true };
    const client = new ArtifactOnlyGitHubClient(token, {
      ...this.options.clientOptions,
      now: this.now,
      beforeRequest: async () => {
        if (!record) throw new Error("capability unavailable");
        await this.assertRecord(record);
      }
    });

    let repository: GitHubRepositoryIdentity;
    try { repository = await client.resolveRepository(); }
    catch { return null; }
    if (repository.id !== context.githubRepositoryId || repository.owner !== context.repositoryOwner ||
        repository.name !== context.repositoryName) return null;

    // Close the gap between GitHub identity resolution and capability issuance.
    let confirmed: TrustedClaimExecutionContext | null;
    try { confirmed = await this.contexts.prepare(lease); }
    catch { return null; }
    if (!isTrustedClaimExecutionContext(confirmed) || !sameExecution(context, confirmed)) return null;
    if (!record.active || record.expiresAtMs <= this.now()) return null;

    const leaseView = Object.freeze({ remediationId: context.remediationId, workerId: context.lease.workerId,
      leaseTokenHash: createHash("sha256").update(context.lease.leaseToken, "utf8").digest("hex"),
      expiresAt: context.lease.expiresAt });
    const capability = Object.freeze({
      [capabilityBrand]: true as const,
      proposalId: context.proposalId,
      tenantId: context.tenantId,
      organizationId: context.organizationId,
      projectId: context.projectId,
      repositoryBindingId: context.repositoryBindingId,
      installationRecordId: context.installationRecordId,
      installationId: context.githubInstallationId,
      repositoryId: context.githubRepositoryId,
      repository,
      executionContextHash: trustedExecutionContextFingerprint(context),
      artifactHash: context.artifactHash,
      baseRef: context.baseRef,
      baseCommitSha: context.baseCommitSha,
      lease: leaseView,
      permissions: GITHUB_ARTIFACT_WRITER_PERMISSIONS,
      expiresAt: new Date(expiresAtMs).toISOString(),
      toJSON(): never { throw new Error("Execution capability serialization is prohibited."); }
    }) as AuthorizedArtifactGitHubCapability;
    record.client = client;
    capabilityRecords.set(capability, record);
    this.records.add(record);
    return capability;
  }

  /** Returns the client only for a live runtime-issued capability. */
  clientFor(capability: unknown): ArtifactOnlyGitHubClient | null {
    if (!isAuthorizedArtifactGitHubCapability(capability)) return null;
    const record = capabilityRecords.get(capability);
    if (!record || record.issuer !== this.issuer || !record.active) return null;
    if (record.expiresAtMs <= this.now()) { record.active = false; this.records.delete(record); return null; }
    return record.client ?? null;
  }

  /** Issues a separate PR-only capability linked to the exact live Git-write capability. */
  async issueDraftPullRequestCapability(capability: unknown): Promise<AuthorizedArtifactPullRequestCapability | null> {
    this.prune();
    if (!isAuthorizedArtifactGitHubCapability(capability) ||
        this.pullRequestRecords.size >= MAX_ACTIVE_PULL_REQUEST_CAPABILITIES) return null;
    const parent = capabilityRecords.get(capability as object);
    if (!parent || parent.issuer !== this.issuer || !parent.active || parent.expiresAtMs <= this.now()) return null;
    try { await this.assertRecord(parent); } catch { return null; }
    const access = Object.freeze({ installationId: parent.context.githubInstallationId,
      repositoryId: parent.context.githubRepositoryId }) as AuthorizedGitHubRepositoryAccess;
    let token: GitHubInstallationToken;
    try { token = await this.tokens.getDraftPullRequestInstallationToken(access); }
    catch { return null; }
    const tokenExpiry = Date.parse(token.expiresAt);
    if (token.installationId !== parent.context.githubInstallationId || token.repositoryId !== parent.context.githubRepositoryId ||
        !exactPullRequestPermissions(token.permissions) || !Number.isFinite(tokenExpiry) || tokenExpiry <= this.now() ||
        tokenExpiry > this.now() + 60 * 60_000 + 60_000) return null;
    const expiresAtMs = Math.min(tokenExpiry, parent.expiresAtMs, Date.parse(parent.context.lease.expiresAt));
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= this.now()) return null;

    let record: PullRequestCapabilityRecord | undefined;
    const client = new ArtifactOnlyGitHubClient(token, {
      ...this.options.clientOptions,
      now: this.now,
      beforeRequest: async () => {
        if ((record && !record.active) || !parent.active) throw new Error("capability unavailable");
        await this.assertRecord(parent);
      }
    });
    let repository: GitHubRepositoryIdentity;
    try { repository = await client.resolveRepository(); }
    catch { return null; }
    if (repository.id !== parent.context.githubRepositoryId || repository.owner !== parent.context.repositoryOwner ||
        repository.name !== parent.context.repositoryName) return null;
    let confirmed: TrustedClaimExecutionContext | null;
    try { confirmed = await this.contexts.prepare(parent.lease); }
    catch { return null; }
    if (!isTrustedClaimExecutionContext(confirmed) || !sameExecution(parent.context, confirmed) ||
        !parent.active || parent.expiresAtMs <= this.now()) return null;

    record = { issuer: this.issuer, parent, client, expiresAtMs, active: true };
    const source = capability as AuthorizedArtifactGitHubCapability;
    const prCapability = Object.freeze({
      [pullRequestCapabilityBrand]: true as const,
      proposalId: source.proposalId,
      tenantId: source.tenantId,
      organizationId: source.organizationId,
      projectId: source.projectId,
      repositoryBindingId: source.repositoryBindingId,
      installationRecordId: source.installationRecordId,
      installationId: source.installationId,
      repositoryId: source.repositoryId,
      repository,
      executionContextHash: source.executionContextHash,
      artifactHash: source.artifactHash,
      baseRef: source.baseRef,
      baseCommitSha: source.baseCommitSha,
      lease: source.lease,
      permissions: GITHUB_DRAFT_PR_PERMISSIONS,
      expiresAt: new Date(expiresAtMs).toISOString(),
      toJSON(): never { throw new Error("Execution capability serialization is prohibited."); }
    }) as AuthorizedArtifactPullRequestCapability;
    pullRequestCapabilityRecords.set(prCapability, record);
    this.pullRequestRecords.add(record);
    return prCapability;
  }

  pullRequestClientFor(capability: unknown): ArtifactOnlyGitHubClient | null {
    if (!isAuthorizedArtifactPullRequestCapability(capability)) return null;
    const record = pullRequestCapabilityRecords.get(capability as object);
    if (!record || record.issuer !== this.issuer || !record.active || !record.parent.active ||
        record.expiresAtMs <= this.now()) return null;
    return record.client;
  }

  leaseGuardFor(capability: unknown): ServerOwnedExecutionLeaseGuard | null {
    if (!isAuthorizedArtifactGitHubCapability(capability)) return null;
    const record = capabilityRecords.get(capability);
    if (!record || record.issuer !== this.issuer || !record.active || !record.client) return null;
    const guard = Object.freeze({ assertOwned: async (signal?: AbortSignal) => this.assertRecord(record, signal) });
    leaseGuards.set(guard, { capability, assertOwned: guard.assertOwned });
    return guard;
  }

  invalidateLease(remediationId: string): void {
    this.invalidate((record) => record.context.remediationId === remediationId);
  }

  invalidateBinding(bindingId: string): void {
    this.invalidate((record) => record.context.repositoryBindingId === bindingId);
  }

  invalidateOrganization(organizationId: string): void {
    this.invalidate((record) => record.context.organizationId === organizationId);
  }

  invalidateIdentity(identityUserId: string): void {
    this.invalidate((record) => record.context.requesterIdentityUserId === identityUserId ||
      record.context.approverIdentityUserId === identityUserId);
  }

  invalidateInstallation(installationId: string): void {
    this.tokens.invalidate(installationId);
    this.invalidate((record) => record.context.githubInstallationId === installationId, false);
  }

  private invalidate(predicate: (record: CapabilityRecord) => boolean, invalidateTokens = true): void {
    const invalidatedInstallations = new Set<string>();
    for (const record of this.records) if (predicate(record)) {
      record.active = false;
      invalidatedInstallations.add(record.context.githubInstallationId);
    }
    if (invalidateTokens) for (const installationId of invalidatedInstallations) this.tokens.invalidate(installationId);
  }

  private prune(): void {
    for (const record of this.records) if (!record.active || record.expiresAtMs <= this.now()) this.records.delete(record);
    for (const record of this.pullRequestRecords) if (!record.active || !record.parent.active || record.expiresAtMs <= this.now()) {
      record.active = false;
      this.pullRequestRecords.delete(record);
    }
  }

  private async assertRecord(record: CapabilityRecord, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted || !record.active || record.expiresAtMs <= this.now()) {
      this.revoke(record);
      throw new Error("Execution lease is no longer valid.");
    }
    let current: TrustedClaimExecutionContext | null;
    try { current = await this.contexts.prepare(record.lease); }
    catch { this.revoke(record); throw new Error("Execution lease state is unavailable."); }
    if (!isTrustedClaimExecutionContext(current) || !sameExecution(current, record.context)) {
      this.revoke(record);
      throw new Error("Execution authorization changed.");
    }
  }

  private revoke(record: CapabilityRecord): void {
    if (!record.active) return;
    record.active = false;
    this.tokens.invalidate(record.context.githubInstallationId);
  }
}

function matchesLease(context: TrustedClaimExecutionContext, lease: RemediationLease): boolean {
  return context.remediationId === lease.id && context.tenantId === lease.tenantId &&
    context.projectId === lease.projectId && context.lease.workerId === lease.workerId &&
    context.lease.leaseToken === lease.leaseToken;
}

function sameExecution(a: TrustedClaimExecutionContext, b: TrustedClaimExecutionContext): boolean {
  return a.remediationId === b.remediationId && a.tenantId === b.tenantId && a.organizationId === b.organizationId &&
    a.projectId === b.projectId && a.scanId === b.scanId && a.findingId === b.findingId &&
    a.requesterIdentityUserId === b.requesterIdentityUserId && a.approverIdentityUserId === b.approverIdentityUserId &&
    a.approvedAt === b.approvedAt && a.repositoryBindingId === b.repositoryBindingId &&
    a.installationRecordId === b.installationRecordId && a.githubInstallationId === b.githubInstallationId &&
    a.githubRepositoryId === b.githubRepositoryId && a.repositoryOwner === b.repositoryOwner &&
    a.repositoryName === b.repositoryName && a.baseRef === b.baseRef && a.baseCommitSha === b.baseCommitSha &&
    a.artifactHash === b.artifactHash && a.lease.leaseToken === b.lease.leaseToken &&
    a.filePath === b.filePath && a.operation === b.operation && a.mode === b.mode &&
    a.lease.workerId === b.lease.workerId && a.lease.expiresAt === b.lease.expiresAt;
}

export function trustedExecutionContextFingerprint(context: TrustedClaimExecutionContext): string {
  const tuple = [context.remediationId, context.proposalId, context.tenantId, context.organizationId, context.projectId,
    context.scanId, context.findingId, context.requesterIdentityUserId, context.approverIdentityUserId, context.approvedAt,
    context.repositoryBindingId, context.installationRecordId, context.githubInstallationId, context.githubRepositoryId,
    context.repositoryOwner, context.repositoryName, context.baseRef, context.baseCommitSha, context.artifactHash,
    context.filePath, context.operation, context.mode, context.originalBlobSha, context.originalContentSha256,
    context.originalContentBase64, context.originalMode, context.originalFileType, context.renderedContentSha256,
    context.lease.remediationId, context.lease.tenantId, context.lease.projectId, context.lease.workerId,
    context.lease.leaseToken, context.lease.expiresAt];
  return createHash("sha256").update(JSON.stringify(tuple), "utf8").digest("hex");
}

function exactPermissions(value: GitHubInstallationToken["permissions"]): boolean {
  const permissions = value as unknown as Record<string, unknown>;
  return !!value && permissions.contents === "write" && permissions.metadata === "read" &&
    Object.keys(value).length === 2 && Object.keys(value).every((key) => key === "contents" || key === "metadata");
}

function exactPullRequestPermissions(value: GitHubInstallationToken["permissions"]): boolean {
  const permissions = value as unknown as Record<string, unknown>;
  return !!value && permissions.pull_requests === "write" && permissions.metadata === "read" && Object.keys(value).length === 2 &&
    Object.keys(value).every((key) => key === "pull_requests" || key === "metadata");
}
