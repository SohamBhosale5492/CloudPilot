import { PrismaClient } from "@prisma/client";
import { isIP } from "node:net";
import { assertExecutionArtifactImmutabilityTrigger, type ExecutionArtifactTriggerCatalogRow } from "./db/execution-artifact-integrity.js";
import { CloudPilotApiServer } from "../../phase-06/src/api/server.js";
import type { AuthenticatedRouteExtension } from "../../phase-06/src/api/server.js";
import { JwtVerifierConfig } from "../../phase-06/src/auth/jwt-verifier.js";
import { BoundedScanRunner } from "../../phase-06/src/jobs/scan-runner.js";
import { GitHubConnector } from "../../phase-07/src/github/github-connector.js";
import { GitHubRemediationExecutor } from "../../phase-07/src/remediation/github-executor.js";
import { RemediationApiRoutes } from "./api/remediation-api.js";
import { RemediationApiRepository } from "./api/remediation-api-repo.js";
import { RemediationProposalApiRoutes } from "./api/remediation-proposal-api.js";
import { RemediationReconciliationApiRoutes } from "./api/remediation-reconciliation-api.js";
import { PrismaRemediationProposalRepository } from "./api/remediation-proposal-repo.js";
import { IdentityOrganizationApiRoutes } from "./api/identity-organization-api.js";
import { OrganizationAuthorizationApiRoutes } from "./api/organization-authorization-api.js";
import { ArchitectureApiRoutes, PrismaArchitectureProjectStore } from "./api/architecture-api.js";
import { PrismaIdentityResolver } from "./identity/identity-resolver.js";
import { PrismaOrganizationService } from "./organizations/organization-service.js";
import { PrismaOrganizationAuthorizationService } from "./organizations/authorization-service.js";
import { PrismaProjectAdoptionService } from "./organizations/project-adoption-service.js";
import { RemediationJobRepository } from "./jobs/remediation-repo.js";
import { RemediationRunner } from "./jobs/remediation-runner.js";
import { GitHubRepositoryApiRoutes, PrismaGitHubRepositoryStore } from "./api/github-repository-api.js";
import { GitHubConnectIntentApiRoutes } from "./api/github-connect-intent-api.js";
import { GitHubInstallationCallbackApiRoutes } from "./api/github-installation-callback-api.js";
import {
  DEFAULT_GITHUB_CONNECT_INTENT_TTL_SECONDS,
  GitHubConnectIntentService,
  isValidGitHubAppSlug,
  MAX_GITHUB_CONNECT_INTENT_TTL_SECONDS,
  MIN_GITHUB_CONNECT_INTENT_TTL_SECONDS,
  PrismaGitHubConnectIntentStore
} from "./github/connect-intent.js";
import { EnvironmentGitHubAppCredentialProvider, type GitHubAppCredentialProvider } from "./github/credential-provider.js";
import { GitHubAppTokenService } from "./github/app-token-service.js";
import { GitHubExecutionCapabilityService } from "./github/github-execution-capability.js";
import { ContentsReadInstallationTokenService } from "./github/contents-read-token-service.js";
import { GitHubTrustedRepositorySnapshotReader } from "./github/trusted-repository-snapshot-reader.js";
import { RemediationExecutionArtifactPreparationService } from "./remediation/execution-artifact-preparation.js";
import { TrustedClaimExecutionContextService } from "./remediation/trusted-claim-execution-context.js";
import { RemediationExecutionPersistenceService } from "./remediation/remediation-execution-persistence.js";
import { PrismaRemediationExecutionAuthorizationRepository, RemediationExecutionAuthorizationService } from "./remediation/execution-authorization.js";
import { ArtifactOnlyGitHubWriter } from "./remediation/artifact-only-github-writer.js";
import { ArtifactOnlyGitHubDraftPrPublisher } from "./remediation/artifact-only-github-draft-pr-publisher.js";
import { ArtifactOnlyExecutionOrchestrator } from "./remediation/artifact-only-execution-orchestrator.js";
import { ArtifactOnlyExecutionRecoveryService } from "./remediation/artifact-only-execution-recovery.js";
import { ArtifactOnlyRemediationWorker } from "./jobs/artifact-only-remediation-worker.js";
import { GitHubAppInstallationVerifier } from "./github/installation-verifier.js";
import { GitHubInstallationCallbackService, PrismaGitHubInstallationCallbackStore } from "./github/installation-callback.js";
import { GitHubInstallationRepositoryClient, MetadataInstallationTokenService, PrismaInstallationDiscoveryAuthorization } from "./github/repository-discovery.js";
import { GitHubInstallationRepositoriesApi } from "./api/github-installation-repositories-api.js";
import { ProjectGitHubBindingApi } from "./api/project-github-binding-api.js";
import { ProjectGitHubBindingService } from "./organizations/project-github-binding-service.js";
import {
  NoGitHubRepositoryBindingResolver,
  PrismaTrustedOrganizationGitHubAuthorizationService,
  type TrustedOrganizationGitHubAuthorizationService
} from "./github/organization-authorization-contract.js";

