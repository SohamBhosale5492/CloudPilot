import { createHash } from "node:crypto";
import {
  ArtifactGitHubClientError,
  ArtifactOnlyGitHubClient,
  ARTIFACT_COMMIT_MESSAGE,
  githubMutationRequestFingerprint,
  githubMutationTarget,
  type GitHubBlob,
  type GitHubCommit,
  type GitHubRepositoryIdentity,
  type GitHubMutationCorrelation,
  type GitHubMutationStage,
  type GitHubMutationRejectionEvidence,
  type GitHubTreeEntry
} from "../github/artifact-only-github-client.js";
import {
  isAuthorizedArtifactGitHubCapability,
  isLeaseGuardForCapability,
  trustedExecutionContextFingerprint,
  type AuthorizedArtifactGitHubCapability,
  type GitHubExecutionCapabilityService,
  type ServerOwnedExecutionLeaseGuard
} from "../github/github-execution-capability.js";
import { isTrustedClaimExecutionContext, type TrustedClaimExecutionContext } from "./trusted-claim-execution-context.js";
import { internalMutationBoundary, MutationIntentCommittedError } from "../github/internal-mutation-boundary.js";
import { isRemediationExecutionSession, type RemediationExecutionSession } from "./remediation-execution-persistence.js";

const MAX_TREE_ENTRIES = 10_000;
const MAX_TREE_DEPTH = 64;
const SHA1 = /^[0-9a-f]{40}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const verifiedWriteResults = new WeakMap<object, AuthorizedArtifactGitHubCapability>();
const verifiedMutationReceipts = new WeakMap<object, { capability: AuthorizedArtifactGitHubCapability; stage: string;
  operationKey: string; requestHash: string }>();

export function isVerifiedArtifactWriterMutationReceipt(value: unknown, capability: AuthorizedArtifactGitHubCapability,
  stage: string, operationKey: string, requestHash: string,
  expected: { readonly resourceType: string; readonly resourceId: string; readonly commitSha?: string }): boolean {
  if (!value || typeof value !== "object") return false;
  const receipt = verifiedMutationReceipts.get(value as object);
  const fields = value as Record<string, unknown>;
  return !!receipt && receipt.capability === capability && receipt.stage === stage &&
    receipt.operationKey === operationKey && receipt.requestHash === requestHash &&
    fields.resourceType === expected.resourceType && fields.resourceId === expected.resourceId &&
    fields.commitSha === expected.commitSha;
}

export interface ArtifactOnlyGitHubWriterInput {
  readonly context: TrustedClaimExecutionContext;
  readonly capability: AuthorizedArtifactGitHubCapability;
  readonly leaseGuard: ServerOwnedExecutionLeaseGuard;
  readonly executionSession: RemediationExecutionSession;
  readonly signal?: AbortSignal;
}

export type ArtifactOnlyGitHubWriteResult =
  | { readonly kind: "committed"; readonly commitSha: string; readonly proposalId: string; readonly artifactHash: string;
      readonly repositoryId: string; readonly baseCommitSha: string }
  | { readonly kind: "failed"; readonly code: "invalid_trust_input" | "lease_lost" | "base_ref_moved" |
      "source_state_mismatch" | "github_read_failed" | "github_write_rejected" | "rate_limited";
      readonly retryAfterMs?: number; readonly rejectionEvidence?: GitHubMutationRejectionEvidence }
  | { readonly kind: "manual_review"; readonly code: "ambiguous_blob_write" | "ambiguous_tree_write" |
      "ambiguous_commit_write" | "post_write_verification_failed" | "lease_lost_after_write" |
      "ambiguous_remote_operation" };

export type VerifiedArtifactOnlyGitHubWriteResult = Extract<ArtifactOnlyGitHubWriteResult, { readonly kind: "committed" }>;

