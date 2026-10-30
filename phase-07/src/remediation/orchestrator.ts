/**
 * RemediationOrchestrator — coordinates the full branch/PR remediation workflow.
 *
 * Lifecycle for each gap finding:
 *   1. Check idempotency: if a remediation already exists and is 'open'/'merged',
 *      return it without creating a duplicate.
 *   2. Plan the minimal patch (deterministic planner with structural YAML AST).
 *   3. Derive a cryptographic SHA-256 branch name from the idempotency key.
 *   4. Check whether the branch's PR is already open (idempotent PR check).
 *   5. Create the sandbox branch from the repo default branch.
 *   6. Read the target file from the default branch (or create placeholder).
 *   7. Apply the deterministic patch.
 *   8. Commit the patched file to the sandbox branch.
 *   9. Open a pull request (draft by default).
 *  10. Persist status, branch, PR number, PR URL, and record append-only audit events.
 *
 * Failure handling:
 *  - Non-retryable errors (401, 403, 404, invalid YAML) immediately transition to 'failed'.
 *  - Transient network/API errors decrement retriesLeft.
 *  - When retriesLeft reaches 0, status transitions to 'failed'.
 *  - Failed remediations remain failed on subsequent calls unless explicitly retriggered.
 *  - Stale/already-merged branches are handled gracefully.
 *  - All errors are recorded with secrets redacted.
 *
 * Concurrency:
 *  - Idempotency key uniqueness in PostgreSQL prevents duplicate rows.
 *  - `createOrFetch` returns the existing row if key already exists.
 */

import crypto from "node:crypto";
import { URL } from "node:url";
import { PrismaClient } from "@prisma/client";
import {
  GitHubConnector,
  GitHubConflictError,
  GitHubNotFoundError,
  GitHubApiError,
  GitHubInputError,
  redactSecrets
} from "../github/github-connector.js";
import {
  planRemediation,
  buildIdempotencyKey,
  isRemediationSupported,
  FindingSummary,
  MalformedYamlError,
  UnsupportedYamlStructureError
} from "../remediation/planner.js";
import { RemediationRepository, Remediation } from "../db/remediation-repo.js";
import { AuditRepository, RecordAuditInput } from "../db/audit-repo.js";

export interface RemediationConfig {
  /** GitHub repository owner (org or user). */
  owner: string;
  /** GitHub repository name (sandbox repo). */
  repo: string;
  /** Base branch to create PRs against. Default: "main". */
  baseBranch?: string;
  /** Whether to open PRs as drafts (default: true). */
  draft?: boolean;
  /** Branch name prefix. Default: "cloudpilot/remediate". */
  branchPrefix?: string;
}

export interface RemediationResult {
  remediationId: string;
  status: string;
  branchName?: string;
  prNumber?: number;
  prUrl?: string;
  summary?: string;
  skipped?: boolean;
  skipReason?: string;
}

export interface RemediateOptions {
  actorId?: string;
  retrigger?: boolean;
}

export interface RepoTarget {
  owner: string;
  repo: string;
}

/**
 * Builds a deterministic, collision-resistant branch name using SHA-256 digest of the idempotency key.
 */
export function buildBranchName(prefix: string, idempotencyKey: string): string {
  const hash = crypto.createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 16);
  return `${prefix}/${hash}`;
}

export function parseGitHubRepoUrl(urlStr: string): RepoTarget | null {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== "https:") return null;
    if (u.hostname !== "github.com") return null;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length !== 2) return null;
    const owner = parts[0];
    let repo = parts[1];
    if (repo.endsWith(".git")) repo = repo.slice(0, -4);
    if (!owner || !repo) return null;
    if (!/^[a-zA-Z0-9_-]+$/.test(owner) || !/^[a-zA-Z0-9_.-]+$/.test(repo)) return null;
    return { owner, repo };
  } catch {
    return null;
  }
}

function isNonRetryableError(err: unknown): boolean {
  if (err instanceof GitHubInputError) return true;
  if (err instanceof MalformedYamlError || err instanceof UnsupportedYamlStructureError) return true;
  if (err instanceof GitHubApiError) {
    if (err.statusCode === 401 || err.statusCode === 403 || err.statusCode === 404) {
      return true;
    }
  }
  return false;
}

function sanitizeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return redactSecrets(msg).slice(0, 512);
}

const PLACEHOLDER_CONTENT: Record<string, string> = {
  "config/observability/metrics.yaml": [
    "# CloudPilot Observability — Metrics Configuration",
    "# cloudpilot:metrics",
    "metrics: []",
    ""
  ].join("\n"),
  "config/observability/health-checks.yaml": [
    "# CloudPilot Observability — Health Checks",
    "# cloudpilot:health-checks",
    "health_checks: []",
    ""
  ].join("\n"),
  "config/observability/alert-rules.yaml": [
    "# CloudPilot Observability — Alert Rules",
    "# cloudpilot:alert-rules",
    "alerts: []",
    ""
  ].join("\n")
};

