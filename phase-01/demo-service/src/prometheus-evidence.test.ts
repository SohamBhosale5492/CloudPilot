import assert from "node:assert/strict";
import test from "node:test";
import type { RequestMetricRequirement } from "./evaluation";
import { evaluateRequestMetricRequirement } from "./evaluation";
import {
  buildPrometheusRequestMetricQuery,
  collectPrometheusRequestMetricEvidence
} from "./prometheus-evidence";

const requirement: RequestMetricRequirement = {
  id: "REQ-HTTP-DEMO-METRIC",
  serviceName: "demo-service",
  metricName: "demo_http_server_requests_total",
  route: "/api/demo",
  method: "GET",
  minimumCount: 1,
  maxEvidenceAgeMs: 60_000
};

const evaluatedAt = new Date("2026-10-13T12:00:00.000Z");
const collectedAt = new Date("2026-10-13T12:00:05.000Z");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status >= 200 && status < 300 ? "OK" : "Error"
  });
}

function fetchSequence(responses: Response[]): typeof fetch {
  const pending = [...responses];

  return async () => {
    const response = pending.shift();

    assert.ok(response, "Unexpected extra fetch call.");

    return response;
  };
}

function coverageResult(sampleTimestampLagSeconds = 0) {
  return {
    status: "success",
    data: {
      resultType: "matrix",
      result: [
        {
          metric: {
            job: "otel-collector",
            instance: "otel-collector:8889"
          },
          values: coverageValues(1791892740, 1791892800, 5, sampleTimestampLagSeconds)
        }
      ]
    }
  };
}

function coverageValues(start = 1791892740, end = 1791892800, step = 5, sampleTimestampLagSeconds = 0) {
  const values: Array<[number, string]> = [];

  for (let timestamp = start; timestamp <= end; timestamp += step) {
    values.push([timestamp, String(timestamp - sampleTimestampLagSeconds)]);
  }

  return values;
}

function staleRepeatedCoverageValues(start = 1791892740, end = 1791892800, step = 5, sourceTimestamp = 1791892735) {
  const values: Array<[number, string]> = [];

  for (let timestamp = start; timestamp <= end; timestamp += step) {
    values.push([timestamp, String(sourceTimestamp)]);
  }

  return values;
}

function coverageResultWithSeries(series: unknown) {
  return {
    status: "success",
    data: {
      resultType: "matrix",
      result: [series]
    }
  };
}

function unverifiedCoverageResult() {
  return {
    status: "success",
    data: {
      resultType: "matrix",
      result: []
    }
  };
}

function vectorResponse(result: unknown[]) {
  return {
    status: "success",
    data: {
      resultType: "vector",
      result
    }
  };
}

function vectorResult(value: string, labels: Record<string, string> = {}) {
  return {
    metric: {
      __name__: "demo_http_server_requests_total",
      exported_job: "demo-service",
      job: "otel-collector",
      instance: "otel-collector:8889",
      route: "/api/demo",
      method: "GET",
      status_code: "200",
      ...labels
    },
    value: [1791892800, value]
  };
}

function collectWithResponses(responses: Response[]) {
  return collectPrometheusRequestMetricEvidence({
    baseUrl: "http://localhost:9090",
    requirement,
    collectionWindowSeconds: 60,
    timeoutMs: 1000,
    evaluatedAt,
    collectedAt,
    fetchImpl: fetchSequence(responses)
  });
}

test("builds an increase query using actual Prometheus labels", () => {
  assert.equal(
    buildPrometheusRequestMetricQuery(requirement, 60),
    'sum by (exported_job,route,method,status_code,job,instance) (increase(demo_http_server_requests_total{exported_job="demo-service",job="otel-collector",route="/api/demo",method="GET"}[60s]))'
  );
});