/** A result is trusted only when this writer created the exact object for this capability. */
export function isVerifiedArtifactOnlyGitHubWriteResult(value: unknown,
  capability: AuthorizedArtifactGitHubCapability): value is VerifiedArtifactOnlyGitHubWriteResult {
  if (!value || typeof value !== "object" || verifiedWriteResults.get(value as object) !== capability) return false;
  const result = value as Partial<VerifiedArtifactOnlyGitHubWriteResult>;
  return result.kind === "committed" && SHA1.test(result.commitSha ?? "") &&
    result.proposalId === capability.proposalId && result.artifactHash === capability.artifactHash &&
    result.repositoryId === capability.repositoryId && result.baseCommitSha === capability.baseCommitSha;
}

class WriterFailure extends Error {
  constructor(
    readonly code: "invalid_trust_input" | "lease_lost" | "base_ref_moved" | "source_state_mismatch" |
      "github_read_failed" | "github_write_rejected" | "post_write_verification_failed" |
      "ambiguous_blob_write" | "ambiguous_tree_write" | "ambiguous_commit_write" | "rate_limited",
    readonly retryAfterMs?: number,
    readonly rejectionEvidence?: GitHubMutationRejectionEvidence
  ) {
    super(code);
  }
}

/**
 * Writes only the exact immutable artifact carried by a persisted trusted
 * context. It never creates branches or pull requests and never calls a planner.
 */
export class ArtifactOnlyGitHubWriter {
  constructor(private readonly capabilities: GitHubExecutionCapabilityService, private readonly now: () => number = Date.now) {}

  /** Read-only restart recovery for the content-addressed blob operation. */
  async recoverBlobMutation(input: {
    readonly context: TrustedClaimExecutionContext; readonly capability: AuthorizedArtifactGitHubCapability;
    readonly leaseGuard: ServerOwnedExecutionLeaseGuard; readonly identity: import("./remediation-execution-persistence.js").ExecutionMutationIdentity;
  }): Promise<object | null> {
    const { context, capability, leaseGuard, identity } = input;
    if (!isTrustedClaimExecutionContext(context) || !isAuthorizedArtifactGitHubCapability(capability) ||
        !isLeaseGuardForCapability(leaseGuard, capability) || !this.contextMatchesCapability(context, capability) ||
        identity.stage !== "blob" || !identity.operation || !identity.expected ||
        identity.operation.filePath !== context.filePath || identity.operation.renderedContentSha256 !== context.renderedContentSha256 ||
        identity.operation.byteLength !== context.renderedBytes.byteLength || identity.expected.encoding !== "exact-artifact-bytes" ||
        identity.expected.contentSha256 !== context.renderedContentSha256 || identity.expected.byteLength !== context.renderedBytes.byteLength ||
        typeof identity.expected.blobSha !== "string" || !SHA1.test(identity.expected.blobSha)) return null;
    const expectedSha = gitBlobSha(context.renderedBytes);
    if (identity.expected.blobSha !== expectedSha) return null;
    const client = this.capabilities.clientFor(capability);
    if (!client) return null;
    try {
      await leaseGuard.assertOwned();
      const repository = await client.resolveRepository();
      if (repository.id !== context.githubRepositoryId || repository.owner !== context.repositoryOwner ||
          repository.name !== context.repositoryName) return null;
      const blob = await client.readBlob(repository, expectedSha);
      await leaseGuard.assertOwned();
      if (blob.sha !== expectedSha || !equalBytes(blob.bytes, context.renderedBytes)) return null;
      const receipt = Object.freeze({ stage: "blob", operationKey: identity.operationKey, requestHash: identity.requestHash,
        resourceType: "blob", resourceId: expectedSha });
      verifiedMutationReceipts.set(receipt, { capability, stage: "blob", operationKey: identity.operationKey,
        requestHash: identity.requestHash });
      return receipt;
    } catch { return null; }
  }

