import { Prisma, PrismaClient } from "@prisma/client";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ArchitectureDiscoveryResult } from "../../../phase-01/demo-service/src/architecture-discovery.js";
import { discoverArchitecture } from "../../../phase-01/demo-service/src/architecture-discovery.js";
import type { ExpectedObservabilityModel, ExpectedRequirement } from "../../../phase-01/demo-service/src/expected-observability.js";
import { analyzeNodeExpressSource, expectedModelDigest, type SourceObservabilityAnalysis, type SourceSnapshotFile } from "../../../phase-01/demo-service/src/source-observability-analysis.js";
import type { AuthenticatedRouteContext, AuthenticatedRouteExtension } from "../../../phase-06/src/api/server.js";
import { hasPermission } from "../../../phase-06/src/rbac/guard.js";
import { validateProjectTargetConfig } from "../../../phase-06/src/api/validation.js";

export interface UploadedManifest {
  path: string;
  content: string;
}

export interface ArchitectureDiscoveryService {
  discover(files: UploadedManifest[]): Promise<ArchitectureDiscoveryResult>;
}

export interface ArchitectureProjectStore {
  exists(tenantId: string, projectId: string): Promise<boolean>;
  saveExpectedModel(tenantId: string, projectId: string, actorId: string, model: ExpectedObservabilityModel): Promise<boolean>;
  mergeExpectedModel(tenantId: string, projectId: string, actorId: string, expectedCurrent: unknown, model: ExpectedObservabilityModel): Promise<boolean>;
  saveTargetConfig(tenantId: string, projectId: string, actorId: string, targetConfig: unknown): Promise<boolean>;
  saveSourceAnalysis(tenantId: string, projectId: string, actorId: string, expectedCurrent: unknown, model: ExpectedObservabilityModel, analysis: SourceObservabilityAnalysis): Promise<boolean>;
}

export interface SourceObservabilityDiscoveryService {
  analyze(files: SourceSnapshotFile[]): SourceObservabilityAnalysis;
}

const MAX_UPLOAD_FILES = 50;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024;
const EXPECTED_MODEL_VERSION = "cloudpilot.expected-observability.v1";
const SUPPORTED_SIGNALS = new Set(["metric", "log", "trace", "health", "alert"]);

function sourcePath(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 512 || value.includes("\\") || value.includes(":") || value.startsWith("/")) return false;
  const segments = value.split("/");
  return !segments.some((segment) => !segment || segment === "." || segment === ".." || /[\u0000-\u001f]/.test(segment)) &&
    /\.(?:js|cjs|mjs|ts|json|yaml|yml)$/i.test(segments[segments.length - 1]) &&
    !/(^|\/)(\.env(?:\.|$)|node_modules|\.git)(\/|$)/i.test(value);
}

function mergeSourceModel(current: unknown, derived: ExpectedObservabilityModel): ExpectedObservabilityModel | null {
  if (current === null || current === undefined || (isObject(current) && Object.keys(current).length === 0)) return derived;
  if (!validExpectedModel(current) || current.serviceId !== derived.serviceId) return null;
  const byId = new Map(current.requirements.map((item) => [item.id, item]));
  for (const item of derived.requirements) {
    const previous = byId.get(item.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(item)) return null;
    byId.set(item.id, previous ?? item);
  }
  return { schemaVersion: EXPECTED_MODEL_VERSION, serviceId: derived.serviceId, requirements: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)) };
}

function invalidResult(message: string): ArchitectureDiscoveryResult {
  return {
    status: "invalid",
    model: { schemaVersion: "cloudpilot.architecture.v1", services: [], resources: [] },
    diagnostics: [{ code: "INVALID_INPUT", severity: "error", message }]
  };
}

function safeUploadPath(value: string): string | null {
  if (!value || value.length > 512 || value.includes("\\") || value.includes(":") || value.startsWith("/")) return null;
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || /[\u0000-\u001f]/.test(segment))) return null;
  return /\.ya?ml$/i.test(segments[segments.length - 1]) ? segments.join("/") : null;
}

