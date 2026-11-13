import { describe, expect, it } from "vitest";
import { mergeRecommendationsIntoModel, modelFromRecommendations, recommendationsForService } from "./expected-model-draft";
import type { DiscoveredService } from "../types/architecture";

const service = (overrides: Partial<DiscoveredService> = {}): DiscoveredService => ({
  id: "compose:demo-service", name: "demo-service", workloadType: "compose-service",
  image: "node:22", ports: ["3000:3000"], dependencies: [],
  source: { file: "compose.yaml", format: "docker-compose" }, ...overrides
});

describe("architecture discovery observability recommendations", () => {
  it("recommends reviewable signals from discovered application metadata without inventing metric names", () => {
    const suggestions = recommendationsForService(service());
    expect(suggestions.map((item) => item.id)).toEqual(["request-rate", "http-error-rate", "request-latency-p95", "health-availability"]);
    expect(suggestions.every((item) => item.confidence === "low" && item.evidence.some((line) => line.includes("3000:3000")))).toBe(true);
    expect(suggestions.every((item) => item.assumptions.length > 0)).toBe(true);
    expect(modelFromRecommendations(service(), []).requirements).toEqual([]);
  });

  it("suppresses application metrics for known infrastructure and explains an empty result in the panel", () => {
    expect(recommendationsForService(service({ name: "prometheus", image: "prom/prometheus:v3" }))).toEqual([]);
  });

  it("requires user-supplied exact names or endpoint before producing model requirements", () => {
    const requestRate = recommendationsForService(service())[0]!;
    const model = modelFromRecommendations(service(), [{ recommendation: requestRate, value: "demo_http_server_requests_total" }]);
    expect(model.requirements).toEqual([{
      id: "compose:demo-service:request-rate", signal: "metric", metricName: "demo_http_server_requests_total", dimensions: []
    }]);
  });

  it("preserves existing fields and appends recommendations without duplicate IDs", () => {
    const existing = { schemaVersion: "cloudpilot.expected-observability.v1" as const, serviceId: "kept-service",
      requirements: [{ id: "old", signal: "trace" as const, serviceName: "api", customSupportedField: "keep" }] };
    const [recommendation] = recommendationsForService(service());
    const result = mergeRecommendationsIntoModel(existing, service(), [{ recommendation: recommendation!, value: "requests_total" }]);
    expect(result.model.serviceId).toBe("kept-service");
    expect(result.model.requirements).toHaveLength(2);
    expect(result.model.requirements[0]).toEqual(existing.requirements[0]);
    expect(new Set(result.model.requirements.map((item) => item.id)).size).toBe(2);
  });

  it("reports same-ID conflicts and preserves the existing requirement unchanged", () => {
    const [recommendation] = recommendationsForService(service());
    const existingRequirement = { id: "compose:demo-service:request-rate", signal: "metric" as const, metricName: "old_metric", dimensions: ["method"] };
    const result = mergeRecommendationsIntoModel({ schemaVersion: "cloudpilot.expected-observability.v1", serviceId: "kept", requirements: [existingRequirement] },
      service(), [{ recommendation: recommendation!, value: "new_metric" }]);
    expect(result.conflicts).toEqual([existingRequirement.id]);
    expect(result.model.requirements).toEqual([existingRequirement]);
  });
});