  async write(input: ArtifactOnlyGitHubWriterInput): Promise<ArtifactOnlyGitHubWriteResult> {
    if (!input || !isTrustedClaimExecutionContext(input.context) ||
        !isAuthorizedArtifactGitHubCapability(input.capability) ||
        !isLeaseGuardForCapability(input.leaseGuard, input.capability) || !isRemediationExecutionSession(input.executionSession) ||
        !this.contextMatchesCapability(input.context, input.capability)) {
      return { kind: "failed", code: "invalid_trust_input" };
    }
    const client = this.capabilities.clientFor(input.capability);
    if (!client) return { kind: "failed", code: "invalid_trust_input" };
    // The deadline is the capability service's latest validated, token-bounded lease expiry; it follows
    // accepted heartbeat renewals and is never taken from caller-supplied lease fields.
    const deadlinePassed = (): boolean => {
      const deadline = this.capabilities.currentDeadlineFor(input.capability);
      return deadline === null || !Number.isFinite(deadline) || deadline <= this.now();
    };
    if (deadlinePassed()) return { kind: "failed", code: "lease_lost" };

    const controller = new AbortController();
    const externalAbort = () => controller.abort();
    if (input.signal?.aborted) controller.abort();
    else input.signal?.addEventListener("abort", externalAbort, { once: true });
    // Abort any in-flight request as soon as the capability is revoked or its latest deadline passes.
    const stopDeadlineWatch = this.capabilities.watchDeadline(input.capability, () => controller.abort());
    const guard = async (): Promise<void> => {
      if (controller.signal.aborted) throw new WriterFailure("lease_lost");
      try { await input.leaseGuard.assertOwned(controller.signal); }
      catch { controller.abort(); throw new WriterFailure("lease_lost"); }
      if (deadlinePassed()) { controller.abort(); throw new WriterFailure("lease_lost"); }
    };

    let mutationStarted: "blob" | "tree" | "commit" | undefined;
    let remoteMutationCompleted = false;
    try {
      await guard();
      const repository = await client.resolveRepository(controller.signal);
      if (!this.repositoryMatches(repository, input.context, input.capability)) throw new WriterFailure("invalid_trust_input");

      const ref = await client.readReference(repository, input.context.baseRef, controller.signal);
      if (ref.sha !== input.context.baseCommitSha) throw new WriterFailure("base_ref_moved");
      const baseCommit = await client.readCommit(repository, input.context.baseCommitSha, controller.signal);
      if (baseCommit.sha !== input.context.baseCommitSha) throw new WriterFailure("source_state_mismatch");
      const baseRoot = await client.readTree(repository, baseCommit.treeSha, controller.signal);
      if (baseRoot.sha !== baseCommit.treeSha) throw new WriterFailure("source_state_mismatch");

      const basePathEntry = await client.resolvePathAtCommit(repository, baseCommit.sha, input.context.filePath, controller.signal);
      if (input.context.operation === "create") {
        if (basePathEntry !== null || input.context.originalBlobSha !== null || input.context.originalContentSha256 !== null ||
            input.context.originalContentBase64 !== null || input.context.originalMode !== null || input.context.originalFileType !== null) {
          throw new WriterFailure("source_state_mismatch");
        }
      } else {
        if (!basePathEntry || basePathEntry.type !== "blob" || basePathEntry.mode !== "100644" ||
            basePathEntry.sha !== input.context.originalBlobSha || input.context.originalMode !== "100644" ||
            input.context.originalFileType !== "blob" || !input.context.originalContentBase64 ||
            !input.context.originalContentSha256 || !SHA256.test(input.context.originalContentSha256)) {
          throw new WriterFailure("source_state_mismatch");
        }
        const sourceBlob = await client.readBlob(repository, basePathEntry.sha, controller.signal);
        const expectedOriginal = decodeBase64(input.context.originalContentBase64);
        if (!expectedOriginal || !equalBytes(sourceBlob.bytes, expectedOriginal) ||
            sha256(sourceBlob.bytes) !== input.context.originalContentSha256) throw new WriterFailure("source_state_mismatch");
      }

      const renderedBytes = input.context.renderedBytes;
      if (sha256(renderedBytes) !== input.context.renderedContentSha256) throw new WriterFailure("invalid_trust_input");
      const baseEntries = await flattenTree(client, repository, baseCommit.treeSha, controller.signal);
      const expectedBlobSha = gitBlobSha(renderedBytes);

      const blobOperation = internalMutationBoundary<GitHubBlob | undefined, GitHubBlob>({
        stage: "blob",
        scope: mutationScope(input.context),
        requestFingerprint: githubMutationRequestFingerprint("POST", githubMutationTarget(repository, "/git/blobs"),
          JSON.stringify({ content: Buffer.from(renderedBytes).toString("base64"), encoding: "base64" })),
        operation: { filePath: input.context.filePath, renderedContentSha256: input.context.renderedContentSha256,
          byteLength: renderedBytes.byteLength, expectedBlobSha },
        expected: { blobSha: expectedBlobSha, contentSha256: input.context.renderedContentSha256,
          byteLength: renderedBytes.byteLength, encoding: "exact-artifact-bytes" },
        mutate: async (identity) => {
          await guard();
          try { return await client.createBlob(repository, renderedBytes, mutationCorrelation(input.executionSession, identity), controller.signal); }
          catch (error) {
            if (isAmbiguous(error) && !controller.signal.aborted) return undefined;
            throw error;
          }
        },
        verify: async (response) => {
          // The blob ID is content-addressed, so the exact expected object can
          // be verified by read-only lookup even after a lost create response.
          let verified;
          try { verified = await client.readBlob(repository, expectedBlobSha, controller.signal); }
          catch (error) {
            if (!response) throw new WriterFailure("ambiguous_blob_write");
            throw error;
          }
          if (response && response.sha !== expectedBlobSha) throw new WriterFailure("post_write_verification_failed");
          if (!equalBytes(verified.bytes, renderedBytes) || verified.sha !== expectedBlobSha) {
            throw new WriterFailure("post_write_verification_failed");
          }
          return verified;
        }
      });
      let blob;
      mutationStarted = "blob";
      try {
        await persistMutationIntent(input.executionSession, blobOperation, guard);
        const response = await blobOperation.mutateOnce();
        remoteMutationCompleted = true;
        blob = await blobOperation.verify(response);
        await persistMutationResult(input.executionSession, blobOperation, input.capability, "blob", expectedBlobSha);
      } catch (error) {
        if (error instanceof WriterFailure) throw error;
        if (error instanceof MutationIntentCommittedError) throw error;
        if (remoteMutationCompleted && error instanceof ArtifactGitHubClientError && error.code === "invalid_token") {
          throw new WriterFailure("lease_lost");
        }
        if (!remoteMutationCompleted && error instanceof ArtifactGitHubClientError && error.code === "rate_limited") {
          throw new WriterFailure("rate_limited", error.retryAfterMs, error.rejectionEvidence);
        }
        if (!isAmbiguous(error)) throw new WriterFailure("github_write_rejected");
        if (controller.signal.aborted) throw new WriterFailure("ambiguous_blob_write");
        throw new WriterFailure("ambiguous_blob_write");
      }
      mutationStarted = undefined;
      if (blob.sha !== expectedBlobSha || !equalBytes(blob.bytes, renderedBytes)) {
        throw new WriterFailure("post_write_verification_failed");
      }

      mutationStarted = "tree";
      let tree;
      let treeResponse;
      let verifiedTreeEntries: Map<string, GitHubTreeEntry> | undefined;
      const treeOperation = internalMutationBoundary<import("../github/artifact-only-github-client.js").GitHubTree,
        import("../github/artifact-only-github-client.js").GitHubTree>({
        stage: "tree",
        scope: mutationScope(input.context),
        requestFingerprint: githubMutationRequestFingerprint("POST", githubMutationTarget(repository, "/git/trees"),
          JSON.stringify({ base_tree: baseCommit.treeSha, tree: [{ path: input.context.filePath,
            mode: input.context.mode, type: "blob", sha: expectedBlobSha }] })),
        operation: { filePath: input.context.filePath, mode: input.context.mode, blobSha: expectedBlobSha,
          baseTreeSha: baseCommit.treeSha, operation: input.context.operation },
        expected: { baseCommitSha: baseCommit.sha, changedPath: input.context.filePath,
          blobSha: expectedBlobSha, mode: "100644", soleFileDelta: true },
        mutate: async (identity) => {
          await guard();
          return client.createTree(repository, baseCommit,
            [{ path: input.context.filePath, mode: input.context.mode, blob }], mutationCorrelation(input.executionSession, identity), controller.signal);
        },
        verify: async (response) => {
          if (response.baseCommitSha !== baseCommit.sha) throw new WriterFailure("post_write_verification_failed");
          const entries = await flattenTree(client, repository, response.sha, controller.signal);
          if (!exactSingleFileDelta(baseEntries, entries, input.context.filePath, input.context.operation, expectedBlobSha)) {
            throw new WriterFailure("post_write_verification_failed");
          }
          verifiedTreeEntries = entries;
          return response;
        }
      });
      try {
        await persistMutationIntent(input.executionSession, treeOperation, guard);
        treeResponse = await treeOperation.mutateOnce();
      } catch (error) {
        if (error instanceof ArtifactGitHubClientError && error.code === "rate_limited") {
          throw new WriterFailure("rate_limited", error.retryAfterMs, error.rejectionEvidence);
        }
        if (error instanceof WriterFailure) throw error;
        if (error instanceof MutationIntentCommittedError) throw error;
        throw new WriterFailure("ambiguous_tree_write");
      }
      remoteMutationCompleted = true;
      try { tree = await treeOperation.verify(treeResponse); }
      catch (error) {
        if (error instanceof ArtifactGitHubClientError && error.code === "invalid_token") throw new WriterFailure("lease_lost");
        if (error instanceof WriterFailure) throw error;
        throw new WriterFailure("post_write_verification_failed");
      }
      await persistMutationResult(input.executionSession, treeOperation, input.capability, "tree", tree.sha);
      mutationStarted = undefined;
      mutationStarted = "commit";
      let createdCommit: GitHubCommit;
      const commitOperation = internalMutationBoundary<GitHubCommit, GitHubCommit>({
          stage: "commit",
          scope: mutationScope(input.context),
          requestFingerprint: githubMutationRequestFingerprint("POST", githubMutationTarget(repository, "/git/commits"),
            JSON.stringify({ message: ARTIFACT_COMMIT_MESSAGE, tree: tree.sha, parents: [baseCommit.sha] })),
          operation: { treeSha: tree.sha, parentCommitSha: baseCommit.sha,
            expectedPath: input.context.filePath, expectedBlobSha, expectedMode: "100644" },
          expected: { commitParentSha: baseCommit.sha, commitTreeSha: tree.sha, changedPath: input.context.filePath,
            blobSha: expectedBlobSha, mode: "100644", soleFileDelta: true },
          mutate: async (identity) => {
            await guard();
            return client.createCommit(repository, tree, baseCommit, mutationCorrelation(input.executionSession, identity), controller.signal);
          },
          verify: async (response) => {
            if (response.parentShas.length !== 1 || response.parentShas[0] !== baseCommit.sha || response.treeSha !== tree.sha) {
              throw new WriterFailure("post_write_verification_failed");
            }
            const readBack = await client.readCommit(repository, response.sha, controller.signal);
            if (readBack.sha !== response.sha || readBack.treeSha !== tree.sha || readBack.parentShas.length !== 1 ||
                readBack.parentShas[0] !== baseCommit.sha) throw new WriterFailure("post_write_verification_failed");
            // treeOperation.verify already flattened and validated exactSingleFileDelta for tree.sha.
            // Because Git trees are content-addressed, readBack.treeSha === tree.sha proves the same tree.
            if (!verifiedTreeEntries) throw new WriterFailure("post_write_verification_failed");
            const finalEntry = verifiedTreeEntries.get(input.context.filePath);
            if (!finalEntry || finalEntry.sha !== expectedBlobSha || finalEntry.mode !== "100644" || finalEntry.type !== "blob") {
              throw new WriterFailure("post_write_verification_failed");
            }
            const finalBlob = await client.readBlob(repository, finalEntry.sha, controller.signal);
            if (!equalBytes(finalBlob.bytes, renderedBytes)) throw new WriterFailure("post_write_verification_failed");
            return readBack;
          }
        });
      let commitResponse: GitHubCommit;
      try {
        await persistMutationIntent(input.executionSession, commitOperation, guard);
        commitResponse = await commitOperation.mutateOnce();
      } catch (error) {
        if (error instanceof ArtifactGitHubClientError && error.code === "rate_limited") {
          throw new WriterFailure("rate_limited", error.retryAfterMs, error.rejectionEvidence);
        }
        if (error instanceof WriterFailure) throw error;
        if (error instanceof MutationIntentCommittedError) throw error;
        throw new WriterFailure("ambiguous_commit_write");
      }
      remoteMutationCompleted = true;
      try { createdCommit = await commitOperation.verify(commitResponse); }
      catch (error) {
        if (error instanceof ArtifactGitHubClientError && error.code === "invalid_token") throw new WriterFailure("lease_lost");
        if (error instanceof WriterFailure) throw error;
        throw new WriterFailure("post_write_verification_failed");
      }
      await persistMutationResult(input.executionSession, commitOperation, input.capability, "commit", createdCommit.sha,
        { commitSha: createdCommit.sha });
      mutationStarted = undefined;

      const result = Object.freeze({ kind: "committed" as const, commitSha: createdCommit.sha, proposalId: input.context.proposalId,
        artifactHash: input.context.artifactHash, repositoryId: input.context.githubRepositoryId,
        baseCommitSha: input.context.baseCommitSha });
      verifiedWriteResults.set(result, input.capability);
      return result;
    } catch (error) {
      controller.abort();
      if (error instanceof WriterFailure) {
        if (remoteMutationCompleted && error.code === "lease_lost") return { kind: "manual_review", code: "lease_lost_after_write" };
        if (mutationStarted === "commit" && error.code === "lease_lost") return { kind: "manual_review", code: "lease_lost_after_write" };
        if (mutationStarted === "blob" && error.code === "ambiguous_blob_write") return { kind: "manual_review", code: "ambiguous_blob_write" };
        if (mutationStarted === "tree" && error.code === "ambiguous_tree_write") return { kind: "manual_review", code: "ambiguous_tree_write" };
        if (mutationStarted === "commit" && error.code === "ambiguous_commit_write") return { kind: "manual_review", code: "ambiguous_commit_write" };
        if (error.code === "post_write_verification_failed") return { kind: "manual_review", code: "post_write_verification_failed" };
        if (error.code === "rate_limited") {
          return { kind: "failed", code: "rate_limited", ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
            ...(error.rejectionEvidence ? { rejectionEvidence: error.rejectionEvidence } : {}) };
        }
        if (error.code === "invalid_trust_input" || error.code === "lease_lost" || error.code === "base_ref_moved" ||
            error.code === "source_state_mismatch" || error.code === "github_read_failed" || error.code === "github_write_rejected") {
          return { kind: "failed", code: error.code };
        }
        return { kind: "manual_review", code: "post_write_verification_failed" };
      }
      if (error instanceof MutationIntentCommittedError) {
        return { kind: "manual_review", code: "ambiguous_remote_operation" };
      }
      if (error instanceof ArtifactGitHubClientError && error.code === "rate_limited") {
        return { kind: "failed", code: "rate_limited", ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
          ...(error.rejectionEvidence ? { rejectionEvidence: error.rejectionEvidence } : {}) };
      }
      if (error instanceof ArtifactGitHubClientError && error.code === "invalid_token") {
        if (remoteMutationCompleted) return { kind: "manual_review", code: "lease_lost_after_write" };
        if (!mutationStarted) return { kind: "failed", code: "lease_lost" };
      }
      if (mutationStarted === "blob") return { kind: "manual_review", code: "ambiguous_blob_write" };
      if (mutationStarted === "tree") return { kind: "manual_review", code: "ambiguous_tree_write" };
      if (mutationStarted === "commit") return { kind: "manual_review", code: "ambiguous_commit_write" };
      return { kind: "failed", code: "github_read_failed" };
    } finally {
      stopDeadlineWatch();
      input.signal?.removeEventListener("abort", externalAbort);
    }
  }