test("rejects invalid metric names before building PromQL", async () => {
  assert.throws(
    () => buildPrometheusRequestMetricQuery({ ...requirement, metricName: "bad metric" }, 60),
    /Invalid Prometheus metric name/
  );

  const evidence = await collectPrometheusRequestMetricEvidence({
    baseUrl: "http://localhost:9090",
    requirement: { ...requirement, metricName: "bad metric" },
    collectionWindowSeconds: 60,
    timeoutMs: 1000,
    evaluatedAt,
    collectedAt,
    fetchImpl: fetchSequence([])
  });

  assert.equal(evidence.source, "prometheus");
  assert.equal(evidence.available, false);
  assert.equal(evidence.complete, false);
});

test("collects one matching Prometheus series into evaluator evidence", async () => {
  const evidence = await collectWithResponses([
    jsonResponse(coverageResult()),
    jsonResponse(vectorResponse([vectorResult("3")]))
  ]);

  assert.deepEqual(evidence, {
    source: "prometheus",
    collectedAt: evaluatedAt.toISOString(),
    available: true,
    complete: true,
    samples: [
      {
        metricName: "demo_http_server_requests_total",
        labels: {
          serviceName: "demo-service",
          route: "/api/demo",
          method: "GET",
          statusCode: "200"
        },
        value: 3
      }
    ]
  });
});

test("maps the observed Collector series into the normalized serviceName evidence field", async () => {
  const evidence = await collectWithResponses([
    jsonResponse(coverageResult()),
    jsonResponse(vectorResponse([{
      metric: {
        __name__: "demo_http_server_requests_total",
        exported_job: "demo-service",
        job: "otel-collector",
        instance: "otel-collector:8889",
        route: "/api/demo",
        method: "GET",
        status_code: "200"
      },
      value: [1791892800, "5"]
    }]))
  ]);
  const finding = evaluateRequestMetricRequirement({
    requirement,
    evidence,
    evaluatedAt: evaluatedAt.toISOString()
  });

  assert.equal(evidence.available, true);
  assert.equal(evidence.complete, true);
  assert.deepEqual(evidence.samples, [{
    metricName: "demo_http_server_requests_total",
    labels: { serviceName: "demo-service", route: "/api/demo", method: "GET", statusCode: "200" },
    value: 5
  }]);
  assert.equal(finding.outcome, "pass");
});

test("accepts an aggregated result without the Prometheus metric-name label", async () => {
  const evidence = await collectWithResponses([
    jsonResponse(coverageResult()),
    jsonResponse(vectorResponse([{
      metric: {
        exported_job: "demo-service",
        job: "otel-collector",
        instance: "otel-collector:8889",
        route: "/api/demo",
        method: "GET",
        status_code: "200"
      },
      value: [1791892800, "5"]
    }]))
  ]);

  assert.equal(evidence.available, true);
  assert.equal(evidence.complete, true);
  assert.deepEqual(evidence.samples, [{
    metricName: requirement.metricName,
    labels: { serviceName: "demo-service", route: "/api/demo", method: "GET", statusCode: "200" },
    value: 5
  }]);
});

test("empty successful metric results remain complete empty evidence, not a fabricated metric", async () => {
  const evidence = await collectWithResponses([
    jsonResponse(coverageResult()),
    jsonResponse(vectorResponse([])),
    jsonResponse(vectorResponse([]))
  ]);
  const finding = evaluateRequestMetricRequirement({
    requirement,
    evidence,
    evaluatedAt: evaluatedAt.toISOString()
  });

  assert.equal(evidence.available, true);
  assert.equal(evidence.complete, true);
  assert.deepEqual(evidence.samples, []);
  assert.equal(finding.outcome, "gap");
});

test("collects multiple distinct series and preserves labels", async () => {
  const evidence = await collectWithResponses([
    jsonResponse(coverageResult()),
    jsonResponse(vectorResponse([
      vectorResult("1", { status_code: "200" }),
      vectorResult("2", { status_code: "500" })
    ]))
  ]);

  assert.equal(evidence.available, true);
  assert.equal(evidence.complete, true);
  assert.deepEqual(evidence.samples.map((sample) => sample.labels.statusCode), ["200", "500"]);
});

test("empty successful query is complete only when scrape coverage is healthy", async () => {
  const evidence = await collectWithResponses([
    jsonResponse(coverageResult()),
    jsonResponse(vectorResponse([])),
    jsonResponse(vectorResponse([]))
  ]);

  assert.equal(evidence.available, true);
  assert.equal(evidence.complete, true);
  assert.deepEqual(evidence.samples, []);
});