export class LocalManifestArchitectureDiscovery implements ArchitectureDiscoveryService {
  async discover(files: UploadedManifest[]): Promise<ArchitectureDiscoveryResult> {
    if (!Array.isArray(files) || files.length === 0 || files.length > MAX_UPLOAD_FILES) {
      return invalidResult(`Select between 1 and ${MAX_UPLOAD_FILES} YAML manifest files.`);
    }
    let totalBytes = 0;
    const normalized: UploadedManifest[] = [];
    const seen = new Set<string>();
    for (const file of files) {
      if (!file || typeof file.path !== "string" || typeof file.content !== "string") {
        return invalidResult("Each uploaded manifest must include a relative path and text content.");
      }
      const relativePath = safeUploadPath(file.path);
      if (!relativePath) return invalidResult("Manifest paths must be relative .yaml/.yml paths without traversal segments.");
      if (seen.has(relativePath)) return invalidResult(`Duplicate manifest path: ${relativePath}.`);
      seen.add(relativePath);
      const bytes = Buffer.byteLength(file.content, "utf8");
      if (bytes > MAX_FILE_BYTES) return invalidResult(`Manifest ${relativePath} exceeds the ${MAX_FILE_BYTES}-byte upload limit.`);
      totalBytes += bytes;
      if (totalBytes > MAX_TOTAL_BYTES) return invalidResult(`Combined manifest content exceeds the ${MAX_TOTAL_BYTES}-byte upload limit.`);
      normalized.push({ path: relativePath, content: file.content });
    }

    let root: string | undefined;
    try {
      root = await mkdtemp(path.join(tmpdir(), "cloudpilot-architecture-"));
      for (const file of normalized) {
        const destination = path.join(root, ...file.path.split("/"));
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, file.content, { encoding: "utf8", flag: "wx" });
      }
      return await discoverArchitecture({
        repositoryRoot: root,
        includePaths: normalized.map((file) => file.path),
        maxFiles: MAX_UPLOAD_FILES,
        maxFileBytes: MAX_FILE_BYTES
      });
    } catch {
      return invalidResult("The uploaded manifests could not be safely inspected.");
    } finally {
      if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export class PrismaArchitectureProjectStore implements ArchitectureProjectStore {
  constructor(private readonly prisma: PrismaClient) {}

  async exists(tenantId: string, projectId: string): Promise<boolean> {
    return (await this.prisma.project.findFirst({ where: { id: projectId, tenantId }, select: { id: true } })) !== null;
  }

  async saveExpectedModel(tenantId: string, projectId: string, actorId: string, model: ExpectedObservabilityModel): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.project.updateMany({
        where: { id: projectId, tenantId },
        data: { expectedModel: model as unknown as Prisma.InputJsonValue }
      });
      if (updated.count !== 1) return false;
      await tx.auditEvent.create({
        data: {
          tenantId,
          actorId,
          action: "PROJECT_EXPECTED_MODEL_UPDATED",
          resourceType: "project",
          resourceId: projectId,
          projectId,
          metadataJson: { serviceId: model.serviceId, requirementCount: model.requirements.length }
        }
      });
      return true;
    });
  }

  async mergeExpectedModel(tenantId: string, projectId: string, actorId: string, expectedCurrent: unknown, model: ExpectedObservabilityModel): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const expectedJson = expectedCurrent === null ? null : JSON.stringify(expectedCurrent);
      const modelJson = JSON.stringify(model);
      const updated = await tx.$executeRaw`
        UPDATE projects SET expected_model = ${modelJson}::jsonb, updated_at = NOW()
        WHERE id = ${projectId} AND tenant_id = ${tenantId}
          AND expected_model IS NOT DISTINCT FROM ${expectedJson}::jsonb
      `;
      if (updated !== 1) return false;
      await tx.auditEvent.create({ data: {
        tenantId, actorId, action: "PROJECT_EXPECTED_MODEL_UPDATED", resourceType: "project",
        resourceId: projectId, projectId,
        metadataJson: { serviceId: model.serviceId, requirementCount: model.requirements.length, operation: "optimistic-merge" }
      } });
      return true;
    });
  }

  async saveTargetConfig(tenantId: string, projectId: string, actorId: string, targetConfig: unknown): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.$executeRaw`
        UPDATE projects
        SET target_config = ${JSON.stringify(targetConfig)}::jsonb ||
          CASE WHEN target_config ? 'sourceAnalysis' THEN jsonb_build_object('sourceAnalysis', target_config->'sourceAnalysis') ELSE '{}'::jsonb END,
            updated_at = NOW()
        WHERE id = ${projectId} AND tenant_id = ${tenantId}
      `;
      if (updated !== 1) return false;
      await tx.auditEvent.create({
        data: {
          tenantId, actorId, action: "PROJECT_TELEMETRY_TARGET_UPDATED", resourceType: "project",
          resourceId: projectId, projectId,
          metadataJson: {
            configuredTargets: Object.keys(targetConfig as Record<string, unknown>).sort(),
            metricRequirementIds: Object.keys(((targetConfig as Record<string, unknown>).metricConfigs ?? {}) as Record<string, unknown>).sort()
          }
        }
      });
      return true;
    });
  }

  async saveSourceAnalysis(tenantId: string, projectId: string, actorId: string, expectedCurrent: unknown, model: ExpectedObservabilityModel, analysis: SourceObservabilityAnalysis): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const expectedJson = expectedCurrent === null ? null : JSON.stringify(expectedCurrent);
      const sourceMetadata = {
        sourceDigest: analysis.sourceDigest,
        modelDigest: expectedModelDigest(model),
        serviceName: analysis.serviceName ?? null,
        inspectedPaths: [...new Set([...analysis.routes.map((route) => route.evidence.path), ...Object.values(analysis.evidenceByRequirement).flat().map((evidence) => evidence.path)])].sort(),
        metricConfigs: analysis.metricConfigs,
        evidenceByRequirement: analysis.evidenceByRequirement,
        findings: analysis.findings
      };
      const updated = await tx.$executeRaw`
        UPDATE projects
        SET expected_model = ${JSON.stringify(model)}::jsonb,
            target_config = COALESCE(target_config, '{}'::jsonb) || ${JSON.stringify({ sourceAnalysis: sourceMetadata })}::jsonb,
            updated_at = NOW()
        WHERE id = ${projectId} AND tenant_id = ${tenantId}
          AND expected_model IS NOT DISTINCT FROM ${expectedJson}::jsonb
      `;
      if (updated !== 1) return false;
      await tx.auditEvent.create({ data: {
        tenantId, actorId, action: "PROJECT_SOURCE_OBSERVABILITY_ANALYZED", resourceType: "project",
        resourceId: projectId, projectId,
        metadataJson: { sourceDigest: analysis.sourceDigest, serviceId: model.serviceId, requirementCount: model.requirements.length, findingCount: analysis.findings.length }
      } });
      return true;
    });
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validRequirement(value: unknown): value is ExpectedRequirement {
  if (!isObject(value) || typeof value.id !== "string" || !value.id.trim() ||
      typeof value.signal !== "string" || !SUPPORTED_SIGNALS.has(value.signal)) return false;
  const fields: Record<string, string[]> = {
    metric: ["id", "signal", "metricName", "dimensions"], log: ["id", "signal", "fields"],
    trace: ["id", "signal", "serviceName"], health: ["id", "signal", "kind", "endpoint"],
    alert: ["id", "signal", "associatedSignal", "condition", "severity"]
  };
  if (Object.keys(value).some((key) => !fields[value.signal as string]?.includes(key))) return false;
  switch (value.signal) {
    case "metric": return typeof value.metricName === "string" && Boolean(value.metricName.trim()) &&
      Array.isArray(value.dimensions) && value.dimensions.every((item) => typeof item === "string" && Boolean(item.trim()));
    case "log": return Array.isArray(value.fields) && value.fields.every((item) => typeof item === "string" && Boolean(item.trim()));
    case "trace": return typeof value.serviceName === "string" && Boolean(value.serviceName.trim());
    case "health": return value.kind === "http" && typeof value.endpoint === "string" && Boolean(value.endpoint.trim());
    case "alert": return ["metric", "log", "trace", "health"].includes(String(value.associatedSignal)) &&
      typeof value.condition === "string" && Boolean(value.condition.trim()) && ["warning", "critical"].includes(String(value.severity));
  }
  return false;
}

