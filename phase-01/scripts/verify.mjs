import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const composeFile = fileURLToPath(new URL("../docker-compose.yml", import.meta.url));
const baseUrls = {
  demo: "http://127.0.0.1:3000",
  collectorHealth: "http://127.0.0.1:13133/",
  prometheus: "http://127.0.0.1:9090",
  jaeger: "http://127.0.0.1:16686"
};

function run(command, args) {
  console.log(`> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { stdio: "inherit" });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

async function waitFor(name, check, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      if (await check()) {
        console.log(`ok: ${name}`);
        return;
      }
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error(`timed out waiting for ${name}${lastError ? `: ${lastError.message}` : ""}`);
}

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${text}`);
  }

  return JSON.parse(text);
}

async function main() {
  if (!process.argv.includes("--already-running")) {
    run("docker", ["compose", "-f", composeFile, "up", "-d", "--build"]);
  }

  await waitFor("/health", async () => {
    const response = await fetch(`${baseUrls.demo}/health`);
    return response.status === 200;
  });

  await waitFor("OpenTelemetry Collector health_check extension", async () => {
    const response = await fetch(baseUrls.collectorHealth);
    return response.status === 200;
  });

  for (let index = 0; index < 20; index += 1) {
    const response = await fetch(`${baseUrls.demo}/api/demo`);
    if (!response.ok) {
      throw new Error(`/api/demo returned ${response.status}`);
    }
  }
  console.log("ok: generated /api/demo traffic");

  const metricQuery = encodeURIComponent('demo_http_server_requests_total{route="/api/demo"}');
  await waitFor("Prometheus request metric", async () => {
    const body = await fetchJson(`${baseUrls.prometheus}/api/v1/query?query=${metricQuery}`);
    return body.status === "success" && body.data.result.some((series) => Number(series.value[1]) > 0);
  }, 120_000);

  await waitFor("Jaeger trace for demo-service", async () => {
    const body = await fetchJson(`${baseUrls.jaeger}/api/traces?service=demo-service&lookback=1h&limit=20`);
    return Array.isArray(body.data) && body.data.some((trace) =>
      trace.spans?.some((span) => span.operationName.includes("/api/demo"))
    );
  }, 120_000);

  console.log("verification complete");
}

main().catch((error) => {
  console.error(`verification failed: ${error.message}`);
  process.exit(1);
});