test("single healthy coverage sample is incomplete", async () => {
  const evidence = await collectWithResponses([
    jsonResponse(coverageResultWithSeries({
      metric: {
        job: "otel-collector",
        instance: "otel-collector:8889"
      },
      values: [[1791892800, "1791892800"]]
    })),
    jsonResponse(vectorResponse([])),
    jsonResponse(vectorResponse([]))
  ]);

  assert.equal(evidence.available, true);
  assert.equal(evidence.complete, false);
});

test("coverage that does not span the requested window is incomplete", async () => {
  const evidence = await collectWithResponses([
    jsonResponse(coverageResultWithSeries({
      metric: {
        job: "otel-collector",
        instance: "otel-collector:8889"
      },
      values: coverageValues(1791892750, 1791892800)
    })),
    jsonResponse(vectorResponse([])),
    jsonResponse(vectorResponse([]))
  ]);

  assert.equal(evidence.available, true);
  assert.equal(evidence.complete, false);
});

test("sparse coverage samples are incomplete", async () => {
  const evidence = await collectWithResponses([
    jsonResponse(coverageResultWithSeries({
      metric: {
        job: "otel-collector",
        instance: "otel-collector:8889"
      },
      values: coverageValues(1791892740, 1791892800, 10)
    })),
    jsonResponse(vectorResponse([])),
    jsonResponse(vectorResponse([]))
  ]);

  assert.equal(evidence.available, true);
  assert.equal(evidence.complete, false);
});

test("coverage requires a Collector job and a non-empty instance label without fixing the instance name", async () => {
  const missingTarget = await collectWithResponses([
    jsonResponse(coverageResultWithSeries({
      metric: {
        job: "otel-collector"
      },
      values: coverageValues()
    })),
    jsonResponse(vectorResponse([])),
    jsonResponse(vectorResponse([]))
  ]);
  const mismatchedTarget = await collectWithResponses([
    jsonResponse(coverageResultWithSeries({
      metric: {
        job: "other-job",
        instance: "any-target:8889"
      },
      values: coverageValues()
    })),
    jsonResponse(vectorResponse([])),
    jsonResponse(vectorResponse([]))
  ]);

  assert.equal(missingTarget.available, true);
  assert.equal(missingTarget.complete, false);
  assert.equal(mismatchedTarget.available, true);
  assert.equal(mismatchedTarget.complete, false);
});

test("coverage accepts a different non-empty Collector instance name", async () => {
  const evidence = await collectWithResponses([
    jsonResponse(coverageResultWithSeries({
      metric: { job: "otel-collector", instance: "collector-replica:8889" },
      values: coverageValues()
    })),
    jsonResponse(vectorResponse([])),
    jsonResponse(vectorResponse([]))
  ]);

  assert.equal(evidence.available, true);
  assert.equal(evidence.complete, true);
});

test("coverage with invalid timestamps is incomplete", async () => {
  const evidence = await collectWithResponses([
    jsonResponse(coverageResultWithSeries({
      metric: {
        job: "otel-collector",
        instance: "otel-collector:8889"
      },
      values: [["not-a-time", "1791892800"]]
    })),
    jsonResponse(vectorResponse([])),
    jsonResponse(vectorResponse([]))
  ]);

  assert.equal(evidence.available, true);
  assert.equal(evidence.complete, false);
});

test("empty successful query remains incomplete when scrape coverage is unhealthy", async () => {
  const evidence = await collectWithResponses([
    jsonResponse(coverageResultWithSeries({
      metric: {
        job: "otel-collector",
        instance: "otel-collector:8889"
      },
      values: [[1791892740, "not-a-timestamp"]]
    })),
    jsonResponse(vectorResponse([])),
    jsonResponse(vectorResponse([]))
  ]);
  const finding = evaluateRequestMetricRequirement({
    requirement,
    evidence,
    evaluatedAt: evaluatedAt.toISOString()
  });

  assert.equal(evidence.available, true);
  assert.equal(evidence.complete, false);
  assert.equal(finding.outcome, "unknown");
});

