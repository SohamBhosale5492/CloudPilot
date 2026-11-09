import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

export const DEFAULT_GITHUB_CONNECT_INTENT_TTL_SECONDS = 10 * 60;
export const MIN_GITHUB_CONNECT_INTENT_TTL_SECONDS = 60;
export const MAX_GITHUB_CONNECT_INTENT_TTL_SECONDS = 15 * 60;

export interface GitHubConnectIntentRecord {
  organizationId: string;
  identityUserId: string;
  stateHash: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface GitHubConnectIntentStore {
  create(record: GitHubConnectIntentRecord): Promise<{ id: string }>;
}

export interface GitHubConnectIntentInput {
  organizationId: string;
  identityUserId: string;
}

export interface GitHubConnectIntentResult {
  intentId: string;
  state: string;
  installationUrl: string;
  expiresAt: string;
}

export interface GitHubConnectIntentOptions {
  appSlug?: string;
  lifetimeSeconds?: number;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
}

export type GitHubConnectIntentErrorCode = "missing_app_slug" | "invalid_app_slug" | "invalid_lifetime" | "invalid_randomness";

/** Safe fixed errors: they never include state, hashes, or credentials. */
export class GitHubConnectIntentError extends Error {
  constructor(readonly code: GitHubConnectIntentErrorCode) {
    const message = code === "missing_app_slug"
      ? "GitHub App installation is not configured. Set GITHUB_APP_SLUG on the backend."
      : code === "invalid_app_slug"
        ? "GITHUB_APP_SLUG must be a valid GitHub App slug."
        : code === "invalid_lifetime"
          ? "GitHub connect-intent lifetime configuration is invalid."
          : "Secure GitHub connect-intent state could not be generated.";
    super(message);
    this.name = "GitHubConnectIntentError";
  }
}

const VALID_APP_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;

export function isValidGitHubAppSlug(value: unknown): value is string {
  return typeof value === "string" && value.length <= 100 && VALID_APP_SLUG.test(value);
}

/** Generates one-time state and persists only its SHA-256 hash. */
export class GitHubConnectIntentService {
  private readonly now: () => number;
  private readonly generateRandomBytes: (size: number) => Buffer;
  private readonly lifetimeSeconds: number;

  constructor(
    private readonly store: GitHubConnectIntentStore,
    private readonly options: GitHubConnectIntentOptions
  ) {
    this.now = options.now ?? Date.now;
    this.generateRandomBytes = options.randomBytes ?? randomBytes;
    this.lifetimeSeconds = options.lifetimeSeconds ?? DEFAULT_GITHUB_CONNECT_INTENT_TTL_SECONDS;
    if (!Number.isSafeInteger(this.lifetimeSeconds) ||
        this.lifetimeSeconds < MIN_GITHUB_CONNECT_INTENT_TTL_SECONDS ||
        this.lifetimeSeconds > MAX_GITHUB_CONNECT_INTENT_TTL_SECONDS) {
      throw new GitHubConnectIntentError("invalid_lifetime");
    }
    if (options.appSlug !== undefined && !isValidGitHubAppSlug(options.appSlug)) {
      throw new GitHubConnectIntentError("invalid_app_slug");
    }
  }

  async create(input: GitHubConnectIntentInput): Promise<GitHubConnectIntentResult> {
    const slug = this.options.appSlug;
    if (slug === undefined) throw new GitHubConnectIntentError("missing_app_slug");
    if (!isValidGitHubAppSlug(slug)) throw new GitHubConnectIntentError("invalid_app_slug");

    const entropy = this.generateRandomBytes(32);
    if (!Buffer.isBuffer(entropy) || entropy.byteLength < 32) {
      throw new GitHubConnectIntentError("invalid_randomness");
    }
    const state = entropy.toString("base64url");
    if (!/^[A-Za-z0-9_-]+$/.test(state)) throw new GitHubConnectIntentError("invalid_randomness");
    const stateHash = createHash("sha256").update(state, "utf8").digest("hex");

    const createdAtMs = this.now();
    const expiresAtMs = createdAtMs + this.lifetimeSeconds * 1000;
    if (!Number.isFinite(createdAtMs) || !Number.isFinite(expiresAtMs) || expiresAtMs <= createdAtMs) {
      throw new GitHubConnectIntentError("invalid_lifetime");
    }
    const createdAt = new Date(createdAtMs);
    const expiresAt = new Date(expiresAtMs);
    if (!Number.isFinite(createdAt.getTime()) || !Number.isFinite(expiresAt.getTime()) || expiresAt <= createdAt) {
      throw new GitHubConnectIntentError("invalid_lifetime");
    }

    // URL construction is structured and the slug is restricted to one safe path segment.
    const installationUrl = new URL(`https://github.com/apps/${slug}/installations/new`);
    installationUrl.searchParams.set("state", state);

    // Do not return an initiation URL unless intent persistence (including audit) succeeds.
    const intent = await this.store.create({
      organizationId: input.organizationId,
      identityUserId: input.identityUserId,
      stateHash,
      createdAt,
      expiresAt
    });

    return {
      intentId: intent.id,
      state,
      installationUrl: installationUrl.toString(),
      expiresAt: expiresAt.toISOString()
    };
  }
}

/** Persists intent and audit in one transaction; raw state is never accepted here. */
export class PrismaGitHubConnectIntentStore implements GitHubConnectIntentStore {
  constructor(private readonly prisma: PrismaClient) {}

  create(record: GitHubConnectIntentRecord): Promise<{ id: string }> {
    return this.prisma.$transaction(async (tx) => {
      const intent = await tx.gitHubConnectIntent.create({
        data: {
          organizationId: record.organizationId,
          initiatedByIdentityUserId: record.identityUserId,
          stateHash: record.stateHash,
          createdAt: record.createdAt,
          expiresAt: record.expiresAt
        },
        select: { id: true }
      });
      await tx.organizationAuditEvent.create({
        data: {
          organizationId: record.organizationId,
          actorUserId: record.identityUserId,
          action: "github.installation.connect_intent_created",
          targetType: "github_connect_intent",
          targetId: intent.id,
          metadata: { intentId: intent.id }
        }
      });
      return intent;
    });
  }
}