export interface HostEnvironment {
  DATABASE_URL?: string;
  GITHUB_TOKEN?: string;
  GITHUB_API_BASE_URL?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_WEBHOOK_SECRET?: string;
  CLOUDPILOT_GITHUB_CONNECT_INTENT_TTL_SECONDS?: string;
  CLOUDPILOT_ENABLE_REMEDIATION_WORKER?: string;
  CLOUDPILOT_IDENTITY_PROVISIONING_ENABLED?: string;
  CLOUDPILOT_ORGANIZATION_CREATION_ENABLED?: string;
  CLOUDPILOT_MAX_ORGANIZATIONS_PER_USER?: string;
  PORT?: string;
  HOST?: string;
  NODE_ENV?: string;
}

export interface HostDatabaseLifecycle {
  connect(): Promise<void>;
  verify(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface HostApiLifecycle {
  start(port: number, host?: string): Promise<number>;
  stop(): Promise<void>;
}

export class CloudPilotApplicationHost {
  private startTask: Promise<number> | null = null;
  private stopTask: Promise<void> | null = null;
  private cleanupTask: Promise<void> | null = null;

  constructor(
    private readonly database: HostDatabaseLifecycle,
    private readonly api: HostApiLifecycle,
    readonly port: number,
    readonly remediationWorkerEnabled: boolean,
    readonly bindAddress = "127.0.0.1",
    readonly githubAppCredentialProvider: GitHubAppCredentialProvider = new EnvironmentGitHubAppCredentialProvider(),
    readonly githubAppTokenService: GitHubAppTokenService = new GitHubAppTokenService(githubAppCredentialProvider),
    readonly githubOrganizationAuthorizationService: TrustedOrganizationGitHubAuthorizationService | null = null,
    readonly remediationArtifactPreparationService: RemediationExecutionArtifactPreparationService | null = null,
    readonly remediationExecutionAuthorizationService: RemediationExecutionAuthorizationService | null = null,
    readonly githubExecutionCapabilityService: GitHubExecutionCapabilityService | null = null,
    readonly trustedClaimExecutionContextService: TrustedClaimExecutionContextService | null = null,
    readonly remediationExecutionPersistenceService: RemediationExecutionPersistenceService | null = null,
    readonly artifactOnlyExecutionOrchestrator: ArtifactOnlyExecutionOrchestrator | null = null,
    readonly artifactOnlyExecutionRecoveryService: ArtifactOnlyExecutionRecoveryService | null = null,
    readonly artifactOnlyRemediationWorker: ArtifactOnlyRemediationWorker | null = null
  ) {}

  start(): Promise<number> {
    if (this.stopTask) return Promise.reject(new Error("CloudPilot host has already been stopped."));
    if (this.startTask) return this.startTask;
    this.startTask = this.startInternal();
    return this.startTask;
  }

  stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    this.stopTask = (async () => {
      if (this.startTask) {
        try { await this.startTask; } catch { /* startup already performed cleanup */ }
      }
      await this.cleanup();
    })();
    return this.stopTask;
  }

  private async startInternal(): Promise<number> {
    try {
      await this.database.connect();
      await this.database.verify();
      return await this.api.start(this.port, this.bindAddress);
    } catch (cause) {
      try {
        await this.cleanup();
      } catch (cleanupError) {
        throw new AggregateError([cause, cleanupError], "CloudPilot startup failed and cleanup was incomplete.");
      }
      throw new Error("CloudPilot host startup failed; verify database connectivity, schema, and runtime configuration.", { cause });
    }
  }

  private cleanup(): Promise<void> {
    if (this.cleanupTask) return this.cleanupTask;
    this.cleanupTask = (async () => {
      let firstError: unknown;
      try { await this.api.stop(); } catch (error) { firstError = error; }
      try { await this.database.disconnect(); } catch (error) { firstError ??= error; }
      if (firstError) throw firstError;
    })();
    return this.cleanupTask;
  }
}

function requiredDatabaseUrl(value: string | undefined): string {
  if (!value || value !== value.trim()) throw new Error("DATABASE_URL is required and must be a PostgreSQL URL.");
  try {
    const url = new URL(value);
    if (!(url.protocol === "postgres:" || url.protocol === "postgresql:") || !url.hostname || !url.pathname.slice(1)) {
      throw new Error();
    }
    return value;
  } catch {
    throw new Error("DATABASE_URL is required and must be a PostgreSQL URL.");
  }
}

function requiredPort(value: string | undefined): number {
  if (value === undefined || value === "") return 3000;
  if (!/^(?:0|[1-9]\d*)$/.test(value)) throw new Error("PORT must be an integer from 0 through 65535.");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port > 65535) throw new Error("PORT must be an integer from 0 through 65535.");
  return port;
}