test("lookback-repeated old healthy up samples are incomplete", async () => {
  const evidence = await collectWithResponses([
    jsonResponse(coverageResultWithSeries({
      metric: {
        job: "otel-collector",
        instance: "otel-collector:8889"
      },
      values: staleRepeatedCoverageValues()
    })),
    jsonResponse(vectorResponse([])),
    jsonResponse(vectorResponse([]))
  ]);
  const finding = evaluateRequestMetricRequirement({
    requirement,
    evidence,
    evaluatedAt: evaluatedAt.toISOString()
  });

  assert.equal(evidence.available, true);
  assert.equal(evidence.complete, false);
  assert.equal(finding.outcome, "unknown");
});

test("custom scrape step coverage is complete when samples match the configured spacing", async () => {
  const evidence = await collectPrometheusRequestMetricEvidence({
    baseUrl: "http://localhost:9090",
    requirement,
    collectionWindowSeconds: 60,
    timeoutMs: 1000,
    evaluatedAt,
    collectedAt,
    scrapeStepSeconds: 10,
    fetchImpl: fetchSequence([
      jsonResponse(coverageResultWithSeries({
        metric: {
          job: "otel-collector",
          instance: "otel-collector:8889"
        },
        values: coverageValues(1791892740, 1791892800, 10)
      })),
      jsonResponse(vectorResponse([])),
      jsonResponse(vectorResponse([]))
    ])
  });

  assert.equal(evidence.available, true);
  assert.equal(evidence.complete, true);
});

test("empty successful query remains incomplete when scrape coverage is unverified", async () => {
  const evidence = await collectWithResponses([
    jsonResponse(unverifiedCoverageResult()),
    jsonResponse(vectorResponse([])),
    jsonResponse(vectorResponse([]))
  ]);

  assert.equal(evidence.available, true);
  assert.equal(evidence.complete, false);
});

test("coverage HTTP errors return unavailable incomplete evidence", async () => {
  const evidence = await collectWithResponses([
    jsonResponse({ error: "unavailable" }, 503)
  ]);

  assert.equal(evidence.available, false);
  assert.equal(evidence.complete, false);
});

test("metric Prometheus API errors return unavailable incomplete evidence", async () => {
  const evidence = await collectWithResponses([
    jsonResponse(coverageResult()),
    jsonResponse({
      status: "error",
      error: "bad_data"
    })
  ]);

  assert.equal(evidence.available, false);
  assert.equal(evidence.complete, false);
});

test("request timeout while reading the response body returns unavailable evidence", async () => {
  const slowResponse = {
    ok: true,
    text: () => new Promise<string>(() => undefined)
  } as Response;

  const evidence = await collectPrometheusRequestMetricEvidence({
    baseUrl: "http://localhost:9090",
    requirement,
    collectionWindowSeconds: 60,
    timeoutMs: 1,
    evaluatedAt,
    collectedAt,
    fetchImpl: async () => slowResponse
  });

  assert.equal(evidence.available, false);
  assert.equal(evidence.complete, false);
});

test("metric invalid JSON returns unavailable incomplete evidence", async () => {
  const evidence = await collectWithResponses([
    jsonResponse(coverageResult()),
    new Response("{not-json")
  ]);

  assert.equal(evidence.available, false);
  assert.equal(evidence.complete, false);
});

test("unexpected metric result shape returns unavailable incomplete evidence", async () => {
  const evidence = await collectWithResponses([
    jsonResponse(coverageResult()),
    jsonResponse({
      status: "success",
      data: {
        resultType: "matrix",
        result: []
      }
    })
  ]);

  assert.equal(evidence.available, false);
  assert.equal(evidence.complete, false);
});

test("unexpected returned metric name returns partial evidence", async () => {
  const evidence = await collectWithResponses([
    jsonResponse(coverageResult()),
    jsonResponse(vectorResponse([
      vectorResult("1", { __name__: "other_metric_total" })
    ]))
  ]);

  assert.equal(evidence.available, true);
  assert.equal(evidence.complete, false);
  assert.deepEqual(evidence.samples, []);
});

