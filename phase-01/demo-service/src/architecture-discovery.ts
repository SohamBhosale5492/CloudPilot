import { lstat, readFile, readlink, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { parseAllDocuments } from "yaml";

export type DiscoveryStatus = "success" | "partial" | "unsupported" | "invalid";
export type DiscoveryDiagnosticSeverity = "info" | "warning" | "error";
export type DiscoveryDiagnosticCode =
  | "EMPTY_REPOSITORY"
  | "FILE_LIMIT_EXCEEDED"
  | "FILE_TOO_LARGE"
  | "INVALID_INPUT"
  | "MALFORMED_YAML"
  | "PATH_OUTSIDE_ROOT"
  | "UNSUPPORTED_CONSTRUCT"
  | "UNSUPPORTED_FORMAT"
  | "DUPLICATE_IDENTIFIER"
  | "PARTIAL_DISCOVERY";

export interface ArchitectureDiscoveryInput {
  repositoryRoot: string;
  includePaths?: string[];
  maxFiles?: number;
  maxFileBytes?: number;
}

export interface SourceProvenance {
  file: string;
  format: "docker-compose" | "kubernetes";
  documentIndex?: number;
}

export interface DiscoveredService {
  id: string;
  name: string;
  workloadType: "compose-service" | "kubernetes-workload";
  image?: string;
  buildContext?: string;
  ports: string[];
  dependencies: string[];
  source: SourceProvenance;
}

export interface DiscoveredResource {
  id: string;
  name: string;
  resourceType: "compose-volume" | "compose-network" | "kubernetes-resource";
  kind?: string;
  ports: string[];
  source: SourceProvenance;
}

export interface ArchitectureModel {
  schemaVersion: "cloudpilot.architecture.v1";
  services: DiscoveredService[];
  resources: DiscoveredResource[];
}

export interface DiscoveryDiagnostic {
  code: DiscoveryDiagnosticCode;
  severity: DiscoveryDiagnosticSeverity;
  message: string;
  file?: string;
}

export interface ArchitectureDiscoveryResult {
  status: DiscoveryStatus;
  model: ArchitectureModel;
  diagnostics: DiscoveryDiagnostic[];
}

interface CandidateFile {
  absolutePath: string;
  relativePath: string;
}

const DEFAULT_MAX_FILES = 50;
const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const IGNORED_DIRECTORIES = new Set([".git", "dist", "node_modules"]);
const COMPOSE_FILE_NAMES = new Set([
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml"
]);
const KUBERNETES_WORKLOAD_KINDS = new Set(["Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob"]);

export async function discoverArchitecture(input: ArchitectureDiscoveryInput): Promise<ArchitectureDiscoveryResult> {
  const root = path.resolve(input.repositoryRoot);
  const rootRealPath = await safeRealpath(root);
  const maxFiles = input.maxFiles ?? DEFAULT_MAX_FILES;
  const maxFileBytes = input.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const diagnostics: DiscoveryDiagnostic[] = [];
  const model: ArchitectureModel = {
    schemaVersion: "cloudpilot.architecture.v1",
    services: [],
    resources: []
  };

  if (!Number.isInteger(maxFiles) || maxFiles <= 0 || !Number.isInteger(maxFileBytes) || maxFileBytes <= 0) {
    return result("invalid", model, [{
      code: "INVALID_INPUT",
      severity: "error",
      message: "maxFiles and maxFileBytes must be positive integers."
    }]);
  }

  const rootStat = await safeStat(root);

  if (rootStat === undefined || !rootStat.isDirectory() || rootRealPath === undefined) {
    return result("invalid", model, [{
      code: "INVALID_INPUT",
      severity: "error",
      message: "repositoryRoot must be an existing directory."
    }]);
  }

  const candidates = input.includePaths === undefined
    ? await scanCandidates(root, maxFiles, diagnostics)
    : await resolveIncludedCandidates(root, input.includePaths, maxFiles, diagnostics);

  if (candidates.length === 0) {
    diagnostics.push({
      code: "EMPTY_REPOSITORY",
      severity: "info",
      message: "No supported architecture configuration files were discovered."
    });

    return result(statusFromDiagnostics(diagnostics), model, diagnostics);
  }

  for (const candidate of candidates) {
    const candidateRealPath = await safeRealpath(candidate.absolutePath);

    if (candidateRealPath === undefined) {
      diagnostics.push({
        code: "INVALID_INPUT",
        severity: "error",
        message: "Candidate path does not resolve to a readable file.",
        file: candidate.relativePath
      });
      continue;
    }

    if (!isPathInsideRoot(rootRealPath, candidateRealPath)) {
      diagnostics.push({
        code: "PATH_OUTSIDE_ROOT",
        severity: "error",
        message: "Candidate path resolves outside repositoryRoot and was rejected.",
        file: candidate.relativePath
      });
      continue;
    }

    const fileStat = await safeStat(candidate.absolutePath);

    if (fileStat === undefined || !fileStat.isFile()) {
      diagnostics.push({
        code: "INVALID_INPUT",
        severity: "error",
        message: "Included path is not a file.",
        file: candidate.relativePath
      });
      continue;
    }

    if (fileStat.size > maxFileBytes) {
      diagnostics.push({
        code: "FILE_TOO_LARGE",
        severity: "warning",
        message: `File exceeds maxFileBytes=${maxFileBytes} and was skipped.`,
        file: candidate.relativePath
      });
      continue;
    }

    const text = await readFile(candidate.absolutePath, "utf8");
    discoverFromYaml(candidate.relativePath, text, model, diagnostics);
  }

  detectDuplicateIds(model, diagnostics);
  sortModel(model);

  return result(statusFromDiagnostics(diagnostics), model, diagnostics);
}

async function scanCandidates(root: string, maxFiles: number, diagnostics: DiscoveryDiagnostic[]): Promise<CandidateFile[]> {
  const candidates: CandidateFile[] = [];

  await walk(root, root, candidates, maxFiles, diagnostics);

  return candidates;
}

async function walk(
  root: string,
  directory: string,
  candidates: CandidateFile[],
  maxFiles: number,
  diagnostics: DiscoveryDiagnostic[]
): Promise<void> {
  if (candidates.length >= maxFiles) {
    return;
  }

  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (candidates.length >= maxFiles) {
      diagnostics.push({
        code: "FILE_LIMIT_EXCEEDED",
        severity: "warning",
        message: `Discovery stopped after maxFiles=${maxFiles}.`
      });
      return;
    }

    const absolutePath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) {
        await walk(root, absolutePath, candidates, maxFiles, diagnostics);
      }
      continue;
    }

    if (entry.isFile() && isSupportedYamlCandidate(entry.name)) {
      candidates.push({
        absolutePath,
        relativePath: toRelative(root, absolutePath)
      });
    }
  }
}

