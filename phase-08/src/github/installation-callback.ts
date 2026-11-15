import { createHash } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaOrganizationAuthorizationService } from "../organizations/authorization-service.js";
import { GitHubInstallationVerificationError, type VerifiedGitHubInstallation } from "./installation-verifier.js";

const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;
const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type GitHubInstallationCallbackErrorCode =
  | "invalid_callback"
  | "invalid_intent"
  | "intent_expired_or_consumed"
  | "initiator_mismatch"
  | "organization_forbidden"
  | "installation_conflict";

export class GitHubInstallationCallbackError extends Error {
  constructor(readonly code: GitHubInstallationCallbackErrorCode) {
    const message = {
      invalid_callback: "GitHub installation callback parameters are invalid.",
      invalid_intent: "GitHub installation request is invalid or unavailable.",
      intent_expired_or_consumed: "GitHub installation request is expired or already used.",
      initiator_mismatch: "This GitHub installation request belongs to another CloudPilot user.",
      organization_forbidden: "The user is no longer authorized to manage this organization's integrations.",
      installation_conflict: "This GitHub installation is already associated with another or inactive CloudPilot record. Contact an organization administrator."
    }[code];
    super(message);
    this.name = "GitHubInstallationCallbackError";
  }
}

export interface GitHubInstallationCallbackInput {
  identityUserId: string;
  installationId: string;
  state: string;
}

export interface GitHubInstallationCallbackResult {
  installationRecordId: string;
  organizationId: string;
  githubInstallationId: string;
  accountLogin: string;
  accountType: "User" | "Organization";
  status: "connected";
  alreadyConnected: boolean;
}

interface ConnectIntentSnapshot {
  id: string;
  organizationId: string;
  initiatedByIdentityUserId: string;
  stateHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

export interface GitHubInstallationCallbackStore {
  findIntent(stateHash: string): Promise<ConnectIntentSnapshot | null>;
  persistVerifiedInstallation(input: {
    intent: ConnectIntentSnapshot;
    identityUserId: string;
    installation: VerifiedGitHubInstallation;
    consumedAt: Date;
  }): Promise<{ installationRecordId: string; alreadyConnected: boolean }>;
}

export interface GitHubInstallationVerifier {
  verify(installationId: string): Promise<VerifiedGitHubInstallation>;
}

export function parseGitHubInstallationId(value: unknown): string | null {
  if (typeof value !== "string" || !/^[1-9]\d{0,18}$/.test(value)) return null;
  try {
    const parsed = BigInt(value);
    return parsed > 0n && parsed <= MAX_POSTGRES_BIGINT ? parsed.toString() : null;
  } catch { return null; }
}

export function isValidGitHubConnectState(value: unknown): value is string {
  return typeof value === "string" && STATE_PATTERN.test(value);
}

export class GitHubInstallationCallbackService {
  constructor(
    private readonly store: GitHubInstallationCallbackStore,
    private readonly authorization: PrismaOrganizationAuthorizationService,
    private readonly verifier: GitHubInstallationVerifier,
    private readonly now: () => Date = () => new Date()
  ) {}

  async complete(input: GitHubInstallationCallbackInput): Promise<GitHubInstallationCallbackResult> {
    const installationId = parseGitHubInstallationId(input?.installationId);
    if (!installationId || !isValidGitHubConnectState(input?.state) ||
        typeof input?.identityUserId !== "string" || input.identityUserId.length === 0) {
      throw new GitHubInstallationCallbackError("invalid_callback");
    }
    const stateHash = createHash("sha256").update(input.state, "utf8").digest("hex");
    const intent = await this.store.findIntent(stateHash);
    if (!intent) throw new GitHubInstallationCallbackError("invalid_intent");
    if (intent.initiatedByIdentityUserId !== input.identityUserId) {
      throw new GitHubInstallationCallbackError("initiator_mismatch");
    }
    if (intent.consumedAt !== null || intent.expiresAt.getTime() <= this.now().getTime()) {
      throw new GitHubInstallationCallbackError("intent_expired_or_consumed");
    }
    const authorized = await this.authorization.authorize(
      input.identityUserId,
      intent.organizationId,
      "organization:integrations:manage"
    );
    if (!authorized) throw new GitHubInstallationCallbackError("organization_forbidden");

    // This is a bounded read-only GET. Do not consume the intent until GitHub
    // verification succeeds; failed or transient verification can be retried.
    let installation: VerifiedGitHubInstallation;
    try { installation = await this.verifier.verify(installationId); }
    catch (error) {
      if (error instanceof GitHubInstallationVerificationError) throw error;
      throw new GitHubInstallationVerificationError("github_request_failed");
    }
    if (installation.installationId.toString() !== installationId) {
      throw new GitHubInstallationVerificationError("invalid_response");
    }

    const consumedAt = this.now();
    if (!Number.isFinite(consumedAt.getTime())) throw new GitHubInstallationCallbackError("invalid_callback");
    const persisted = await this.store.persistVerifiedInstallation({
      intent,
      identityUserId: input.identityUserId,
      installation,
      consumedAt
    });
    return {
      installationRecordId: persisted.installationRecordId,
      organizationId: intent.organizationId,
      githubInstallationId: installation.installationId.toString(),
      accountLogin: installation.accountLogin,
      accountType: installation.accountType,
      status: "connected",
      alreadyConnected: persisted.alreadyConnected
    };
  }
}

/** Rechecks authorization and atomically consumes, persists, and audits in one transaction. */
export class PrismaGitHubInstallationCallbackStore implements GitHubInstallationCallbackStore {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly authorization: PrismaOrganizationAuthorizationService
  ) {}