  private contextMatchesCapability(context: TrustedClaimExecutionContext, capability: AuthorizedArtifactGitHubCapability): boolean {
    const leaseHash = sha256(Buffer.from(context.lease.leaseToken, "utf8"));
    const permissions = capability.permissions;
    return context.proposalId === capability.proposalId && context.tenantId === capability.tenantId &&
      context.organizationId === capability.organizationId &&
      context.projectId === capability.projectId && context.repositoryBindingId === capability.repositoryBindingId &&
      context.installationRecordId === capability.installationRecordId && context.githubInstallationId === capability.installationId &&
      context.githubRepositoryId === capability.repositoryId && context.artifactHash === capability.artifactHash &&
      context.baseRef === capability.baseRef && context.baseCommitSha === capability.baseCommitSha &&
      capability.repository.id === context.githubRepositoryId && capability.repository.owner === context.repositoryOwner &&
      capability.repository.name === context.repositoryName && capability.lease.remediationId === context.remediationId &&
      capability.executionContextHash === trustedExecutionContextFingerprint(context) &&
      capability.lease.workerId === context.lease.workerId && capability.lease.leaseTokenHash === leaseHash &&
      capability.lease.expiresAt === context.lease.expiresAt && permissions.contents === "write" &&
      permissions.metadata === "read" && Object.keys(permissions).length === 2 &&
      Object.keys(permissions).every((key) => key === "contents" || key === "metadata") &&
      Date.parse(capability.expiresAt) > this.now() && Date.parse(context.lease.expiresAt) > this.now();
  }