async function resolveIncludedCandidates(
  root: string,
  includePaths: string[],
  maxFiles: number,
  diagnostics: DiscoveryDiagnostic[]
): Promise<CandidateFile[]> {
  if (includePaths.length > maxFiles) {
    diagnostics.push({
      code: "FILE_LIMIT_EXCEEDED",
      severity: "warning",
      message: `Only the first maxFiles=${maxFiles} include paths will be inspected.`
    });
  }

  return includePaths.slice(0, maxFiles).flatMap((includePath) => {
    const absolutePath = path.resolve(root, includePath);

    if (!isPathInsideRoot(root, absolutePath)) {
      diagnostics.push({
        code: "PATH_OUTSIDE_ROOT",
        severity: "error",
        message: "Included path resolves outside repositoryRoot and was rejected.",
        file: includePath
      });

      return [];
    }

    return [{
      absolutePath,
      relativePath: toRelative(root, absolutePath)
    }];
  });
}

function discoverFromYaml(relativePath: string, text: string, model: ArchitectureModel, diagnostics: DiscoveryDiagnostic[]): void {
  const documents = parseAllDocuments(text);

  if (documents.length === 0) {
    diagnostics.push({
      code: "UNSUPPORTED_FORMAT",
      severity: "warning",
      message: "YAML file did not contain a supported document.",
      file: relativePath
    });
    return;
  }

  documents.forEach((document, index) => {
    if (document.errors.length > 0) {
      diagnostics.push({
        code: "MALFORMED_YAML",
        severity: "error",
        message: "YAML document could not be parsed safely.",
        file: relativePath
      });
      return;
    }

    const value = document.toJSON() as unknown;

    if (!isObject(value)) {
      diagnostics.push({
        code: "UNSUPPORTED_FORMAT",
        severity: "warning",
        message: "Only mapping YAML documents are supported.",
        file: relativePath
      });
      return;
    }

    if (isComposeDocument(relativePath, value)) {
      discoverCompose(relativePath, value, model, diagnostics);
      return;
    }

    if (isKubernetesDocument(value)) {
      discoverKubernetes(relativePath, index, value, model, diagnostics);
      return;
    }

    diagnostics.push({
      code: "UNSUPPORTED_FORMAT",
      severity: "warning",
      message: "YAML document is not a supported Docker Compose or Kubernetes manifest.",
      file: relativePath
    });
  });
}

