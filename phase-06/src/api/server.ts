import http from "node:http";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { classifyJwtVerificationFailure, isDevelopmentEnvironment, logDevelopmentIssuerMismatch, verifyJwtToken, JwtVerifierConfig, AuthenticatedIdentity } from "../auth/jwt-verifier.js";
import { hasPermission, Permission } from "../rbac/guard.js";
import { ProjectRepository, InvalidCursorError } from "../db/project-repo.js";
import { ScanRepository } from "../db/scan-repo.js";
import { FindingRepository } from "../db/finding-repo.js";
import { AuditRepository } from "../db/audit-repo.js";
import { checkDatabaseConnection } from "../db/client.js";
import { BoundedScanRunner, ActiveScanConflictError, ScanQueueFullError } from "../jobs/scan-runner.js";
import { validateProjectCreatePayload, sanitizeErrorDetails } from "./validation.js";
import type { ExpectedObservabilityModel } from "../../../phase-01/demo-service/src/expected-observability.js";

function parseLimitParam(param: string | null): number | undefined {
  if (!param) return undefined;
  const parsed = Number.parseInt(param, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export interface ServerConfig {
  port?: number;
  host?: string;
  prisma: PrismaClient;
  jwtConfig: JwtVerifierConfig;
  scanRunner?: BoundedScanRunner;
  fetchImpl?: typeof fetch;
  routeExtensions?: AuthenticatedRouteExtension[];
}

/** A route extension runs only after the server's standard JWT authentication. */
export interface AuthenticatedRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  url: URL;
  identity: AuthenticatedIdentity;
  parseJsonBody(): Promise<unknown>;
  sendJson(statusCode: number, data: unknown): void;
}

export interface AuthenticatedRouteExtension {
  handle(context: AuthenticatedRouteContext): Promise<boolean>;
  initialize?(): Promise<void>;
  shutdown?(): Promise<void>;
}

export class CloudPilotApiServer {
  private server: http.Server | null = null;
  private startPromise: Promise<number> | null = null;
  private stopPromise: Promise<void> | null = null;
  private lifecycleStopped = false;
  private lifecycleReady = false;
  private readonly prisma: PrismaClient;
  private readonly jwtConfig: JwtVerifierConfig;
  private readonly projectRepo: ProjectRepository;
  private readonly scanRepo: ScanRepository;
  private readonly findingRepo: FindingRepository;
  private readonly auditRepo: AuditRepository;
  private readonly scanRunner: BoundedScanRunner;
  private readonly routeExtensions: AuthenticatedRouteExtension[];

  constructor(private readonly config: ServerConfig) {
    this.prisma = config.prisma;
    this.jwtConfig = config.jwtConfig;
    this.projectRepo = new ProjectRepository(this.prisma);
    this.scanRepo = new ScanRepository(this.prisma);
    this.findingRepo = new FindingRepository(this.prisma);
    this.auditRepo = new AuditRepository(this.prisma);
    this.scanRunner = config.scanRunner ?? new BoundedScanRunner(this.prisma, { fetchImpl: config.fetchImpl });
    this.routeExtensions = config.routeExtensions ?? [];
  }

  start(port = this.config.port ?? 0, host = this.config.host ?? "127.0.0.1"): Promise<number> {
    if (this.startPromise) return this.startPromise;
    if (this.lifecycleStopped) return Promise.reject(new Error("API server has already been stopped."));
    this.startPromise = this.startInternal(port, host);
    return this.startPromise;
  }

  private async startInternal(port: number, host: string): Promise<number> {
    try {
      await this.scanRunner.initialize();
      for (const extension of this.routeExtensions) {
        await extension.initialize?.();
      }

      return await new Promise<number>((resolve, reject) => {
        this.server = http.createServer((req, res) => {
          this.handleRequest(req, res).catch((err) => {
            const statusCode =
              err && typeof err === "object" && "statusCode" in err && typeof (err as { statusCode: unknown }).statusCode === "number"
                ? (err as { statusCode: number }).statusCode
                : 500;
            this.sendJson(res, statusCode, { error: sanitizeErrorDetails(err) });
          });
        });

        this.server.once("error", reject);
        this.server.listen(port, host, () => {
          this.server?.removeAllListeners("error");
          this.lifecycleReady = true;
          const addr = this.server?.address();
          if (typeof addr === "object" && addr !== null) resolve(addr.port);
          else resolve(port);
        });
      });
    } catch (error) {
      this.lifecycleReady = false;
      try {
        if (this.server?.listening) await this.closeHttpServer();
        else this.server = null;
      } catch {
        this.server = null;
      }
      try {
        await this.cleanupRuntime();
      } catch {
        // Preserve the startup error; all cleanup steps are attempted independently.
      }
      this.lifecycleStopped = true;
      this.stopPromise = Promise.resolve();
      throw error;
    }
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.lifecycleReady = false;
    this.lifecycleStopped = true;
    this.stopPromise = this.stopRuntime();
    return this.stopPromise;
  }

  private async stopRuntime(): Promise<void> {
    let firstError: unknown;
    try {
      await this.closeHttpServer();
    } catch (error) {
      firstError = error;
    }
    try {
      await this.cleanupRuntime();
    } catch (error) {
      firstError ??= error;
    }
    if (firstError) throw firstError;
  }

  private async closeHttpServer(): Promise<void> {
    const server = this.server;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    this.server = null;
  }

  private async cleanupRuntime(): Promise<void> {
    let firstError: unknown;
    for (const extension of [...this.routeExtensions].reverse()) {
      try {
        await extension.shutdown?.();
      } catch (error) {
        firstError ??= error;
      }
    }
    try {
      await this.scanRunner.shutdown();
    } catch (error) {
      firstError ??= error;
    }
    if (firstError) throw firstError;
  }

  private sendJson(res: http.ServerResponse, statusCode: number, data: unknown): void {
    res.statusCode = statusCode;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(data));
  }

  private async parseJsonBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      const MAX_BODY_BYTES = 512 * 1024; // 512KB

      req.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_BODY_BYTES) {
          reject(new Error("Request body too large."));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });

      req.on("end", () => {
        if (chunks.length === 0) {
          resolve({});
          return;
        }
        try {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error("Invalid JSON in request body."));
        }
      });

      req.on("error", reject);
    });
  }

  private async authenticate(req: http.IncomingMessage, requestId: string): Promise<AuthenticatedIdentity | null> {
    const authHeader = req.headers["authorization"];
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      console.warn(JSON.stringify({ category: "malformed_token", requestId }));
      return null;
    }

    const token = authHeader.slice("Bearer ".length).trim();
    const result = await verifyJwtToken(token, this.jwtConfig);
    if (!result.valid || !result.securityContext) {
      const category = classifyJwtVerificationFailure(result) ?? "other_verification_failure";
      if (isDevelopmentEnvironment() && category === "issuer_mismatch") {
        logDevelopmentIssuerMismatch(token, this.jwtConfig.expectedIssuer, requestId);
        return null;
      }
      console.warn(JSON.stringify({ category, requestId }));
      return null;
    }

    return result.securityContext.identity;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const parsedUrl = new URL(req.url ?? "/", "http://localhost");
    const pathname = parsedUrl.pathname;

    // 1. Health Endpoints (No Auth Required)
    if (method === "GET" && pathname === "/health/liveness") {
      this.sendJson(res, 200, { status: "ok" });
      return;
    }

    if (method === "GET" && pathname === "/health/readiness") {
      if (!this.lifecycleReady || this.lifecycleStopped) {
        this.sendJson(res, 503, { status: "unready" });
        return;
      }
      const dbHealth = await checkDatabaseConnection(this.prisma);
      if (dbHealth.ok && this.lifecycleReady && !this.lifecycleStopped) {
        this.sendJson(res, 200, { status: "ready" });
      } else {
        this.sendJson(res, 503, { status: "unready" });
      }
      return;
    }

    // 2. Authentication for all /api/v1 routes
    if (!pathname.startsWith("/api/v1")) {
      this.sendJson(res, 404, { error: "Route not found." });
      return;
    }

    const requestId = randomUUID();
    res.setHeader("X-Request-ID", requestId);
    const identity = await this.authenticate(req, requestId);
    if (!identity) {
      this.sendJson(res, 401, { error: "Unauthorized: Missing, invalid, or expired authentication token." });
      return;
    }

    const tenantId = identity.tenantId;

    // Phase-specific handlers share the API server's authentication lifecycle.
    for (const extension of this.routeExtensions) {
      const handled = await extension.handle({
        req,
        res,
        method,
        pathname,
        url: parsedUrl,
        identity,
        parseJsonBody: () => this.parseJsonBody(req),
        sendJson: (statusCode, data) => this.sendJson(res, statusCode, data)
      });
      if (handled) return;
    }

    // 3. Route Dispatch
    // ─── GET /api/v1/projects ───
    if (method === "GET" && pathname === "/api/v1/projects") {
      if (!hasPermission(identity, "project:read")) {
        this.sendJson(res, 403, { error: "Forbidden: insufficient permissions." });
        return;
      }

      const limit = parseLimitParam(parsedUrl.searchParams.get("limit"));
      const cursor = parsedUrl.searchParams.get("cursor") ?? undefined;
      const result = await this.projectRepo.list(tenantId, { limit, cursor });
      this.sendJson(res, 200, result);
      return;
    }

    // ─── POST /api/v1/projects ───
    if (method === "POST" && pathname === "/api/v1/projects") {
      if (!hasPermission(identity, "project:create")) {
        this.sendJson(res, 403, { error: "Forbidden: insufficient permissions." });
        return;
      }

      let body: unknown;
      try {
        body = await this.parseJsonBody(req);
      } catch (bodyErr) {
        this.sendJson(res, 400, { error: (bodyErr as Error).message });
        return;
      }

      const val = validateProjectCreatePayload(body);
      if (!val.valid || !val.data) {
        this.sendJson(res, 400, { error: val.error });
        return;
      }

      // Check name uniqueness per tenant
      const existing = await this.projectRepo.findByName(tenantId, val.data.name);
      if (existing) {
        this.sendJson(res, 409, { error: `Project named '${val.data.name}' already exists in tenant.` });
        return;
      }

      const project = await this.projectRepo.create(tenantId, val.data);
      await this.auditRepo.record({
        tenantId,
        actorId: identity.userId,
        action: "PROJECT_CREATED",
        resourceType: "project",
        resourceId: project.id,
        projectId: project.id,
        metadata: { name: project.name }
      });

      this.sendJson(res, 201, { project });
      return;
    }

    // ─── Audit Events: GET /api/v1/audit-events ───
    if (method === "GET" && pathname === "/api/v1/audit-events") {
      if (!hasPermission(identity, "audit:read")) {
        this.sendJson(res, 403, { error: "Forbidden: insufficient permissions." });
        return;
      }

      const limit = parseLimitParam(parsedUrl.searchParams.get("limit"));
      const cursor = parsedUrl.searchParams.get("cursor") ?? undefined;
      const result = await this.auditRepo.list(tenantId, { limit, cursor });
      this.sendJson(res, 200, result);
      return;
    }

    // Dynamic routes under /api/v1/projects/:projectId
    const projectRouteMatch = pathname.match(/^\/api\/v1\/projects\/([^/]+)(.*)$/);
    if (!projectRouteMatch) {
      this.sendJson(res, 404, { error: "Route not found." });
      return;
    }

    const projectId = projectRouteMatch[1];
    const subPath = projectRouteMatch[2]; // e.g. "", "/scans", "/scans/123", "/scans/123/findings"

    // Verify tenant ownership of the project
    const project = await this.projectRepo.findById(tenantId, projectId);
    if (!project) {
      // Return 404 for cross-tenant isolation and non-existent records
      this.sendJson(res, 404, { error: "Project not found." });
      return;
    }

    // ─── GET /api/v1/projects/:id ───
    if (method === "GET" && subPath === "") {
      if (!hasPermission(identity, "project:read")) {
        this.sendJson(res, 403, { error: "Forbidden: insufficient permissions." });
        return;
      }
      this.sendJson(res, 200, { project });
      return;
    }

    // ─── DELETE /api/v1/projects/:id ───
    if (method === "DELETE" && subPath === "") {
      if (!hasPermission(identity, "project:delete")) {
        this.sendJson(res, 403, { error: "Forbidden: insufficient permissions." });
        return;
      }
      await this.projectRepo.delete(tenantId, projectId);
      await this.auditRepo.record({
        tenantId,
        actorId: identity.userId,
        action: "PROJECT_DELETED",
        resourceType: "project",
        resourceId: projectId,
        projectId
      });
      this.sendJson(res, 200, { success: true });
      return;
    }

    // ─── POST /api/v1/projects/:id/scans ───
    if (method === "POST" && subPath === "/scans") {
      if (!hasPermission(identity, "scan:create")) {
        this.sendJson(res, 403, { error: "Forbidden: insufficient permissions." });
        return;
      }

      // Check active scan conflict
      const active = await this.scanRepo.findActiveScanForProject(tenantId, projectId);
      if (active) {
        this.sendJson(res, 409, { error: `An active scan (${active.id}) is already pending or running for this project.` });
        return;
      }

      let body: Record<string, unknown> = {};
      try {
        body = (await this.parseJsonBody(req)) as Record<string, unknown>;
      } catch {
        // empty body is allowed
      }

      let scan: import("@prisma/client").Scan;
      try {
        scan = await this.scanRepo.create({
          tenantId,
          projectId,
          triggeredById: identity.userId,
          modelOverride: body.modelOverride
        });
      } catch (createErr) {
        if (createErr instanceof ActiveScanConflictError) {
          this.sendJson(res, 409, { error: createErr.message });
          return;
        }
        throw createErr;
      }

      await this.auditRepo.record({
        tenantId,
        actorId: identity.userId,
        action: "SCAN_TRIGGERED",
        resourceType: "scan",
        resourceId: scan.id,
        projectId
      });

      try {
        await this.scanRunner.enqueue({
          tenantId,
          projectId,
          scanId: scan.id,
          actorId: identity.userId,
          modelOverride: body.modelOverride as ExpectedObservabilityModel | undefined
        });
      } catch (enqueueErr) {
        // Rollback / mark scan as failed in DB so it doesn't permanently block subsequent scans
        await this.scanRepo.updateStatus(tenantId, scan.id, {
          status: "failed",
          error: enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr),
          completedAt: new Date()
        });

        if (enqueueErr instanceof ActiveScanConflictError) {
          this.sendJson(res, 409, { error: enqueueErr.message });
          return;
        }
        if (enqueueErr instanceof ScanQueueFullError) {
          this.sendJson(res, 429, { error: enqueueErr.message });
          return;
        }
        throw enqueueErr;
      }

      this.sendJson(res, 202, {
        scanId: scan.id,
        status: scan.status,
        projectId: scan.projectId,
        createdAt: scan.createdAt
      });
      return;
    }

    // ─── GET /api/v1/projects/:id/scans ───
    if (method === "GET" && subPath === "/scans") {
      if (!hasPermission(identity, "scan:read")) {
        this.sendJson(res, 403, { error: "Forbidden: insufficient permissions." });
        return;
      }

      const limit = parseLimitParam(parsedUrl.searchParams.get("limit"));
      const cursor = parsedUrl.searchParams.get("cursor") ?? undefined;
      const result = await this.scanRepo.listByProject(tenantId, projectId, { limit, cursor });
      this.sendJson(res, 200, result);
      return;
    }

    // Subpaths under /api/v1/projects/:id/scans/:scanId
    const scanMatch = subPath.match(/^\/scans\/([^/]+)(.*)$/);
    if (!scanMatch) {
      this.sendJson(res, 404, { error: "Route not found." });
      return;
    }

    const scanId = scanMatch[1];
    const scanSubPath = scanMatch[2]; // e.g. "", "/findings"

    const scan = await this.scanRepo.findById(tenantId, scanId);
    if (!scan || scan.projectId !== projectId) {
      this.sendJson(res, 404, { error: "Scan not found." });
      return;
    }

    // ─── GET /api/v1/projects/:id/scans/:scanId ───
    if (method === "GET" && scanSubPath === "") {
      if (!hasPermission(identity, "scan:read")) {
        this.sendJson(res, 403, { error: "Forbidden: insufficient permissions." });
        return;
      }
      this.sendJson(res, 200, { scan });
      return;
    }

    // ─── GET /api/v1/projects/:id/scans/:scanId/findings ───
    if (method === "GET" && scanSubPath === "/findings") {
      if (!hasPermission(identity, "finding:read")) {
        this.sendJson(res, 403, { error: "Forbidden: insufficient permissions." });
        return;
      }

      const limit = parseLimitParam(parsedUrl.searchParams.get("limit"));
      const cursor = parsedUrl.searchParams.get("cursor") ?? undefined;
      const result = await this.findingRepo.listByScan(tenantId, scanId, { limit, cursor });
      this.sendJson(res, 200, result);
      return;
    }

    this.sendJson(res, 404, { error: "Route not found." });
  }
}
