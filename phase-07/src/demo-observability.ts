import { readFile } from "node:fs/promises";
import path from "node:path";
import { runObservabilityDemo } from "./remediation/observability-demo";

const DEMO_BASE = "http://127.0.0.1";

async function main(): Promise<void> {
  const repositoryRoot = path.resolve(process.cwd(), "..");
  const workloadRoot = path.join(repositoryRoot, "phase-01");
  const expectedPath = path.join(workloadRoot, "demo", "expected-observability.json");
  const expectedObservability = JSON.parse(await readFile(expectedPath, "utf8")) as unknown;

  console.log("Generating bounded local workload traffic...");
  await fetchOk(`${DEMO_BASE}:3000/health`);
  for (let index = 0; index < 20; index += 1) await fetchOk(`${DEMO_BASE}:3000/api/demo`);

  // OTLP export and Prometheus scraping are both periodic (5 seconds in the
  // Phase 01 demo stack). Poll fresh read-only evidence after traffic instead
  // of declaring a zero-count gap before those samples have arrived.
  const metricDeadline = Date.now() + 30_000;
  let report: Awaited<ReturnType<typeof runObservabilityDemo>> | undefined;
  do {
    const evaluatedAt = new Date();
    report = await runObservabilityDemo({
      workloadRoot,
      includePaths: ["docker-compose.yml"],
      expectedObservability,
      evaluatedAt,
      gapEngine: {
        evaluatedAt,
        maxHealthEvidenceAgeMs: 30_000,
        metricConfigs: {
          "demo-request-count": { serviceName: "demo-service", route: "/api/demo", method: "GET", minimumCount: 1, maxEvidenceAgeMs: 120_000 },
          "cloudpilot_demo_queue_depth": { serviceName: "demo-service", route: "/api/demo", method: "GET", minimumCount: 1, maxEvidenceAgeMs: 120_000 }
        }
      },
      inspector: {
        prometheusBaseUrl: `${DEMO_BASE}:9090`,
        traceBackendUrl: `${DEMO_BASE}:16686`,
        healthBaseUrl: `${DEMO_BASE}:3000`,
        allowPrivateIps: true,
        timeoutMs: 5_000,
        collectionWindowSeconds: 60
      }
    });
    const requestMetric = report.findings.find((finding) => finding.requirementId === "demo-request-count");
    if (requestMetric?.outcome === "pass" || Date.now() >= metricDeadline) break;
    console.log("Waiting for the real request metric to arrive from the OTLP exporter and Prometheus scrape...");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  } while (Date.now() < metricDeadline);

  if (!report) throw new Error("Observability demo did not produce a report.");

  console.log("\nDISCOVERED WORKLOADS");
  for (const service of report.discovery.model.services) {
    console.log(`- ${service.name} (${service.workloadType}) from ${service.source.file}`);
  }
  console.log("\nOBSERVABILITY CONFIGURATION");
  console.log(`Prometheus scrape jobs: ${report.configuration.prometheusJobs.join(", ") || "none"}`);
  console.log(`Collector pipelines: ${report.configuration.collectorPipelines.join(", ") || "none"}`);
  for (const diagnostic of report.configuration.diagnostics) console.log(`Config diagnostic: ${diagnostic}`);

  console.log("\nFINDINGS AND EVIDENCE");
  for (const finding of report.findings) {
    const evidence = report.evidence.find((item) => item.requirementId === finding.requirementId);
    console.log(`[${finding.outcome.toUpperCase()}] ${finding.signal} ${finding.requirementId}: ${finding.observed}`);
    console.log(`  rule=${finding.rule.id}@${finding.rule.version}; evidence=${evidence?.provenance.adapter ?? "none"}; source=${evidence?.provenance.source ?? "unavailable"}`);
    if (evidence) {
      console.log(`  available=${evidence.available}; complete=${evidence.complete}; collectedAt=${evidence.collectedAt}; target=${evidence.provenance.target}`);
      for (const diagnostic of evidence.diagnostics) console.log(`  evidence-diagnostic=${diagnostic.code}: ${diagnostic.message}`);
    }
    console.log(`  reason=${finding.reason}`);
  }
  console.log("\nGENERATED CONFIGURATION (review-only; no workload files changed)");
  if (report.generatedConfigurations.length === 0) console.log("No supported confirmed gap produced a patch.");
  for (const generated of report.generatedConfigurations) {
    console.log(`--- ${generated.filePath} [${generated.validation}] ---`);
    console.log(generated.content);
  }
}

async function fetchOk(url: string): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`Local demo endpoint returned HTTP ${response.status}: ${new URL(url).pathname}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown demo failure.";
  console.error(`Observability demo failed: ${message}`);
  process.exitCode = 1;
});