function discoverCompose(
  relativePath: string,
  document: Record<string, unknown>,
  model: ArchitectureModel,
  diagnostics: DiscoveryDiagnostic[]
): void {
  const services = document.services;
  const source: SourceProvenance = {
    file: relativePath,
    format: "docker-compose"
  };

  if (!isObject(services)) {
    diagnostics.push({
      code: "UNSUPPORTED_CONSTRUCT",
      severity: "warning",
      message: "Docker Compose file has no services mapping.",
      file: relativePath
    });
  } else {
    for (const [serviceName, serviceValue] of sortedEntries(services)) {
      if (!isObject(serviceValue)) {
        diagnostics.push({
          code: "UNSUPPORTED_CONSTRUCT",
          severity: "warning",
          message: `Compose service ${serviceName} is not a mapping and was skipped.`,
          file: relativePath
        });
        continue;
      }

      if ("extends" in serviceValue) {
        diagnostics.push({
          code: "UNSUPPORTED_CONSTRUCT",
          severity: "warning",
          message: `Compose service ${serviceName} uses extends, which is unsupported.`,
          file: relativePath
        });
      }

      model.services.push({
        id: stableId("compose", "service", serviceName),
        name: serviceName,
        workloadType: "compose-service",
        image: stringOrUndefined(serviceValue.image),
        buildContext: composeBuildContext(serviceValue.build),
        ports: stringArray(serviceValue.ports),
        dependencies: composeDependencies(serviceValue.depends_on),
        source
      });
    }
  }

  addComposeResources("volume", document.volumes, relativePath, model, diagnostics);
  addComposeResources("network", document.networks, relativePath, model, diagnostics);
}

function addComposeResources(
  kind: "volume" | "network",
  value: unknown,
  relativePath: string,
  model: ArchitectureModel,
  diagnostics: DiscoveryDiagnostic[]
): void {
  if (value === undefined) {
    return;
  }

  if (!isObject(value)) {
    diagnostics.push({
      code: "UNSUPPORTED_CONSTRUCT",
      severity: "warning",
      message: `Compose ${kind}s must be declared as a mapping.`,
      file: relativePath
    });
    return;
  }

  for (const [name] of sortedEntries(value)) {
    model.resources.push({
      id: stableId("compose", kind, name),
      name,
      resourceType: kind === "volume" ? "compose-volume" : "compose-network",
      ports: [],
      source: {
        file: relativePath,
        format: "docker-compose"
      }
    });
  }
}

function discoverKubernetes(
  relativePath: string,
  documentIndex: number,
  document: Record<string, unknown>,
  model: ArchitectureModel,
  diagnostics: DiscoveryDiagnostic[]
): void {
  const kind = stringOrUndefined(document.kind);
  const metadata = isObject(document.metadata) ? document.metadata : undefined;
  const name = stringOrUndefined(metadata?.name);
  const source: SourceProvenance = {
    file: relativePath,
    format: "kubernetes",
    documentIndex
  };

  if (kind === undefined || name === undefined) {
    diagnostics.push({
      code: "UNSUPPORTED_CONSTRUCT",
      severity: "warning",
      message: "Kubernetes documents require string kind and metadata.name.",
      file: relativePath
    });
    return;
  }

  if (KUBERNETES_WORKLOAD_KINDS.has(kind)) {
    model.services.push({
      id: stableId("kubernetes", kind, name),
      name,
      workloadType: "kubernetes-workload",
      image: firstKubernetesImage(document),
      ports: kubernetesContainerPorts(document),
      dependencies: [],
      source
    });
    return;
  }

  if (kind === "Service" || kind === "ConfigMap" || kind === "Secret" || kind === "Ingress") {
    model.resources.push({
      id: stableId("kubernetes", kind, name),
      name,
      resourceType: "kubernetes-resource",
      kind,
      ports: kind === "Service" ? kubernetesServicePorts(document) : [],
      source
    });
    return;
  }

  diagnostics.push({
    code: "UNSUPPORTED_FORMAT",
    severity: "warning",
    message: `Kubernetes kind ${kind} is not supported by Phase 02 discovery.`,
    file: relativePath
  });
}

function detectDuplicateIds(model: ArchitectureModel, diagnostics: DiscoveryDiagnostic[]): void {
  const seen = new Set<string>();

  for (const item of [...model.services, ...model.resources]) {
    if (seen.has(item.id)) {
      diagnostics.push({
        code: "DUPLICATE_IDENTIFIER",
        severity: "error",
        message: `Duplicate architecture identifier ${item.id}.`,
        file: item.source.file
      });
    }
    seen.add(item.id);
  }
}

function sortModel(model: ArchitectureModel): void {
  model.services.sort((left, right) => left.id.localeCompare(right.id));
  model.resources.sort((left, right) => left.id.localeCompare(right.id));

  for (const service of model.services) {
    service.dependencies.sort();
    service.ports.sort();
  }

  for (const resource of model.resources) {
    resource.ports.sort();
  }
}