function validExpectedModel(value: unknown): value is ExpectedObservabilityModel {
  return isObject(value) && value.schemaVersion === EXPECTED_MODEL_VERSION &&
    Object.keys(value).every((key) => ["schemaVersion", "serviceId", "requirements"].includes(key)) &&
    typeof value.serviceId === "string" && Boolean(value.serviceId.trim()) &&
    Array.isArray(value.requirements) && value.requirements.length > 0 && value.requirements.every(validRequirement) &&
    new Set(value.requirements.map((item) => (item as { id: string }).id)).size === value.requirements.length;
}

function routeProjectId(pathname: string, suffix: string): string | null {
  const match = pathname.match(new RegExp(`^/api/v1/projects/([^/]+)/${suffix}$`));
  if (!match) return null;
  try {
    const id = decodeURIComponent(match[1]);
    return id.length > 0 && id.length <= 128 && !id.includes("/") ? id : null;
  } catch { return null; }
}

/** Authenticated, legacy-tenant-scoped discovery and explicit expected-model save routes. */
export class ArchitectureApiRoutes implements AuthenticatedRouteExtension {
  constructor(
    private readonly projects: ArchitectureProjectStore,
    private readonly discovery: ArchitectureDiscoveryService = new LocalManifestArchitectureDiscovery(),
    private readonly sourceDiscovery: SourceObservabilityDiscoveryService = { analyze: analyzeNodeExpressSource }
  ) {}