  private repositoryMatches(repository: GitHubRepositoryIdentity, context: TrustedClaimExecutionContext,
    capability: AuthorizedArtifactGitHubCapability): boolean {
    return repository.id === context.githubRepositoryId && repository.id === capability.repositoryId &&
      repository.owner === context.repositoryOwner && repository.name === context.repositoryName &&
      repository.owner === capability.repository.owner && repository.name === capability.repository.name;
  }
}

async function flattenTree(
  client: ArtifactOnlyGitHubClient,
  repository: GitHubRepositoryIdentity,
  rootSha: string,
  signal: AbortSignal
): Promise<Map<string, GitHubTreeEntry>> {
  if (!client) throw new WriterFailure("github_read_failed");
  const result = new Map<string, GitHubTreeEntry>();
  const visitedPaths = new Set<string>();
  let visitedEntries = 0;
  const walk = async (treeSha: string, prefix: string, ancestors: Set<string>, depth: number): Promise<void> => {
    if (depth > MAX_TREE_DEPTH || ancestors.has(treeSha)) throw new WriterFailure("github_read_failed");
    const tree = await client.readTree(repository, treeSha, signal);
    const nextAncestors = new Set(ancestors).add(treeSha);
    for (const entry of tree.entries) {
      const path = prefix ? `${prefix}/${entry.path}` : entry.path;
      visitedEntries++;
      if (path.length > 1024 || visitedEntries > MAX_TREE_ENTRIES || visitedPaths.has(path)) throw new WriterFailure("github_read_failed");
      visitedPaths.add(path);
      if (entry.type === "tree") {
        if (entry.mode !== "040000" && entry.mode !== "40000") throw new WriterFailure("github_read_failed");
        await walk(entry.sha, path, nextAncestors, depth + 1);
      } else {
        if (result.has(path)) throw new WriterFailure("github_read_failed");
        result.set(path, Object.freeze({ ...entry, path }));
      }
    }
  };
  await walk(rootSha, "", new Set(), 0);
  return result;
}

