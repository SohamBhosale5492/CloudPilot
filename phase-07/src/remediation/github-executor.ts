/**
 * Database-independent GitHub remediation execution.
 *
 * This module plans an allowlisted YAML patch, reconciles the deterministic
 * branch and PRs in any state, and returns an outcome. It never reads or writes database
 * state, audit events, remediation lifecycle status, or retry counters.
 */

import crypto from "node:crypto";
import {
  GitHubApiError,
  GitHubConflictError,
  GitHubConnector,
  GitHubNotFoundError,
  GitHubInputError,
  redactSecrets,
  type PullRequest
} from "../github/github-connector.js";
import {
  FindingSummary,
  MalformedYamlError,
  planRemediation,
  RemediationPatch,
  UnsupportedYamlStructureError
} from "./planner.js";

export interface GitHubRepositoryTarget {
  owner: string;
  repo: string;
}

export interface GitHubExecutorConfig {
  baseBranch?: string;
  draft?: boolean;
  branchPrefix?: string;
}

export interface PreparedGitHubRemediation {
  readonly idempotencyKey: string;
  readonly branchName: string;
  readonly patch: RemediationPatch;
}

export type GitHubExecutionOutcome =
  | {
      kind: "pull-request";
      disposition: "created" | "reconciled";
      branchName: string;
      prNumber: number;
      prUrl: string;
      summary: string;
    }
  | {
      kind: "already-completed";
      branchName: string;
      prNumber: number;
      prUrl: string;
      summary: string;
    }
  | {
      kind: "manual-review";
      branchName: string;
      prNumber: number;
      prUrl: string;
      summary: string;
      message: string;
    }
  | {
      kind: "failed";
      errorCode: string;
      retryable: boolean;
      message: string;
      retryAfterMs?: number;
    };

export function buildBranchName(prefix: string, idempotencyKey: string): string {
  const hash = crypto.createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 16);
  return `${prefix}/${hash}`;
}

export function isTerminalGitHubExecutionError(error: unknown): boolean {
  if (error instanceof GitHubInputError) return true;
  if (error instanceof MalformedYamlError || error instanceof UnsupportedYamlStructureError) return true;
  if (error instanceof GitHubApiError) {
    return error.statusCode === 401 || error.statusCode === 403 || error.statusCode === 404;
  }
  return false;
}

export class GitHubExecutionFailure extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly errorCode: string
  ) {
    super(message);
    this.name = "GitHubExecutionFailure";
  }
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(message).slice(0, 512);
}

function errorCode(error: unknown): string {
  if (error instanceof GitHubApiError) return `github_http_${error.statusCode || "network"}`;
  if (error instanceof GitHubInputError) return "github_invalid_input";
  if (error instanceof MalformedYamlError) return "malformed_yaml";
  if (error instanceof UnsupportedYamlStructureError) return "unsupported_yaml";
  return "github_execution_error";
}

function retryAfterMilliseconds(error: unknown): number | undefined {
  if (!(error instanceof GitHubApiError) || error.statusCode !== 429 || !error.retryAfter) return undefined;
  const value = error.retryAfter.trim();
  let delayMs: number;
  if (/^\d+$/.test(value)) {
    delayMs = Number(value) * 1000;
  } else {
    const retryAt = Date.parse(value);
    if (!Number.isFinite(retryAt)) return undefined;
    delayMs = Math.max(0, retryAt - Date.now());
  }
  return Number.isFinite(delayMs) && delayMs <= 365 * 24 * 60 * 60 * 1000
    ? delayMs
    : undefined;
}

/**
 * Runs the external GitHub workflow only. Each network operation that may
 * have succeeded before timing out is reconciled against the deterministic
 * branch or open PR before another create operation is attempted.
 */
export class GitHubRemediationExecutor {
  private readonly baseBranch: string;
  private readonly branchPrefix: string;
  private readonly draft: boolean;

  constructor(private readonly github: GitHubConnector, config: GitHubExecutorConfig = {}) {
    this.baseBranch = config.baseBranch ?? "main";
    this.branchPrefix = config.branchPrefix ?? "cloudpilot/remediate";
    this.draft = config.draft ?? true;
  }

  prepare(finding: FindingSummary, idempotencyKey: string): PreparedGitHubRemediation {
    const patch = planRemediation(finding);
    return {
      idempotencyKey,
      branchName: buildBranchName(this.branchPrefix, idempotencyKey),
      patch
    };
  }

