import { metrics } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { loadTracingConfig } from "./tracing-config";

const tracingConfig = loadTracingConfig();
const serviceName = process.env.OTEL_SERVICE_NAME || tracingConfig.serviceName || "demo-service";
const metricInterval = Number.parseInt(process.env.OTEL_METRIC_EXPORT_INTERVAL_MS || "5000", 10);

if (!Number.isFinite(metricInterval) || metricInterval <= 0) {
  throw new Error("OTEL_METRIC_EXPORT_INTERVAL_MS must be a positive integer");
}

const traceExporter = tracingConfig.enabled
  ? new OTLPTraceExporter(tracingConfig.otlpEndpoint ? { url: tracingConfig.otlpEndpoint } : undefined)
  : undefined;

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    "service.name": serviceName,
    "service.version": "0.1.0",
    "deployment.environment.name": "local"
  }),
  ...(traceExporter ? { traceExporter } : {}),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter(),
    exportIntervalMillis: metricInterval
  }),
  instrumentations: tracingConfig.enabled
    ? [
        new HttpInstrumentation({
          ignoreIncomingRequestHook: (request) => request.url === "/health"
        })
      ]
    : []
});

const sdkEnabled = process.env.OTEL_SDK_DISABLED !== "true" && !process.env.NODE_TEST_CONTEXT;
if (sdkEnabled) {
  sdk.start();
}

const meter = metrics.getMeter("cloudpilot-demo-service", "0.1.0");

export const requestCounter = meter.createCounter("demo_http_server_requests", {
  description: "Count of HTTP requests handled by route, method and status code"
});

export const requestDuration = meter.createHistogram("demo_http_server_duration_seconds", {
  description: "HTTP request duration by route, method and status code",
  unit: "s"
});

export const responseSizeBytes = meter.createCounter("demo_http_server_response_size_bytes", {
  description: "Total HTTP response body bytes sent by route, method and status code",
  unit: "By"
});

export async function shutdownTelemetry(): Promise<void> {
  if (sdkEnabled) {
    await sdk.shutdown();
  }
}