  findIntent(stateHash: string): Promise<ConnectIntentSnapshot | null> {
    return this.prisma.gitHubConnectIntent.findUnique({
      where: { stateHash },
      select: {
        id: true,
        organizationId: true,
        initiatedByIdentityUserId: true,
        stateHash: true,
        expiresAt: true,
        consumedAt: true
      }
    });
  }

  persistVerifiedInstallation(input: {
    intent: ConnectIntentSnapshot;
    identityUserId: string;
    installation: VerifiedGitHubInstallation;
    consumedAt: Date;
  }): Promise<{ installationRecordId: string; alreadyConnected: boolean }> {
    return this.prisma.$transaction(async (tx) => {
      const authorized = await this.authorization.authorizeInTransaction(
        tx,
        input.identityUserId,
        input.intent.organizationId,
        "organization:integrations:manage"
      );
      if (!authorized) throw new GitHubInstallationCallbackError("organization_forbidden");

      const installationId = input.installation.installationId;
      const existing = await tx.organizationGitHubInstallation.findUnique({
        where: { githubInstallationId: installationId },
        select: { id: true, organizationId: true, status: true }
      });
      if (existing && (existing.organizationId !== input.intent.organizationId || existing.status !== "active")) {
        throw new GitHubInstallationCallbackError("installation_conflict");
      }

      // The row lock and predicate make replay consumption atomic. Expiry is
      // checked again after the GitHub request; the surrounding transaction
      // rolls this update back if any later write or audit fails.
      const consumed = await tx.gitHubConnectIntent.updateMany({
        where: {
          id: input.intent.id,
          stateHash: input.intent.stateHash,
          initiatedByIdentityUserId: input.identityUserId,
          consumedAt: null,
          expiresAt: { gt: input.consumedAt }
        },
        data: { consumedAt: input.consumedAt }
      });
      if (consumed.count !== 1) {
        throw new GitHubInstallationCallbackError("intent_expired_or_consumed");
      }

      if (existing) {
        return { installationRecordId: existing.id, alreadyConnected: true };
      }

      let record: { id: string };
      try {
        record = await tx.organizationGitHubInstallation.create({
          data: {
            organizationId: input.intent.organizationId,
            githubInstallationId: installationId,
            githubAccountId: input.installation.accountId,
            githubAccountLogin: input.installation.accountLogin,
            githubAccountType: input.installation.accountType,
            verifiedPermissions: input.installation.permissions as Prisma.InputJsonValue,
            connectedByIdentityUserId: input.identityUserId,
            status: "active",
            verifiedAt: input.consumedAt
          },
          select: { id: true }
        });
      } catch (error) {
        if (isUniqueConflict(error)) throw new GitHubInstallationCallbackError("installation_conflict");
        throw error;
      }

      await tx.organizationAuditEvent.create({
        data: {
          organizationId: input.intent.organizationId,
          actorUserId: input.identityUserId,
          action: "github.installation.connected",
          targetType: "github_installation",
          targetId: record.id,
          metadata: {
            installationRecordId: record.id,
            githubInstallationId: installationId.toString(),
            accountLogin: input.installation.accountLogin,
            accountType: input.installation.accountType,
            verifiedPermissionNames: Object.keys(input.installation.permissions).sort()
          } satisfies Prisma.InputJsonObject
        },
        select: { id: true }
      });
      return { installationRecordId: record.id, alreadyConnected: false };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }).catch((error: unknown) => {
      if (isUniqueConflict(error)) throw new GitHubInstallationCallbackError("installation_conflict");
      throw error;
    });
  }
}

function isUniqueConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === "P2002" || error.code === "P2034");
}