  async handle(context: AuthenticatedRouteContext): Promise<boolean> {
    const sourceAnalysisId = routeProjectId(context.pathname, "source-observability-analysis");
    const sourceAnalysisApplyId = routeProjectId(context.pathname, "source-observability-analysis/apply");
    const sourceRouteId = sourceAnalysisApplyId ?? sourceAnalysisId;
    if (sourceRouteId !== null && context.method === "POST") {
      if (!hasPermission(context.identity, "project:update")) { context.sendJson(403, { error: "Forbidden: insufficient permissions." }); return true; }
      if (!await this.projects.exists(context.identity.tenantId, sourceRouteId)) { context.sendJson(404, { error: "Project not found." }); return true; }
      let body: unknown;
      try { body = await context.parseJsonBody(); } catch { context.sendJson(400, { error: "Invalid or oversized source snapshot." }); return true; }
      if (!isObject(body) || !Array.isArray(body.files) || body.files.length < 1 || body.files.length > 120 ||
          body.files.some((file) => !isObject(file) || !sourcePath(file.path) || typeof file.content !== "string")) {
        context.sendJson(400, { error: "Source snapshot must contain 1 to 120 safe relative source/configuration files." }); return true;
      }
      const files = body.files as SourceSnapshotFile[];
      const totalBytes = files.reduce((sum, file) => sum + Buffer.byteLength(file.content, "utf8"), 0);
      if (files.some((file) => Buffer.byteLength(file.content, "utf8") > 256 * 1024) || totalBytes > 448 * 1024) {
        context.sendJson(413, { error: "Source snapshot exceeds per-file or total upload limits." }); return true;
      }
      const analysis = this.sourceDiscovery.analyze(files);
      if (sourceAnalysisApplyId === null) { context.sendJson(200, analysis); return true; }
      if (analysis.status === "invalid" || analysis.status === "unsupported" || analysis.expectedModel.requirements.length === 0 ||
          !(body.expectedCurrentModel === null || body.expectedCurrentModel === undefined || validExpectedModel(body.expectedCurrentModel))) {
        context.sendJson(400, { error: "A supported Express snapshot and a valid expectedCurrentModel baseline are required to apply source analysis.", diagnostics: analysis.diagnostics }); return true;
      }
      const merged = mergeSourceModel(body.expectedCurrentModel ?? null, analysis.expectedModel);
      if (!merged) { context.sendJson(409, { error: "Source requirements conflict with the current model or service. Review the existing model and retry." }); return true; }
      const saved = await this.projects.saveSourceAnalysis(context.identity.tenantId, sourceRouteId, context.identity.userId, body.expectedCurrentModel ?? null, merged, analysis);
      if (!saved) { context.sendJson(409, { error: "The expected model changed during source analysis. Reload the project and analyze again." }); return true; }
      context.sendJson(200, { ...analysis, expectedModel: merged, saved: true });
      return true;
    }
    const mergeId = routeProjectId(context.pathname, "expected-model/merge");
    if (mergeId !== null && context.method === "POST") {
      if (!hasPermission(context.identity, "project:update")) { context.sendJson(403, { error: "Forbidden: insufficient permissions." }); return true; }
      if (!await this.projects.exists(context.identity.tenantId, mergeId)) { context.sendJson(404, { error: "Project not found." }); return true; }
      let body: unknown;
      try { body = await context.parseJsonBody(); } catch { context.sendJson(400, { error: "Invalid JSON request body." }); return true; }
      if (!isObject(body) || !("expectedCurrentModel" in body) || !validExpectedModel(body.expectedModel)) {
        context.sendJson(400, { error: "A valid expectedCurrentModel and expectedModel are required." }); return true;
      }
      const saved = await this.projects.mergeExpectedModel(context.identity.tenantId, mergeId, context.identity.userId, body.expectedCurrentModel, body.expectedModel);
      if (!saved) { context.sendJson(409, { error: "The expected model changed since this draft was opened. Reload it and merge recommendations again." }); return true; }
      context.sendJson(200, { projectId: mergeId, saved: true, merged: true });
      return true;
    }
    const targetConfigId = routeProjectId(context.pathname, "target-config");
    if (targetConfigId !== null && context.method === "PUT") {
      if (!hasPermission(context.identity, "project:update")) {
        context.sendJson(403, { error: "Forbidden: insufficient permissions." }); return true;
      }
      if (!await this.projects.exists(context.identity.tenantId, targetConfigId)) {
        context.sendJson(404, { error: "Project not found." }); return true;
      }
      let body: unknown;
      try { body = await context.parseJsonBody(); }
      catch { context.sendJson(400, { error: "Invalid JSON request body." }); return true; }
      const targetConfig = isObject(body) ? body.targetConfig : undefined;
      const validation = validateProjectTargetConfig(targetConfig);
      if (!validation.valid || !validation.data) {
        context.sendJson(400, { error: validation.error ?? "Invalid telemetry target configuration." }); return true;
      }
      const saved = await this.projects.saveTargetConfig(context.identity.tenantId, targetConfigId, context.identity.userId, validation.data);
      if (!saved) { context.sendJson(404, { error: "Project not found." }); return true; }
      context.sendJson(200, { projectId: targetConfigId, saved: true });
      return true;
    }

    const discoveryId = routeProjectId(context.pathname, "architecture-discovery");
    if (discoveryId !== null && context.method === "POST") {
      if (!hasPermission(context.identity, "project:update")) {
        context.sendJson(403, { error: "Forbidden: insufficient permissions." }); return true;
      }
      if (!await this.projects.exists(context.identity.tenantId, discoveryId)) {
        context.sendJson(404, { error: "Project not found." }); return true;
      }
      let body: unknown;
      try { body = await context.parseJsonBody(); }
      catch { context.sendJson(400, { error: "Invalid or oversized manifest upload." }); return true; }
      if (!isObject(body) || !Array.isArray(body.files)) {
        context.sendJson(400, { error: "Request body must include a files array." }); return true;
      }
      context.sendJson(200, await this.discovery.discover(body.files as UploadedManifest[]));
      return true;
    }

    const modelId = routeProjectId(context.pathname, "expected-model");
    if (modelId !== null && context.method === "PUT") {
      if (!hasPermission(context.identity, "project:update")) {
        context.sendJson(403, { error: "Forbidden: insufficient permissions." }); return true;
      }
      if (!await this.projects.exists(context.identity.tenantId, modelId)) {
        context.sendJson(404, { error: "Project not found." }); return true;
      }
      let body: unknown;
      try { body = await context.parseJsonBody(); }
      catch { context.sendJson(400, { error: "Invalid JSON request body." }); return true; }
      const model = isObject(body) ? body.expectedModel : undefined;
      if (!validExpectedModel(model)) {
        context.sendJson(400, { error: "expectedModel must contain at least one valid, explicit observability requirement." }); return true;
      }
      const saved = await this.projects.saveExpectedModel(context.identity.tenantId, modelId, context.identity.userId, model);
      if (!saved) { context.sendJson(404, { error: "Project not found." }); return true; }
      context.sendJson(200, { projectId: modelId, saved: true });
      return true;
    }
    return false;
  }
}
