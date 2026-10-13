import "./telemetry";
import { trace } from "@opentelemetry/api";
import http from "node:http";
import { performance } from "node:perf_hooks";
import { buildResponse, classifyRoute } from "./routes";
import { requestCounter, requestDuration, shutdownTelemetry } from "./telemetry";

function readPort(): number {
  const rawPort = process.env.PORT || "3000";
  const port = Number.parseInt(rawPort, 10);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer from 1 to 65535, received: ${rawPort}`);
  }

  return port;
}

const port = readPort();

const server = http.createServer((request, response) => {
  const startedAt = performance.now();
  const method = request.method || "UNKNOWN";
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const route = classifyRoute(url.pathname);
  const result = buildResponse(route);

  const activeSpan = trace.getActiveSpan();
  activeSpan?.setAttribute("http.route", route);
  activeSpan?.updateName(`${method} ${route}`);

  response.writeHead(result.statusCode, {
    "content-type": result.contentType,
    "cache-control": "no-store"
  });
  response.end(result.body, () => {
    const labels = {
      method,
      route,
      status_code: String(result.statusCode)
    };
    const durationSeconds = (performance.now() - startedAt) / 1000;

    requestCounter.add(1, labels);
    requestDuration.record(durationSeconds, labels);
  });
});

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