function exactSingleFileDelta(base: Map<string, GitHubTreeEntry>, next: Map<string, GitHubTreeEntry>, path: string,
  operation: "create" | "update", expectedBlobSha: string): boolean {
  const before = base.get(path);
  const after = next.get(path);
  if (operation === "create" ? before !== undefined : !before || before.type !== "blob" || before.mode !== "100644") return false;
  if (!after || after.type !== "blob" || after.mode !== "100644" || after.sha !== expectedBlobSha) return false;
  const keys = new Set([...base.keys(), ...next.keys()]);
  let changed = 0;
  for (const key of keys) {
    const a = base.get(key); const b = next.get(key);
    if (!a || !b || a.type !== b.type || a.mode !== b.mode || a.sha !== b.sha) {
      if (key !== path) return false;
      changed++;
    }
  }
  return changed === 1;
}

function decodeBase64(value: string): Uint8Array | null {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? new Uint8Array(bytes) : null;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && Buffer.from(a).equals(Buffer.from(b));
}

function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function gitBlobSha(bytes: Uint8Array): string { return createHash("sha1").update(`blob ${bytes.byteLength}\0`, "utf8").update(bytes).digest("hex"); }

function mutationScope(context: TrustedClaimExecutionContext) {
  return { proposalId: context.proposalId, tenantId: context.tenantId, organizationId: context.organizationId,
    projectId: context.projectId, repositoryBindingId: context.repositoryBindingId,
    repositoryId: context.githubRepositoryId, installationRecordId: context.installationRecordId,
    artifactHash: context.artifactHash, baseRef: context.baseRef, baseCommitSha: context.baseCommitSha };
}