test("unexpected returned selector labels return partial evidence", async () => {
  const evidence = await collectWithResponses([
    jsonResponse(coverageResult()),
    jsonResponse(vectorResponse([
      vectorResult("1", { route: "/wrong" })
    ]))
  ]);

  assert.equal(evidence.available, true);
  assert.equal(evidence.complete, false);
});

test("unexpected service and method labels return partial evidence", async () => {
  const mismatchedLabels: Array<Record<string, string>> = [
    { exported_job: "other-service" },
    { method: "POST" }
  ];

  for (const labels of mismatchedLabels) {
    const evidence = await collectWithResponses([
      jsonResponse(coverageResult()),
      jsonResponse(vectorResponse([vectorResult("1", labels)]))
    ]);

    assert.equal(evidence.available, true);
    assert.equal(evidence.complete, false);
    assert.deepEqual(evidence.samples, []);
  }
});

test("known Collector target labels are accepted while arbitrary labels return partial evidence", async () => {
  const collectorLabelsEvidence = await collectWithResponses([
    jsonResponse(coverageResult()),
    jsonResponse(vectorResponse([vectorResult("1", { job: "otel-collector", instance: "collector-replica:8889" })]))
  ]);
  const evidence = await collectWithResponses([
    jsonResponse(coverageResult()),
    jsonResponse(vectorResponse([
      vectorResult("1", { pod_name: "demo-pod" })
    ]))
  ]);

  assert.equal(collectorLabelsEvidence.available, true);
  assert.equal(collectorLabelsEvidence.complete, true);
  assert.equal(collectorLabelsEvidence.samples.length, 1);
  assert.equal(evidence.available, true);
  assert.equal(evidence.complete, false);
});

test("invalid sample values return partial evidence", async () => {
  const evidence = await collectWithResponses([
    jsonResponse(coverageResult()),
    jsonResponse(vectorResponse([vectorResult("NaN")]))
  ]);

  assert.equal(evidence.available, true);
  assert.equal(evidence.complete, false);
  assert.deepEqual(evidence.samples, []);
});

test("missing required labels return partial evidence", async () => {
  const evidence = await collectWithResponses([
    jsonResponse(coverageResult()),
    jsonResponse(vectorResponse([vectorResult("1", { route: "" })]))
  ]);

  assert.equal(evidence.available, true);
  assert.equal(evidence.complete, false);
});

test("partial or unavailable evidence does not become a definitive gap", async () => {
  const evidence = await collectWithResponses([
    jsonResponse(coverageResult(10)),
    jsonResponse(vectorResponse([])),
    jsonResponse(vectorResponse([]))
  ]);
  const finding = evaluateRequestMetricRequirement({
    requirement,
    evidence,
    evaluatedAt: evaluatedAt.toISOString()
  });

  assert.equal(finding.outcome, "unknown");
});

test("query URLs preserve configured base paths and explicit query time", async () => {
  const requestedUrls: URL[] = [];
  const evidence = await collectPrometheusRequestMetricEvidence({
    baseUrl: "http://localhost:9090/prometheus",
    requirement,
    collectionWindowSeconds: 60,
    timeoutMs: 1000,
    evaluatedAt,
    collectedAt,
    fetchImpl: async (input) => {
      requestedUrls.push(input as URL);

      return requestedUrls.length === 1
        ? jsonResponse(coverageResult())
        : jsonResponse(vectorResponse([]));
    }
  });

  assert.equal(evidence.collectedAt, evaluatedAt.toISOString());
  assert.equal(requestedUrls[0]?.pathname, "/prometheus/api/v1/query_range");
  assert.equal(requestedUrls[0]?.searchParams.get("query"), 'timestamp(up{job="otel-collector"} == 1)');
  assert.equal(requestedUrls[0]?.searchParams.get("start"), "1791892740");
  assert.equal(requestedUrls[0]?.searchParams.get("end"), "1791892800");
  assert.equal(requestedUrls[0]?.searchParams.get("step"), "5s");
  assert.equal(requestedUrls[1]?.pathname, "/prometheus/api/v1/query");
  assert.equal(requestedUrls[1]?.searchParams.get("time"), "1791892800");
});