function requiredBindAddress(value: string | undefined): string {
  const address = value ?? "127.0.0.1";
  if (isIP(address) === 0) throw new Error("HOST must be an IPv4 or IPv6 address.");
  return address;
}

function optionalBoolean(value: string | undefined, name: string, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be 'true' or 'false'.`);
}

function organizationLimit(value: string | undefined): number {
  if (value === undefined) return 5;
  if (!/^(?:[1-9]\d*)$/.test(value)) throw new Error("CLOUDPILOT_MAX_ORGANIZATIONS_PER_USER must be an integer from 1 through 100.");
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit > 100) {
    throw new Error("CLOUDPILOT_MAX_ORGANIZATIONS_PER_USER must be an integer from 1 through 100.");
  }
  return limit;
}

function githubAppSlug(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!isValidGitHubAppSlug(value)) throw new Error("GITHUB_APP_SLUG must be a lowercase GitHub App slug (letters, numbers, and internal hyphens only).");
  return value;
}

function githubConnectIntentLifetimeSeconds(value: string | undefined): number {
  if (value === undefined) return DEFAULT_GITHUB_CONNECT_INTENT_TTL_SECONDS;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`CLOUDPILOT_GITHUB_CONNECT_INTENT_TTL_SECONDS must be an integer from ${MIN_GITHUB_CONNECT_INTENT_TTL_SECONDS} through ${MAX_GITHUB_CONNECT_INTENT_TTL_SECONDS}.`);
  }
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < MIN_GITHUB_CONNECT_INTENT_TTL_SECONDS || seconds > MAX_GITHUB_CONNECT_INTENT_TTL_SECONDS) {
    throw new Error(`CLOUDPILOT_GITHUB_CONNECT_INTENT_TTL_SECONDS must be an integer from ${MIN_GITHUB_CONNECT_INTENT_TTL_SECONDS} through ${MAX_GITHUB_CONNECT_INTENT_TTL_SECONDS}.`);
  }
  return seconds;
}

function validateJwtConfig(config: JwtVerifierConfig): void {
  if (!config || typeof config.expectedIssuer !== "string" || !config.expectedIssuer.trim() ||
      typeof config.expectedAudience !== "string" || !config.expectedAudience.trim()) {
    throw new Error("A configured JWT issuer and audience are required.");
  }
  if ("publicKeyOrSecret" in config && typeof config.publicKeyOrSecret === "string" && !config.publicKeyOrSecret.trim()) {
    throw new Error("A JWT verification key is required.");
  }
}

/**
 * Composition example for the current infrastructure-only repository. No module
 * starts itself: callers must explicitly call host.start() and host.stop().
 */
export function createCloudPilotHostFromEnvironment(
  jwtConfig: JwtVerifierConfig,
  env: HostEnvironment = process.env as HostEnvironment
): CloudPilotApplicationHost {
  validateJwtConfig(jwtConfig);
  const databaseUrl = requiredDatabaseUrl(env.DATABASE_URL);
  const rawWorkerFlag = env.CLOUDPILOT_ENABLE_REMEDIATION_WORKER;
  if (rawWorkerFlag !== undefined && rawWorkerFlag !== "true" && rawWorkerFlag !== "false") {
    throw new Error("CLOUDPILOT_ENABLE_REMEDIATION_WORKER must be 'true' or 'false'.");
  }
  const workerEnabled = rawWorkerFlag === "true";
  if (workerEnabled) {
    throw new Error("CLOUDPILOT_ENABLE_REMEDIATION_WORKER cannot be enabled until approved-artifact execution is integrated.");
  }
  const allowIdentityProvisioning = optionalBoolean(
    env.CLOUDPILOT_IDENTITY_PROVISIONING_ENABLED,
    "CLOUDPILOT_IDENTITY_PROVISIONING_ENABLED",
    false
  );
  const organizationCreationEnabled = optionalBoolean(
    env.CLOUDPILOT_ORGANIZATION_CREATION_ENABLED,
    "CLOUDPILOT_ORGANIZATION_CREATION_ENABLED",
    env.NODE_ENV === "development"
  );
  const perUserOrganizationLimit = organizationLimit(env.CLOUDPILOT_MAX_ORGANIZATIONS_PER_USER);
  const configuredGitHubAppSlug = githubAppSlug(env.GITHUB_APP_SLUG);
  const connectIntentLifetimeSeconds = githubConnectIntentLifetimeSeconds(env.CLOUDPILOT_GITHUB_CONNECT_INTENT_TTL_SECONDS);
  const port = requiredPort(env.PORT);
  const bindAddress = requiredBindAddress(env.HOST);

  if (workerEnabled && (!env.GITHUB_TOKEN || !env.GITHUB_TOKEN.trim())) {
    throw new Error("GITHUB_TOKEN is required when the remediation worker is enabled.");
  }

  const connector = workerEnabled
    ? new GitHubConnector({
        token: env.GITHUB_TOKEN!,
        ...(env.GITHUB_API_BASE_URL ? { apiBaseUrl: env.GITHUB_API_BASE_URL } : {})
      })
    : null;

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const routeExtensions: AuthenticatedRouteExtension[] = [];
  const identityResolver = new PrismaIdentityResolver(prisma);
  const organizationAuthorization = new PrismaOrganizationAuthorizationService(prisma);
  const githubAppCredentialProvider = new EnvironmentGitHubAppCredentialProvider(env);
  const githubAppTokenService = new GitHubAppTokenService(githubAppCredentialProvider);
  routeExtensions.push(new IdentityOrganizationApiRoutes(
    identityResolver,
    new PrismaOrganizationService(prisma),
    {
      expectedIssuer: jwtConfig.expectedIssuer,
      allowFirstUseProvisioning: allowIdentityProvisioning,
      organizationCreationEnabled,
      perUserOrganizationLimit
    }
  ));
  routeExtensions.push(new OrganizationAuthorizationApiRoutes(
    identityResolver,
    organizationAuthorization,
    new PrismaProjectAdoptionService(prisma),
    { expectedIssuer: jwtConfig.expectedIssuer, allowFirstUseProvisioning: allowIdentityProvisioning }
  ));
  routeExtensions.push(new GitHubConnectIntentApiRoutes(
    identityResolver,
    organizationAuthorization,
    new GitHubConnectIntentService(new PrismaGitHubConnectIntentStore(prisma), {
      appSlug: configuredGitHubAppSlug,
      lifetimeSeconds: connectIntentLifetimeSeconds
    }),
    { expectedIssuer: jwtConfig.expectedIssuer, allowFirstUseProvisioning: allowIdentityProvisioning }
  ));
  const callbackService = new GitHubInstallationCallbackService(
    new PrismaGitHubInstallationCallbackStore(prisma, organizationAuthorization),
    organizationAuthorization,
    new GitHubAppInstallationVerifier(githubAppCredentialProvider)
  );
  routeExtensions.push(new GitHubInstallationCallbackApiRoutes(identityResolver, callbackService, {
    expectedIssuer: jwtConfig.expectedIssuer,
    allowFirstUseProvisioning: allowIdentityProvisioning
  }));
  const discoveryTokens = new MetadataInstallationTokenService(githubAppCredentialProvider);
  routeExtensions.push(new GitHubInstallationRepositoriesApi(
    identityResolver,
    new PrismaInstallationDiscoveryAuthorization(prisma),
    new GitHubInstallationRepositoryClient(discoveryTokens),
    { expectedIssuer: jwtConfig.expectedIssuer, allowFirstUseProvisioning: allowIdentityProvisioning }
  ));
  routeExtensions.push(new ProjectGitHubBindingApi(
    identityResolver,
    new ProjectGitHubBindingService(prisma,new GitHubInstallationRepositoryClient(discoveryTokens)),
    { expectedIssuer: jwtConfig.expectedIssuer, allowFirstUseProvisioning: allowIdentityProvisioning }
  ));
  routeExtensions.push(new ArchitectureApiRoutes(new PrismaArchitectureProjectStore(prisma)));
  // Repository metadata routes are available independently of worker execution.
  routeExtensions.push(new GitHubRepositoryApiRoutes(new PrismaGitHubRepositoryStore(prisma)));
  // Human proposal review is available with the worker disabled. This route
  // has no scheduler or GitHub dependency and approved records remain unclaimable
  // by the legacy worker until Stage B adds the authorized execution path.
  const trustedSnapshotReader = new GitHubTrustedRepositorySnapshotReader(
    prisma,
    new ContentsReadInstallationTokenService(githubAppCredentialProvider)
  );
  const proposalRepository = new PrismaRemediationProposalRepository(prisma, trustedSnapshotReader);
  const artifactPreparationService = new RemediationExecutionArtifactPreparationService(
    proposalRepository, identityResolver, jwtConfig.expectedIssuer
  );
  const executionAuthorizationService = new RemediationExecutionAuthorizationService(
    identityResolver, new PrismaRemediationExecutionAuthorizationRepository(prisma), trustedSnapshotReader,
    jwtConfig.expectedIssuer
  );
  const trustedClaimExecutionContextService = new TrustedClaimExecutionContextService(prisma);
  const githubExecutionCapabilityService = new GitHubExecutionCapabilityService(
    trustedClaimExecutionContextService,
    githubAppTokenService
  );
  const remediationExecutionPersistenceService = new RemediationExecutionPersistenceService(prisma);
  const artifactWriter = new ArtifactOnlyGitHubWriter(githubExecutionCapabilityService);
  const draftPrPublisher = new ArtifactOnlyGitHubDraftPrPublisher(githubExecutionCapabilityService);
  const artifactExecutionOrchestrator = new ArtifactOnlyExecutionOrchestrator(
    trustedClaimExecutionContextService,
    githubExecutionCapabilityService,
    artifactWriter,
    draftPrPublisher,
    remediationExecutionPersistenceService
  );
  const artifactExecutionRecoveryService = new ArtifactOnlyExecutionRecoveryService(
    remediationExecutionPersistenceService,
    trustedClaimExecutionContextService,
    githubExecutionCapabilityService,
    artifactWriter,
    draftPrPublisher
  );
  const artifactRemediationWorker = new ArtifactOnlyRemediationWorker(
    new RemediationJobRepository(prisma),
    artifactExecutionOrchestrator,
    { autoStart: false }
  );

  routeExtensions.push(new RemediationProposalApiRoutes(
    identityResolver,
    proposalRepository,
    { expectedIssuer: jwtConfig.expectedIssuer }
  ));
  routeExtensions.push(new RemediationReconciliationApiRoutes(
    identityResolver,
    remediationExecutionPersistenceService,
    prisma,
    { expectedIssuer: jwtConfig.expectedIssuer }
  ));
  if (connector) {
    const executor = new GitHubRemediationExecutor(connector, { draft: true });
    const worker = new RemediationRunner(new RemediationJobRepository(prisma), executor);
    routeExtensions.push(new RemediationApiRoutes(new RemediationApiRepository(prisma), worker));
  }

  const api = new CloudPilotApiServer({
    prisma,
    jwtConfig,
    scanRunner: new BoundedScanRunner(prisma, { autoStart: false }),
    routeExtensions
  });
  const database: HostDatabaseLifecycle = {
    connect: () => prisma.$connect(),
    verify: async () => {
      const requiredTables = [
        "tenants", "users", "projects", "scans", "findings", "audit_events",
        "identity_users", "external_identities", "organizations", "organization_members", "organization_audit_events",
        "github_connect_intents", "organization_github_installations", "remediations",
        "remediation_executions", "remediation_execution_events"
      ];
      for (const table of requiredTables) {
        const found = await prisma.$queryRaw<Array<{ table_name: string | null }>>`
          SELECT to_regclass(${`public.${table}`})::text AS table_name
        `;
        if (!found[0]?.table_name) throw new Error("Required CloudPilot database schema is missing.");
      }
      const approvalColumns = await prisma.$queryRaw<Array<{ column_name: string }>>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'remediations'
          AND column_name IN (
            'requested_by_identity_user_id', 'repository_binding_id', 'github_repository_id', 'plan_hash', 'plan_snapshot',
            'execution_artifact', 'execution_artifact_hash', 'approved_artifact_hash',
            'approval_state', 'approved_by_identity_user_id', 'approved_at', 'rejected_by_identity_user_id', 'rejected_at',
            'invalidated_by_identity_user_id', 'invalidated_at'
          )
      `;
      if (approvalColumns.length !== 15) throw new Error("Required remediation proposal schema is missing.");
      const artifactTrigger = await prisma.$queryRaw<ExecutionArtifactTriggerCatalogRow[]>`
        SELECT trg.tgname AS trigger_name, trg.tgenabled AS enabled, trg.tgtype AS trigger_type,
          trg.tgisinternal AS is_internal, tbl_ns.nspname AS table_schema, tbl.relname AS table_name,
          fn_ns.nspname AS function_schema, proc.proname AS function_name,
          lang.lanname AS function_language, proc.prosecdef AS security_definer,
          pg_get_expr(trg.tgqual, trg.tgrelid) AS trigger_when,
          (trg.tgconstraint <> 0) AS is_constraint_trigger,
          pg_get_triggerdef(trg.oid, true) AS trigger_definition,
          pg_get_functiondef(proc.oid) AS function_definition
        FROM pg_catalog.pg_trigger AS trg
        JOIN pg_catalog.pg_class AS tbl ON tbl.oid = trg.tgrelid
        JOIN pg_catalog.pg_namespace AS tbl_ns ON tbl_ns.oid = tbl.relnamespace
        LEFT JOIN pg_catalog.pg_proc AS proc ON proc.oid = trg.tgfoid
        LEFT JOIN pg_catalog.pg_namespace AS fn_ns ON fn_ns.oid = proc.pronamespace
        LEFT JOIN pg_catalog.pg_language AS lang ON lang.oid = proc.prolang
        WHERE trg.tgname = 'trg_remediations_execution_artifact_immutable'
      `;
      assertExecutionArtifactImmutabilityTrigger(artifactTrigger);
      if (workerEnabled) {
        const leaseColumns = await prisma.$queryRaw<Array<{ column_name: string }>>`
          SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'remediations'
            AND column_name IN ('worker_id', 'lease_token', 'claimed_at', 'heartbeat_at', 'lease_expires_at', 'next_attempt_at')
        `;
        if (leaseColumns.length !== 6) throw new Error("Required remediation worker lease schema is missing.");
      }
    },
    disconnect: () => prisma.$disconnect()
  };
  return new CloudPilotApplicationHost(
    database, api, port, workerEnabled, bindAddress, githubAppCredentialProvider, githubAppTokenService,
    new PrismaTrustedOrganizationGitHubAuthorizationService(prisma, new NoGitHubRepositoryBindingResolver()),
    artifactPreparationService,
    executionAuthorizationService,
    githubExecutionCapabilityService,
    trustedClaimExecutionContextService,
    remediationExecutionPersistenceService,
    artifactExecutionOrchestrator,
    artifactExecutionRecoveryService,
    artifactRemediationWorker
  );
}