export class RemediationOrchestrator {
  private readonly remediationRepo: RemediationRepository;
  private readonly auditRepo: AuditRepository;
  private readonly baseBranch: string;
  private readonly branchPrefix: string;
  private readonly draft: boolean;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly github: GitHubConnector,
    private readonly config: RemediationConfig,
    auditRepo?: AuditRepository
  ) {
    this.remediationRepo = new RemediationRepository(prisma);
    this.auditRepo = auditRepo ?? new AuditRepository(prisma);
    this.baseBranch = config.baseBranch ?? "main";
    this.branchPrefix = config.branchPrefix ?? "cloudpilot/remediate";
    this.draft = config.draft ?? true;
  }

  private async resolveRepoTarget(tenantId: string, projectId: string): Promise<RepoTarget> {
    try {
      const proj = await (this.prisma as any).project?.findFirst?.({
        where: { id: projectId, tenantId },
        select: { repositoryUrl: true }
      });
      if (proj?.repositoryUrl) {
        const parsed = parseGitHubRepoUrl(proj.repositoryUrl);
        if (parsed) return parsed;
      }
    } catch {
      // Fallback to configured sandbox
    }
    return {
      owner: this.config.owner,
      repo: this.config.repo
    };
  }

  private async recordAuditSafe(input: RecordAuditInput): Promise<void> {
    try {
      if (typeof this.auditRepo?.record === "function") {
        await this.auditRepo.record(input);
      }
    } catch {
      // Silently handle audit recording errors so they do not crash or leak
    }
  }

  /**
   * Attempts to create a branch + PR for a single gap finding.
   * Returns immediately (idempotent) if a non-failed remediation already exists.
   */
  async remediateOne(
    tenantId: string,
    projectId: string,
    scanId: string,
    findingId: string,
    finding: FindingSummary,
    options?: RemediateOptions
  ): Promise<RemediationResult> {
    // Skip non-gap or unsupported findings
    if (!isRemediationSupported(finding.signal, finding.outcome)) {
      return {
        remediationId: "",
        status: "skipped",
        skipped: true,
        skipReason: `Signal '${finding.signal}' with outcome '${finding.outcome}' is not supported for remediation.`
      };
    }

    const idempotencyKey = buildIdempotencyKey(tenantId, findingId, finding.ruleId, finding.ruleVersion);

    // Idempotency: check existing record
    const existing = await this.remediationRepo.findByIdempotencyKey(idempotencyKey);
    if (existing && (existing.status === "open" || existing.status === "merged")) {
      return {
        remediationId: existing.id,
        status: existing.status,
        branchName: existing.branchName ?? undefined,
        prNumber: existing.prNumber ?? undefined,
        prUrl: existing.prUrl ?? undefined,
        summary: existing.patchSummary ?? undefined,
        skipped: true,
        skipReason: `Remediation already ${existing.status} (PR #${existing.prNumber}).`
      };
    }

    // If previously failed and not explicitly retriggered, stay failed
    if (existing && existing.status === "failed" && !options?.retrigger) {
      return {
        remediationId: existing.id,
        status: "failed",
        branchName: existing.branchName ?? undefined,
        summary: existing.patchSummary ?? undefined,
        skipped: true,
        skipReason: "Remediation previously exhausted retries and failed. Explicit retrigger required."
      };
    }

    // Plan the patch
    const patch = planRemediation(finding);
    const branchName = buildBranchName(this.branchPrefix, idempotencyKey);
    const targetRepo = await this.resolveRepoTarget(tenantId, projectId);

    // Create or fetch the DB record
    const record = await this.remediationRepo.createOrFetch({
      tenantId,
      projectId,
      scanId,
      findingId,
      idempotencyKey,
      patchSummary: patch.summary
    });

    await this.recordAuditSafe({
      tenantId,
      actorId: options?.actorId ?? "system",
      action: "REMEDIATION_TRIGGERED",
      resourceType: "remediation",
      resourceId: record.id,
      projectId,
      metadata: {
        scanId,
        findingId,
        ruleId: finding.ruleId,
        signal: finding.signal,
        branchName
      }
    });

    try {
      // 1. Check if PR already exists for this branch (idempotent PR check)
      const existingPr = await this.github.findOpenPullRequest(
        targetRepo.owner,
        targetRepo.repo,
        branchName,
        this.baseBranch
      );

      if (existingPr) {
        // PR already open — update DB record, audit, and return
        await this.remediationRepo.update(tenantId, record.id, {
          status: "open",
          branchName,
          prNumber: existingPr.number,
          prUrl: existingPr.url,
          errorMessage: null
        });

        await this.recordAuditSafe({
          tenantId,
          actorId: options?.actorId ?? "system",
          action: "REMEDIATION_PR_OPENED",
          resourceType: "remediation",
          resourceId: record.id,
          projectId,
          metadata: {
            scanId,
            findingId,
            branchName,
            prNumber: existingPr.number,
            prUrl: existingPr.url
          }
        });

        return {
          remediationId: record.id,
          status: "open",
          branchName,
          prNumber: existingPr.number,
          prUrl: existingPr.url,
          summary: patch.summary
        };
      }

      // 2. Get base branch SHA
      const baseBranchInfo = await this.github.getBranchSha(
        targetRepo.owner,
        targetRepo.repo,
        this.baseBranch
      );

      // 3. Create sandbox branch (ignore conflict if already exists)
      try {
        await this.github.createBranch(
          targetRepo.owner,
          targetRepo.repo,
          branchName,
          baseBranchInfo.sha
        );
      } catch (err) {
        if (!(err instanceof GitHubConflictError)) throw err;
      }

      // 4. Read current file content (or use placeholder if file doesn't exist yet)
      let currentContent: string;
      let currentSha: string;

      try {
        const fileInfo = await this.github.getFileContent(
          targetRepo.owner,
          targetRepo.repo,
          patch.filePath,
          branchName
        );
        currentContent = fileInfo.content;
        currentSha = fileInfo.sha;
      } catch (err) {
        if (err instanceof GitHubNotFoundError) {
          currentContent = PLACEHOLDER_CONTENT[patch.filePath] ?? "# CloudPilot Observability\n";
          currentSha = "";
        } else {
          throw err;
        }
      }

      // 5. Apply deterministic patch
      const patchedContent = patch.applyPatch(currentContent);

      // 6. Commit file to sandbox branch
      await this.github.updateFile({
        owner: targetRepo.owner,
        repo: targetRepo.repo,
        path: patch.filePath,
        message: patch.commitMessage,
        content: patchedContent,
        sha: currentSha,
        branch: branchName
      });

      // 7. Open pull request
      const pr = await this.github.createPullRequest({
        owner: targetRepo.owner,
        repo: targetRepo.repo,
        title: patch.prTitle,
        body: patch.prBody,
        head: branchName,
        base: this.baseBranch,
        draft: this.draft
      });

      // 8. Persist success
      await this.remediationRepo.update(tenantId, record.id, {
        status: "open",
        branchName,
        prNumber: pr.number,
        prUrl: pr.url,
        errorMessage: null
      });

      await this.recordAuditSafe({
        tenantId,
        actorId: options?.actorId ?? "system",
        action: "REMEDIATION_PR_OPENED",
        resourceType: "remediation",
        resourceId: record.id,
        projectId,
        metadata: {
          scanId,
          findingId,
          branchName,
          prNumber: pr.number,
          prUrl: pr.url
        }
      });

      return {
        remediationId: record.id,
        status: "open",
        branchName,
        prNumber: pr.number,
        prUrl: pr.url,
        summary: patch.summary
      };
    } catch (err) {
      const errorMessage = sanitizeError(err);
      const nonRetryable = isNonRetryableError(err);
      const currentRetries = options?.retrigger ? 3 : (record.retriesLeft ?? 3);
      const newRetriesLeft = nonRetryable ? 0 : Math.max(0, currentRetries - 1);
      const newStatus = newRetriesLeft === 0 ? "failed" : "pending";

      await this.remediationRepo.update(tenantId, record.id, {
        status: newStatus,
        errorMessage,
        retriesLeft: newRetriesLeft
      });

      if (newStatus === "failed") {
        await this.recordAuditSafe({
          tenantId,
          actorId: options?.actorId ?? "system",
          action: "REMEDIATION_FAILED",
          resourceType: "remediation",
          resourceId: record.id,
          projectId,
          metadata: {
            scanId,
            findingId,
            errorMessage,
            retriesLeft: newRetriesLeft
          }
        });
      }

      return {
        remediationId: record.id,
        status: newStatus,
        summary: patch.summary
      };
    }
  }

  /**
   * Bulk remediation: processes all gap findings from a completed scan.
   * Returns results per finding. Unsupported signals are skipped (not failed).
   */
  async remediateScan(
    tenantId: string,
    projectId: string,
    scanId: string,
    findings: Array<{ id: string; summary: FindingSummary }>,
    options?: RemediateOptions
  ): Promise<RemediationResult[]> {
    const results: RemediationResult[] = [];
    for (const { id: findingId, summary } of findings) {
      const result = await this.remediateOne(tenantId, projectId, scanId, findingId, summary, options);
      results.push(result);
    }
    return results;
  }
}