test("stale query windows remain stale even when acquisition time is fresh", async () => {
  const staleQueryTime = new Date("2026-10-13T11:58:00.000Z");
  const freshAcquisitionTime = new Date("2026-10-13T12:00:00.000Z");
  const evidence = await collectPrometheusRequestMetricEvidence({
    baseUrl: "http://localhost:9090",
    requirement,
    collectionWindowSeconds: 60,
    timeoutMs: 1000,
    evaluatedAt: staleQueryTime,
    collectedAt: freshAcquisitionTime,
    fetchImpl: fetchSequence([
      jsonResponse(coverageResultWithSeries({
        metric: {
          job: "otel-collector",
          instance: "otel-collector:8889"
        },
        values: coverageValues(1791892620, 1791892680)
      })),
      jsonResponse(vectorResponse([vectorResult("1")]))
    ])
  });
  const finding = evaluateRequestMetricRequirement({
    requirement,
    evidence,
    evaluatedAt: freshAcquisitionTime.toISOString()
  });

  assert.equal(evidence.collectedAt, staleQueryTime.toISOString());
  assert.equal(finding.outcome, "inconclusive");
  assert.match(finding.reason, /outside the allowed observation window/);
});

test("invalid Date input returns unavailable evidence without throwing", async () => {
  const evidence = await collectPrometheusRequestMetricEvidence({
    baseUrl: "http://localhost:9090",
    requirement,
    collectionWindowSeconds: 60,
    timeoutMs: 1000,
    evaluatedAt: new Date("bad-date"),
    collectedAt,
    fetchImpl: fetchSequence([])
  });

  assert.equal(evidence.source, "prometheus");
  assert.equal(evidence.available, false);
  assert.equal(evidence.complete, false);
});

test("identical Prometheus responses produce deterministic evidence", async () => {
  const options = {
    baseUrl: "http://localhost:9090",
    requirement,
    collectionWindowSeconds: 60,
    timeoutMs: 1000,
    evaluatedAt,
    collectedAt
  };

  assert.deepEqual(
    await collectPrometheusRequestMetricEvidence({
      ...options,
      fetchImpl: fetchSequence([
        jsonResponse(coverageResult()),
        jsonResponse(vectorResponse([vectorResult("4")]))
      ])
    }),
    await collectPrometheusRequestMetricEvidence({
      ...options,
      fetchImpl: fetchSequence([
        jsonResponse(coverageResult()),
        jsonResponse(vectorResponse([vectorResult("4")]))
      ])
    })
  );
});

test("invalid adapter configuration returns unavailable evidence", async () => {
  const evidence = await collectPrometheusRequestMetricEvidence({
    baseUrl: "file:///tmp/prometheus",
    requirement,
    collectionWindowSeconds: 60,
    timeoutMs: 1000,
    evaluatedAt,
    collectedAt,
    fetchImpl: fetchSequence([])
  });

  assert.equal(evidence.available, false);
  assert.equal(evidence.complete, false);
});

test("builds fallback increase query using service_name while keeping exported_job primary", () => {
  assert.equal(
    buildPrometheusRequestMetricQuery(requirement, 60, "service_name"),
    'sum by (service_name,route,method,status_code,job,instance) (increase(demo_http_server_requests_total{service_name="demo-service",job="otel-collector",route="/api/demo",method="GET"}[60s]))'
  );
});