function mutationCorrelation(session: RemediationExecutionSession,
  operation: { readonly operationKey: string; readonly requestHash: string; readonly stage: GitHubMutationStage;
    readonly requestFingerprint: string }): GitHubMutationCorrelation {
  return Object.freeze({ executionId: session.executionId, attempt: session.attemptNumber,
    operationKey: operation.operationKey, stage: operation.stage, requestHash: operation.requestHash,
    requestFingerprint: operation.requestFingerprint });
}

async function persistMutationIntent(session: RemediationExecutionSession,
  operation: import("../github/internal-mutation-boundary.js").InternalMutationBoundary<unknown, unknown>,
  guard: () => Promise<void>): Promise<void> {
  await guard();
  await session.recordIntent({ stage: operation.stage, operationKey: operation.operationKey, requestHash: operation.requestHash,
    operation: operation.operation, expected: operation.expected });
  try { await guard(); } catch { throw new MutationIntentCommittedError(); }
}

async function persistMutationResult(session: RemediationExecutionSession,
  operation: import("../github/internal-mutation-boundary.js").InternalMutationBoundary<unknown, unknown>,
  capability: AuthorizedArtifactGitHubCapability, resourceType: string, resourceId: string,
  details: { readonly commitSha?: string } = {}): Promise<void> {
  const receipt = Object.freeze({ stage: operation.stage, operationKey: operation.operationKey,
    requestHash: operation.requestHash, resourceType, resourceId, ...details });
  verifiedMutationReceipts.set(receipt, { capability, stage: operation.stage,
    operationKey: operation.operationKey, requestHash: operation.requestHash });
  try {
    await session.recordMutationVerified({ identity: { stage: operation.stage, operationKey: operation.operationKey,
      requestHash: operation.requestHash }, capability, verificationReceipt: receipt, resourceType, resourceId, ...details });
  } catch { throw new WriterFailure("post_write_verification_failed"); }
}

function isAmbiguous(error: unknown): boolean {
  return error instanceof ArtifactGitHubClientError &&
    (error.code === "timeout" || error.code === "network_failure" || error.code === "upstream_failure" || error.code === "aborted");
}