  async execute(
    target: GitHubRepositoryTarget,
    prepared: PreparedGitHubRemediation,
    signal?: AbortSignal
  ): Promise<GitHubExecutionOutcome> {
    try {
      const existingPr = await this.findPr(target, prepared.branchName, signal);
      if (existingPr) return this.reconcilePullRequest(existingPr, prepared);

      await this.ensureBranch(target, prepared.branchName, signal);
      const current = await this.readTargetFile(target, prepared, signal);
      const patchedContent = prepared.patch.applyPatch(current.content);

      if (patchedContent !== current.content) {
        try {
          await this.github.updateFile({
            owner: target.owner,
            repo: target.repo,
            path: prepared.patch.filePath,
            message: prepared.patch.commitMessage,
            content: patchedContent,
            sha: current.sha,
            branch: prepared.branchName
          }, signal);
        } catch (error) {
          // PUT may have committed even if the response timed out. Read back the
          // branch and proceed only if the deterministic patch is already there.
          const reconciled = await this.readTargetFile(target, prepared, signal);
          if (reconciled.content !== patchedContent) throw error;
        }
      }

      // Recheck immediately before creation to close the common race window.
      const beforeCreate = await this.findPr(target, prepared.branchName, signal);
      if (beforeCreate) return this.reconcilePullRequest(beforeCreate, prepared);

      try {
        const pr = await this.github.createPullRequest({
          owner: target.owner,
          repo: target.repo,
          title: prepared.patch.prTitle,
          body: prepared.patch.prBody,
          head: prepared.branchName,
          base: this.baseBranch,
          draft: this.draft
        }, signal);
        return this.reconcilePullRequest(pr, prepared, "created");
      } catch (error) {
        // A timeout can occur after GitHub accepted the PR. Reconcile by its
        // deterministic head before reporting failure or allowing a retry.
        const reconciled = await this.findPr(target, prepared.branchName, signal);
        if (reconciled) return this.reconcilePullRequest(reconciled, prepared);
        throw error;
      }
    } catch (error) {
      const retryAfterMs = retryAfterMilliseconds(error);
      return {
        kind: "failed",
        errorCode: errorCode(error),
        retryable: !isTerminalGitHubExecutionError(error),
        message: safeErrorMessage(error),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {})
      };
    }
  }

  private findPr(target: GitHubRepositoryTarget, branchName: string, signal?: AbortSignal): Promise<PullRequest | null> {
    return this.github.findPullRequestByHead(target.owner, target.repo, branchName, this.baseBranch, signal);
  }

  private async ensureBranch(
    target: GitHubRepositoryTarget,
    branchName: string,
    signal?: AbortSignal
  ): Promise<void> {
    try {
      await this.github.getBranchSha(target.owner, target.repo, branchName, signal);
      return;
    } catch (error) {
      if (!(error instanceof GitHubNotFoundError)) throw error;
    }

    const base = await this.github.getBranchSha(target.owner, target.repo, this.baseBranch, signal);
    try {
      await this.github.createBranch(target.owner, target.repo, branchName, base.sha, signal);
      return;
    } catch (error) {
      if (error instanceof GitHubConflictError) {
        // Another attempt may have created it; verify before proceeding.
        await this.github.getBranchSha(target.owner, target.repo, branchName, signal);
        return;
      }

      // A network timeout can be ambiguous. If the branch now exists, treat
      // this attempt as reconciled; otherwise preserve the original failure.
      try {
        await this.github.getBranchSha(target.owner, target.repo, branchName, signal);
        return;
      } catch {
        throw error;
      }
    }
  }

  private async readTargetFile(
    target: GitHubRepositoryTarget,
    prepared: PreparedGitHubRemediation,
    signal?: AbortSignal
  ): Promise<{ content: string; sha: string }> {
    try {
      const file = await this.github.getFileContent(
        target.owner,
        target.repo,
        prepared.patch.filePath,
        prepared.branchName,
        signal
      );
      return { content: file.content, sha: file.sha };
    } catch (error) {
      if (!(error instanceof GitHubNotFoundError)) throw error;
      return {
        content: prepared.patch.initialFileContent,
        sha: ""
      };
    }
  }

  private pullRequestOutcome(
    pr: PullRequest,
    prepared: PreparedGitHubRemediation,
    disposition: "created" | "reconciled"
  ): GitHubExecutionOutcome {
    return {
      kind: "pull-request",
      disposition,
      branchName: prepared.branchName,
      prNumber: pr.number,
      prUrl: pr.url,
      summary: prepared.patch.summary
    };
  }

  private reconcilePullRequest(
    pr: PullRequest,
    prepared: PreparedGitHubRemediation,
    disposition: "created" | "reconciled" = "reconciled"
  ): GitHubExecutionOutcome {
    const details = {
      branchName: prepared.branchName,
      prNumber: pr.number,
      prUrl: pr.url,
      summary: prepared.patch.summary
    };

    if (pr.state === "merged") {
      return { kind: "already-completed", ...details };
    }
    if (pr.state !== "open") {
      return {
        kind: "manual-review",
        ...details,
        message: pr.state === "closed"
          ? "A closed, unmerged pull request already exists for this remediation. Manual review is required."
          : `An existing pull request has unsupported state '${pr.state}'. Manual review is required.`
      };
    }
    return this.pullRequestOutcome(pr, prepared, disposition);
  }
}