test("falls back to service_name query only when primary exported_job query returns zero series", async () => {
  const requestedUrls: URL[] = [];
  const fallbackEvidence = await collectPrometheusRequestMetricEvidence({
    baseUrl: "http://localhost:9090/prometheus",
    requirement,
    collectionWindowSeconds: 60,
    timeoutMs: 1000,
    evaluatedAt,
    collectedAt,
    fetchImpl: async (input) => {
      const url = input as URL;
      requestedUrls.push(url);
      if (requestedUrls.length === 1) {
        return jsonResponse(coverageResult());
      }
      if (requestedUrls.length === 2) {
        return jsonResponse(vectorResponse([]));
      }
      return jsonResponse(vectorResponse([{
        metric: {
          __name__: "demo_http_server_requests_total",
          service_name: "demo-service",
          job: "otel-collector",
          instance: "otel-collector:8889",
          route: "/api/demo",
          method: "GET",
          status_code: "200"
        },
        value: [1791892800, "4"]
      }]));
    }
  });

  assert.equal(requestedUrls.length, 3);
  assert.equal(requestedUrls[1]?.pathname, "/prometheus/api/v1/query");
  assert.match(requestedUrls[1]?.searchParams.get("query") ?? "", /exported_job="demo-service"/);
  assert.equal(requestedUrls[2]?.pathname, "/prometheus/api/v1/query");
  assert.match(requestedUrls[2]?.searchParams.get("query") ?? "", /service_name="demo-service"/);
  assert.equal(requestedUrls[2]?.searchParams.get("time"), "1791892800");
  assert.equal(fallbackEvidence.available, true);
  assert.equal(fallbackEvidence.complete, true);
  assert.deepEqual(fallbackEvidence.samples, [{
    metricName: "demo_http_server_requests_total",
    labels: {
      serviceName: "demo-service",
      route: "/api/demo",
      method: "GET",
      statusCode: "200"
    },
    value: 4
  }]);

  const primaryFinding = evaluateRequestMetricRequirement({
    requirement,
    evidence: fallbackEvidence,
    evaluatedAt: evaluatedAt.toISOString()
  });
  assert.equal(primaryFinding.outcome, "pass");

  // Primary query non-empty response does not issue fallback query
  const primaryOnlyUrls: URL[] = [];
  const primaryEvidence = await collectPrometheusRequestMetricEvidence({
    baseUrl: "http://localhost:9090",
    requirement,
    collectionWindowSeconds: 60,
    timeoutMs: 1000,
    evaluatedAt,
    collectedAt,
    fetchImpl: async (input) => {
      primaryOnlyUrls.push(input as URL);
      if (primaryOnlyUrls.length === 1) {
        return jsonResponse(coverageResult());
      }
      return jsonResponse(vectorResponse([vectorResult("2")]));
    }
  });
  assert.equal(primaryOnlyUrls.length, 2);
  assert.equal(primaryEvidence.complete, true);
  assert.equal(primaryEvidence.samples[0]?.labels.serviceName, "demo-service");
});

test("accepts matching exported_job and service_name aliases and rejects conflicting or unknown labels", async () => {
  const matchingAliasesEvidence = await collectWithResponses([
    jsonResponse(coverageResult()),
    jsonResponse(vectorResponse([vectorResult("6", { service_name: "demo-service" })]))
  ]);
  assert.equal(matchingAliasesEvidence.available, true);
  assert.equal(matchingAliasesEvidence.complete, true);
  assert.equal(matchingAliasesEvidence.samples.length, 1);
  assert.equal(matchingAliasesEvidence.samples[0]?.labels.serviceName, "demo-service");

  const conflictingPrimaryEvidence = await collectWithResponses([
    jsonResponse(coverageResult()),
    jsonResponse(vectorResponse([vectorResult("6", { service_name: "other-service" })]))
  ]);
  assert.equal(conflictingPrimaryEvidence.available, true);
  assert.equal(conflictingPrimaryEvidence.complete, false);
  assert.deepEqual(conflictingPrimaryEvidence.samples, []);

  const emptyAliasEvidence = await collectWithResponses([
    jsonResponse(coverageResult()),
    jsonResponse(vectorResponse([vectorResult("6", { service_name: "" })]))
  ]);
  assert.equal(emptyAliasEvidence.available, true);
  assert.equal(emptyAliasEvidence.complete, false);
  assert.deepEqual(emptyAliasEvidence.samples, []);

  const conflictingFallbackEvidence = await collectWithResponses([
    jsonResponse(coverageResult()),
    jsonResponse(vectorResponse([])),
    jsonResponse(vectorResponse([{
      metric: {
        __name__: "demo_http_server_requests_total",
        exported_job: "other-service",
        service_name: "demo-service",
        job: "otel-collector",
        instance: "otel-collector:8889",
        route: "/api/demo",
        method: "GET",
        status_code: "200"
      },
      value: [1791892800, "6"]
    }]))
  ]);
  assert.equal(conflictingFallbackEvidence.available, true);
  assert.equal(conflictingFallbackEvidence.complete, false);
  assert.deepEqual(conflictingFallbackEvidence.samples, []);

  const unknownLabelWithServiceNameEvidence = await collectWithResponses([
    jsonResponse(coverageResult()),
    jsonResponse(vectorResponse([])),
    jsonResponse(vectorResponse([{
      metric: {
        __name__: "demo_http_server_requests_total",
        service_name: "demo-service",
        pod_name: "demo-pod",
        job: "otel-collector",
        instance: "otel-collector:8889",
        route: "/api/demo",
        method: "GET",
        status_code: "200"
      },
      value: [1791892800, "6"]
    }]))
  ]);
  assert.equal(unknownLabelWithServiceNameEvidence.available, true);
  assert.equal(unknownLabelWithServiceNameEvidence.complete, false);
  assert.deepEqual(unknownLabelWithServiceNameEvidence.samples, []);
});

