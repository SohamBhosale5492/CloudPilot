import type { ExpectedObservabilityModel } from "../types/api";
import type { ArchitectureDiscoveryResult, ArchitectureServiceDraft, DiscoveredService } from "../types/architecture";

export function expectedModelDraftForService(service: DiscoveredService): ExpectedObservabilityModel {
  return {
    schemaVersion: "cloudpilot.expected-observability.v1",
    serviceId: service.id,
    requirements: []
  };
}

export type RecommendationKind = "request-rate" | "http-error-rate" | "request-latency-p95" | "health-availability";
export interface ObservabilityRecommendation {
  id: RecommendationKind;
  title: string;
  signal: "metric" | "health";
  rationale: string;
  evidence: string[];
  confidence: "low";
  assumptions: string[];
}

const INFRASTRUCTURE = /(?:^|[/_.-])(prometheus|jaeger|grafana|otel|opentelemetry|collector|node-exporter|cadvisor)(?:$|[:/_.-])/i;

export function recommendationsForService(service: DiscoveredService): ObservabilityRecommendation[] {
  const identity = `${service.name} ${service.image ?? ""}`;
  if (INFRASTRUCTURE.test(identity)) return [];
  const evidence = [
    `Workload declared as ${service.workloadType} in ${service.source.file}.`,
    ...(service.image ? [`Declared image: ${service.image}.`] : []),
    ...(service.ports.length ? [`Declared ports: ${service.ports.join(", ")}.`] : []),
    ...(service.dependencies.length ? [`Declared dependencies: ${service.dependencies.join(", ")}.`] : [])
  ];
  const assumptions = ["This is a potential application workload; discovery does not verify that it serves HTTP or emits telemetry.", "Metric names and health paths must be supplied from service documentation or runtime configuration."];
  const definitions: Array<[RecommendationKind, string, "metric" | "health", string]> = [
    ["request-rate", "Request rate", "metric", "A request counter can support traffic-volume checks."],
    ["http-error-rate", "HTTP error rate", "metric", "A request/error metric can support error-signal checks."],
    ["request-latency-p95", "Request latency (p95)", "metric", "A latency histogram or quantile can support tail-latency checks."],
    ["health-availability", "Health endpoint availability", "health", "A declared HTTP health check can be evaluated when its target is configured."]
  ];
  return definitions.map(([id, title, signal, rationale]) => ({ id, title, signal, rationale, evidence, confidence: "low", assumptions }));
}

export function modelFromRecommendations(service: DiscoveredService, selected: Array<{ recommendation: ObservabilityRecommendation; value: string }>): ExpectedObservabilityModel {
  return { ...expectedModelDraftForService(service), requirements: selected.map(({ recommendation, value }) => recommendation.signal === "health"
    ? { id: `${service.id}:${recommendation.id}`, signal: "health" as const, kind: "http" as const, endpoint: value }
    : { id: `${service.id}:${recommendation.id}`, signal: "metric" as const, metricName: value, dimensions: [] }) };
}

export function mergeRecommendationsIntoModel(
  existing: unknown,
  service: DiscoveredService,
  selected: Array<{ recommendation: ObservabilityRecommendation; value: string }>
): { model: ExpectedObservabilityModel; conflicts: string[]; error?: string } {
  const base = existing === null || existing === undefined
    ? expectedModelDraftForService(service)
    : existing as ExpectedObservabilityModel;
  if (!base || base.schemaVersion !== "cloudpilot.expected-observability.v1" || !Array.isArray(base.requirements) || typeof base.serviceId !== "string") {
    return { model: expectedModelDraftForService(service), conflicts: [], error: "The existing model is not a supported model; review or reset it explicitly before adding recommendations." };
  }
  const additions = modelFromRecommendations(service, selected).requirements;
  const ids = new Set(base.requirements.map((item) => item.id));
  const conflicts: string[] = [];
  const appended = additions.filter((item) => {
    if (!ids.has(item.id)) { ids.add(item.id); return true; }
    conflicts.push(item.id);
    return false;
  });
  return { model: { ...base, requirements: [...base.requirements, ...appended] }, conflicts };
}

export function serviceDraftsFromDiscovery(result: ArchitectureDiscoveryResult): ArchitectureServiceDraft[] {
  if (result.status === "invalid" || result.status === "unsupported") return [];
  return result.model.services.map((service) => ({ service, expectedModel: expectedModelDraftForService(service) }));
}
