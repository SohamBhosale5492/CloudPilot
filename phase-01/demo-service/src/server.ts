import "./telemetry";
import { trace } from "@opentelemetry/api";
import http from "node:http";
import { performance } from "node:perf_hooks";
import { buildResponse, classifyRoute } from "./routes";
import { requestCounter, requestDuration, responseSizeBytes, shutdownTelemetry } from "./telemetry";
import {
  loadMetricsConfig,
  recordMatchingMetrics,
  type ConfiguredMetricRuntime
} from "./metrics-config";
import {
  findMatchingHealthCheck,
  loadHealthChecksConfig,
  type ConfiguredHealthCheck
} from "./health-config";
import { buildStructuredLogEntry, emitStructuredLog } from "./logger";

export interface RequestMetrics {
  requestCounter: { add(value: number, attributes?: Record<string, string>): void };
  requestDuration: { record(value: number, attributes?: Record<string, string>): void };
  responseSizeBytes: { add(value: number, attributes?: Record<string, string>): void };
}

let lastConfigLoadTime = 0;
let cachedConfiguredMetrics: ConfiguredMetricRuntime[] = [];

export function getOrRefreshConfiguredMetrics(force = false): ConfiguredMetricRuntime[] {
  const now = Date.now();
  if (force || now - lastConfigLoadTime > 2000) {
    cachedConfiguredMetrics = loadMetricsConfig();
    lastConfigLoadTime = now;
  }
  return cachedConfiguredMetrics;
}

let lastHealthLoadTime = 0;
let cachedHealthChecks: ConfiguredHealthCheck[] = [];

export function getOrRefreshConfiguredHealthChecks(force = false): ConfiguredHealthCheck[] {
  const now = Date.now();
  if (force || now - lastHealthLoadTime > 2000) {
    cachedHealthChecks = loadHealthChecksConfig();
    lastHealthLoadTime = now;
  }
  return cachedHealthChecks;
}

export function createRequestHandler(
  metrics: RequestMetrics = { requestCounter, requestDuration, responseSizeBytes },
  configuredMetrics?: ReadonlyArray<ConfiguredMetricRuntime>,
  configuredHealthChecks?: ReadonlyArray<ConfiguredHealthCheck>
): http.RequestListener {
  return (request, response) => {
    const startedAt = performance.now();
    const method = request.method || "UNKNOWN";
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    let route = classifyRoute(url.pathname);
    let result = buildResponse(route);

    if (route === "unmatched") {
      const activeHealthChecks = configuredHealthChecks ?? getOrRefreshConfiguredHealthChecks();
      const matchedHealth = findMatchingHealthCheck(activeHealthChecks, url.pathname);
      if (matchedHealth) {
        route = "/health";
        result = {
          route: "/health",
          statusCode: 200,
          contentType: "application/json; charset=utf-8",
          body: JSON.stringify({
            status: "healthy",
            service: matchedHealth.service,
            endpoint: matchedHealth.endpoint
          })
        };
      }
    }

    const activeSpan = trace.getActiveSpan();
    activeSpan?.setAttribute("http.route", route);
    activeSpan?.updateName(`${method} ${route}`);
    const spanContext = activeSpan?.spanContext();

    const responseHeaders: Record<string, string> = {
      "content-type": result.contentType,
      "cache-control": "no-store"
    };
    if (spanContext?.traceId) {
      responseHeaders["x-trace-id"] = spanContext.traceId;
    }

    response.writeHead(result.statusCode, responseHeaders);
    response.end(result.body, () => {
      const labels = {
        method,
        route,
        status_code: String(result.statusCode)
      };
      const durationSeconds = (performance.now() - startedAt) / 1000;
      const responseBytes = Buffer.byteLength(result.body, "utf8");

      metrics.requestCounter.add(1, labels);
      metrics.requestDuration.record(durationSeconds, labels);
      metrics.responseSizeBytes.add(responseBytes, labels);

      const activeConfigured = configuredMetrics ?? getOrRefreshConfiguredMetrics();
      if (activeConfigured.length > 0) {
        recordMatchingMetrics(activeConfigured, {
          route,
          method,
          statusCode: result.statusCode
        });
      }

      if (!process.env.NODE_TEST_CONTEXT) {
        void emitStructuredLog(
          buildStructuredLogEntry("info", `${method} ${route} ${result.statusCode}`, {
            route,
            method,
            status_code: result.statusCode,
            trace_id: spanContext?.traceId,
            span_id: spanContext?.spanId
          })
        );
      }
    });
  };
}

function readPort(): number {
  const rawPort = process.env.PORT || "3000";
  const port = Number.parseInt(rawPort, 10);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer from 1 to 65535, received: ${rawPort}`);
  }

  return port;
}

if (require.main === module) {
  const port = readPort();
  const server = http.createServer(createRequestHandler());

  server.on("error", (error) => {
    console.error("demo-service failed to start", error);
    process.exitCode = 1;
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`demo-service listening on http://0.0.0.0:${port}`);
  });

  async function shutdown(signal: NodeJS.Signals): Promise<void> {
    console.log(`received ${signal}; shutting down demo-service`);

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    await shutdownTelemetry();
    process.exit(0);
  }

  process.on("SIGTERM", (signal) => {
    shutdown(signal).catch((error: unknown) => {
      console.error("graceful shutdown failed", error);
      process.exit(1);
    });
  });

  process.on("SIGINT", (signal) => {
    shutdown(signal).catch((error: unknown) => {
      console.error("graceful shutdown failed", error);
      process.exit(1);
    });
  });
}