test("service_name fallback preserves coverage, freshness validation, and unavailable error handling", async () => {
  // Incomplete scrape coverage must keep complete=false even when service_name series exist
  const incompleteCoverageEvidence = await collectWithResponses([
    jsonResponse(coverageResultWithSeries({
      metric: { job: "otel-collector", instance: "otel-collector:8889" },
      values: coverageValues(1791892740, 1791892800, 10)
    })),
    jsonResponse(vectorResponse([])),
    jsonResponse(vectorResponse([{
      metric: {
        service_name: "demo-service",
        job: "otel-collector",
        instance: "otel-collector:8889",
        route: "/api/demo",
        method: "GET",
        status_code: "200"
      },
      value: [1791892800, "5"]
    }]))
  ]);
  assert.equal(incompleteCoverageEvidence.available, true);
  assert.equal(incompleteCoverageEvidence.complete, false);
  assert.equal(evaluateRequestMetricRequirement({
    requirement,
    evidence: incompleteCoverageEvidence,
    evaluatedAt: evaluatedAt.toISOString()
  }).outcome, "unknown");

  // Stale query window remains stale for fallback results even if acquisition time is fresh
  const staleQueryTime = new Date("2026-10-13T11:58:00.000Z");
  const freshAcquisitionTime = new Date("2026-10-13T12:00:00.000Z");
  const staleFallbackEvidence = await collectPrometheusRequestMetricEvidence({
    baseUrl: "http://localhost:9090",
    requirement,
    collectionWindowSeconds: 60,
    timeoutMs: 1000,
    evaluatedAt: staleQueryTime,
    collectedAt: freshAcquisitionTime,
    fetchImpl: fetchSequence([
      jsonResponse(coverageResultWithSeries({
        metric: { job: "otel-collector", instance: "otel-collector:8889" },
        values: coverageValues(1791892620, 1791892680)
      })),
      jsonResponse(vectorResponse([])),
      jsonResponse(vectorResponse([{
        metric: {
          service_name: "demo-service",
          job: "otel-collector",
          instance: "otel-collector:8889",
          route: "/api/demo",
          method: "GET",
          status_code: "200"
        },
        value: [1791892680, "5"]
      }]))
    ])
  });
  assert.equal(staleFallbackEvidence.collectedAt, staleQueryTime.toISOString());
  assert.equal(evaluateRequestMetricRequirement({
    requirement,
    evidence: staleFallbackEvidence,
    evaluatedAt: freshAcquisitionTime.toISOString()
  }).outcome, "inconclusive");

  // Fallback HTTP/API failure returns unavailable evidence rather than fabricated empty gap
  const failedFallbackEvidence = await collectWithResponses([
    jsonResponse(coverageResult()),
    jsonResponse(vectorResponse([])),
    jsonResponse({ error: "unavailable" }, 503)
  ]);
  assert.equal(failedFallbackEvidence.available, false);
  assert.equal(failedFallbackEvidence.complete, false);
});