function statusFromDiagnostics(diagnostics: DiscoveryDiagnostic[]): DiscoveryStatus {
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return "invalid";
  }

  if (diagnostics.some((diagnostic) => diagnostic.code === "UNSUPPORTED_FORMAT") &&
    diagnostics.every((diagnostic) => diagnostic.code === "UNSUPPORTED_FORMAT" || diagnostic.code === "EMPTY_REPOSITORY")
  ) {
    return "unsupported";
  }

  if (diagnostics.some((diagnostic) => diagnostic.severity === "warning")) {
    return "partial";
  }

  return "success";
}

function result(status: DiscoveryStatus, model: ArchitectureModel, diagnostics: DiscoveryDiagnostic[]): ArchitectureDiscoveryResult {
  return {
    status,
    model,
    diagnostics
  };
}

function isComposeDocument(relativePath: string, value: Record<string, unknown>): boolean {
  return COMPOSE_FILE_NAMES.has(path.basename(relativePath).toLowerCase()) && "services" in value;
}

function isKubernetesDocument(value: Record<string, unknown>): boolean {
  return typeof value.apiVersion === "string" && typeof value.kind === "string";
}

function isSupportedYamlCandidate(fileName: string): boolean {
  const lowerName = fileName.toLowerCase();

  return COMPOSE_FILE_NAMES.has(lowerName) || lowerName.endsWith(".yaml") || lowerName.endsWith(".yml");
}

function composeBuildContext(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (isObject(value)) {
    return stringOrUndefined(value.context);
  }

  return undefined;
}

function composeDependencies(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }

  if (isObject(value)) {
    return Object.keys(value).sort();
  }

  return [];
}

function firstKubernetesImage(document: Record<string, unknown>): string | undefined {
  return kubernetesContainers(document)
    .map((container) => stringOrUndefined(container.image))
    .find((image): image is string => image !== undefined);
}

function kubernetesContainerPorts(document: Record<string, unknown>): string[] {
  return kubernetesContainers(document)
    .flatMap((container) => Array.isArray(container.ports) ? container.ports : [])
    .filter(isObject)
    .map((port) => stringOrUndefined(port.containerPort))
    .filter((port): port is string => port !== undefined);
}

function kubernetesContainers(document: Record<string, unknown>): Array<Record<string, unknown>> {
  const spec = isObject(document.spec) ? document.spec : {};
  const jobTemplate = isObject(spec.jobTemplate) ? spec.jobTemplate : {};
  const jobTemplateSpec = isObject(jobTemplate.spec) ? jobTemplate.spec : {};
  const workloadSpec = document.kind === "CronJob" ? jobTemplateSpec : spec;
  const template = isObject(workloadSpec.template) ? workloadSpec.template : {};
  const podSpec = isObject(template.spec) ? template.spec : workloadSpec;
  const containers = Array.isArray(podSpec.containers) ? podSpec.containers : [];

  return containers.filter(isObject);
}

function kubernetesServicePorts(document: Record<string, unknown>): string[] {
  const spec = isObject(document.spec) ? document.spec : {};
  const ports = Array.isArray(spec.ports) ? spec.ports : [];

  return ports
    .filter(isObject)
    .map((port) => stringOrUndefined(port.port))
    .filter((port): port is string => port !== undefined);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item))
    : [];
}

function stringOrUndefined(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return undefined;
}

function stableId(...parts: string[]): string {
  return parts.map((part) => part.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")).join(":");
}

function sortedEntries(value: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
}

async function safeStat(absolutePath: string) {
  try {
    return await stat(absolutePath);
  } catch {
    return undefined;
  }
}

async function safeRealpath(absolutePath: string): Promise<string | undefined> {
  try {
    return await resolveRealPath(path.resolve(absolutePath), 0);
  } catch {
    return undefined;
  }
}

async function resolveRealPath(absolutePath: string, depth: number): Promise<string> {
  if (depth > 64) {
    throw new Error("Too many symbolic links.");
  }

  const parsedPath = path.parse(absolutePath);
  const parts = path.relative(parsedPath.root, absolutePath).split(path.sep).filter((part) => part.length > 0);
  let currentPath = parsedPath.root;

  for (let index = 0; index < parts.length; index += 1) {
    currentPath = path.join(currentPath, parts[index]);

    const currentStat = await lstat(currentPath);

    if (currentStat.isSymbolicLink()) {
      const linkTarget = await readlink(currentPath);
      const resolvedTarget = path.resolve(path.dirname(currentPath), linkTarget);
      const remainingParts = parts.slice(index + 1);

      return resolveRealPath(path.join(resolvedTarget, ...remainingParts), depth + 1);
    }
  }

  return currentPath;
}

function isPathInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);

  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function toRelative(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
