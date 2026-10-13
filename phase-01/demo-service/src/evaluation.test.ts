import assert from "node:assert/strict";
import test from "node:test";
import {
  type EvaluationInput,
  type RequestMetricRequirement,
  type TelemetryEvidence,
  evaluateRequestMetricRequirement,
  requestMetricPresenceRule
} from "./evaluation";

const evaluatedAt = "2026-10-13T12:00:00.000Z";
const collectedAt = "2026-10-13T11:59:30.000Z";

const requirement: RequestMetricRequirement = {
  id: "REQ-HTTP-DEMO-METRIC",
  serviceName: "demo-service",
  metricName: "demo_http_server_requests_total",
  route: "/api/demo",
  method: "GET",
  minimumCount: 1,
  maxEvidenceAgeMs: 60_000
};

function completeEvidence(overrides: Partial<TelemetryEvidence> = {}): TelemetryEvidence {
  return {
    source: "synthetic-fixture",
    collectedAt,
    available: true,
    complete: true,
    samples: [],
    ...overrides
  };
}

function evaluate(input: Partial<EvaluationInput> = {}) {
  return evaluateRequestMetricRequirement({
    requirement,
    evidence: completeEvidence(),
    evaluatedAt,
    ...input
  });
}

test("passes when the required request metric is present and valid", () => {
  const finding = evaluate({
    evidence: completeEvidence({
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
    })
  });

  assert.equal(finding.outcome, "pass");
  assert.equal(finding.rule.id, requestMetricPresenceRule.id);
  assert.equal(finding.rule.version, requestMetricPresenceRule.version);
  assert.match(finding.expected, /value >= 1/);
  assert.match(finding.observed, /aggregate value 3/);
  assert.match(finding.reason, /satisfied/);
});

test("reports a gap when complete evidence proves the metric is missing", () => {
  const finding = evaluate({
    evidence: completeEvidence({
      samples: [
        {
          metricName: "other_metric_total",
          labels: {
            serviceName: "demo-service",
            route: "/api/demo",
            method: "GET"
          },
          value: 5
        }
      ]
    })
  });

  assert.equal(finding.outcome, "gap");
  assert.match(finding.observed, /No matching metric samples/);
  assert.match(finding.reason, /violated/);
});

test("reports a gap when the matching metric is below the required boundary", () => {
  const finding = evaluate({
    requirement: {
      ...requirement,
      minimumCount: 2
    },
    evidence: completeEvidence({
      samples: [
        {
          metricName: "demo_http_server_requests_total",
          labels: {
            serviceName: "demo-service",
            route: "/api/demo",
            method: "GET"
          },
          value: 1
        }
      ]
    })
  });

  assert.equal(finding.outcome, "gap");
  assert.match(finding.observed, /aggregate value 1/);
});

test("reports unknown when telemetry evidence is unavailable", () => {
  const finding = evaluate({
    evidence: completeEvidence({
      available: false
    })
  });

  assert.equal(finding.outcome, "unknown");
  assert.match(finding.reason, /without telemetry evidence/);
});

test("reports malformed evidence marked unavailable as inconclusive", () => {
  const finding = evaluate({
    evidence: {
      source: "synthetic-fixture",
      collectedAt,
      available: false,
      complete: true,
      samples: undefined
    } as unknown as TelemetryEvidence
  });

  assert.equal(finding.outcome, "inconclusive");
  assert.match(finding.reason, /sample array/);
});

test("reports unknown when telemetry evidence is incomplete", () => {
  const finding = evaluate({
    evidence: completeEvidence({
      complete: false
    })
  });

  assert.equal(finding.outcome, "unknown");
  assert.match(finding.reason, /insufficient to prove pass or gap/);
});

test("reports inconclusive when evidence is stale", () => {
  const finding = evaluate({
    evidence: completeEvidence({
      collectedAt: "2026-10-13T11:58:59.999Z"
    })
  });

  assert.equal(finding.outcome, "inconclusive");
  assert.match(finding.reason, /outside the allowed observation window/);
});

test("accepts evidence at the freshness boundary", () => {
  const finding = evaluate({
    evidence: completeEvidence({
      collectedAt: "2026-10-13T11:59:00.000Z",
      samples: [
        {
          metricName: "demo_http_server_requests_total",
          labels: {
            serviceName: "demo-service",
            route: "/api/demo",
            method: "GET"
          },
          value: 1
        }
      ]
    })
  });

  assert.equal(finding.outcome, "pass");
});

test("reports inconclusive when evidence timestamps are invalid", () => {
  const finding = evaluate({
    evidence: completeEvidence({
      collectedAt: "not-a-date"
    })
  });

  assert.equal(finding.outcome, "inconclusive");
  assert.match(finding.reason, /timestamps are invalid/);
});

test("reports inconclusive when timestamp values are not strings", () => {
  const finding = evaluate({
    evaluatedAt: 12345 as unknown as string,
    evidence: completeEvidence({
      collectedAt: 67890 as unknown as string
    })
  });

  assert.equal(finding.outcome, "inconclusive");
  assert.match(finding.reason, /non-empty strings/);
});

test("reports inconclusive when matching evidence has invalid values", () => {
  const finding = evaluate({
    evidence: completeEvidence({
      samples: [
        {
          metricName: "demo_http_server_requests_total",
          labels: {
            serviceName: "demo-service",
            route: "/api/demo",
            method: "GET"
          },
          value: Number.NaN
        }
      ]
    })
  });

  assert.equal(finding.outcome, "inconclusive");
  assert.match(finding.reason, /finite, non-negative/);
});

test("reports inconclusive when a non-matching sample has an invalid value", () => {
  const finding = evaluate({
    evidence: completeEvidence({
      samples: [
        {
          metricName: "other_metric_total",
          labels: {
            serviceName: "demo-service",
            route: "/api/demo",
            method: "GET"
          },
          value: Number.POSITIVE_INFINITY
        }
      ]
    })
  });

  assert.equal(finding.outcome, "inconclusive");
  assert.match(finding.reason, /finite, non-negative/);
});

test("reports inconclusive when matching evidence conflicts", () => {
  const sample = {
    metricName: "demo_http_server_requests_total",
    labels: {
      serviceName: "demo-service",
      route: "/api/demo",
      method: "GET",
      statusCode: "200"
    }
  };
  const finding = evaluate({
    evidence: completeEvidence({
      samples: [
        {
          ...sample,
          value: 1
        },
        {
          ...sample,
          value: 2
        }
      ]
    })
  });

  assert.equal(finding.outcome, "inconclusive");
  assert.match(finding.reason, /conflicting values/);
});

test("does not count duplicate observations of the same series twice", () => {
  const sample = {
    metricName: "demo_http_server_requests_total",
    labels: {
      serviceName: "demo-service",
      route: "/api/demo",
      method: "GET",
      statusCode: "200"
    },
    value: 1
  };
  const finding = evaluate({
    requirement: {
      ...requirement,
      minimumCount: 2
    },
    evidence: completeEvidence({
      samples: [sample, sample]
    })
  });

  assert.equal(finding.outcome, "gap");
  assert.match(finding.observed, /1 distinct matching series/);
  assert.match(finding.observed, /aggregate value 1/);
});

test("aggregates distinct matching series with different complete labels", () => {
  const finding = evaluate({
    requirement: {
      ...requirement,
      minimumCount: 3
    },
    evidence: completeEvidence({
      samples: [
        {
          metricName: "demo_http_server_requests_total",
          labels: {
            serviceName: "demo-service",
            route: "/api/demo",
            method: "GET",
            statusCode: "200"
          },
          value: 1
        },
        {
          metricName: "demo_http_server_requests_total",
          labels: {
            serviceName: "demo-service",
            route: "/api/demo",
            method: "GET",
            statusCode: "500"
          },
          value: 2
        }
      ]
    })
  });

  assert.equal(finding.outcome, "pass");
  assert.match(finding.observed, /2 distinct matching series/);
  assert.match(finding.observed, /aggregate value 3/);
});

test("documents aggregation as synthetic same-window distinct series behavior", () => {
  const finding = evaluate({
    requirement: {
      ...requirement,
      minimumCount: 4
    },
    evidence: completeEvidence({
      samples: [
        {
          metricName: "demo_http_server_requests_total",
          labels: {
            serviceName: "demo-service",
            route: "/api/demo",
            method: "GET",
            statusCode: "200"
          },
          value: 2
        },
        {
          metricName: "demo_http_server_requests_total",
          labels: {
            serviceName: "demo-service",
            route: "/api/demo",
            method: "GET",
            statusCode: "202"
          },
          value: 2
        }
      ]
    })
  });

  assert.equal(finding.outcome, "pass");
  assert.match(finding.observed, /aggregate value 4/);
});

test("does not treat different label sets as conflicting", () => {
  const finding = evaluate({
    evidence: completeEvidence({
      samples: [
        {
          metricName: "demo_http_server_requests_total",
          labels: {
            serviceName: "demo-service",
            route: "/api/demo",
            method: "GET",
            statusCode: "200"
          },
          value: 1
        },
        {
          metricName: "demo_http_server_requests_total",
          labels: {
            serviceName: "demo-service",
            route: "/api/demo",
            method: "GET",
            statusCode: "500"
          },
          value: 2
        }
      ]
    })
  });

  assert.equal(finding.outcome, "pass");
  assert.doesNotMatch(finding.reason, /conflicting/);
});

test("reports inconclusive when aggregation overflows", () => {
  const finding = evaluate({
    evidence: completeEvidence({
      samples: [
        {
          metricName: "demo_http_server_requests_total",
          labels: {
            serviceName: "demo-service",
            route: "/api/demo",
            method: "GET",
            statusCode: "200"
          },
          value: Number.MAX_VALUE
        },
        {
          metricName: "demo_http_server_requests_total",
          labels: {
            serviceName: "demo-service",
            route: "/api/demo",
            method: "GET",
            statusCode: "500"
          },
          value: Number.MAX_VALUE
        }
      ]
    })
  });

  assert.equal(finding.outcome, "inconclusive");
  assert.match(finding.reason, /not finite/);
});

test("reports empty required string fields as inconclusive", () => {
  const finding = evaluate({
    requirement: {
      ...requirement,
      metricName: " "
    }
  });

  assert.equal(finding.outcome, "inconclusive");
  assert.match(finding.reason, /non-empty strings/);
});

test("reports malformed evidence shape as inconclusive", () => {
  const finding = evaluate({
    evidence: {
      source: "synthetic-fixture",
      collectedAt,
      available: true,
      complete: true,
      samples: undefined
    } as unknown as TelemetryEvidence
  });

  assert.equal(finding.outcome, "inconclusive");
  assert.match(finding.reason, /sample array/);
});

test("reports unsupported extra sample labels as malformed evidence", () => {
  const finding = evaluate({
    evidence: completeEvidence({
      samples: [
        {
          metricName: "demo_http_server_requests_total",
          labels: {
            serviceName: "demo-service",
            route: "/api/demo",
            method: "GET",
            statusCode: "200",
            instance: "demo-1"
          },
          value: 1
        } as unknown as TelemetryEvidence["samples"][number]
      ]
    })
  });

  assert.equal(finding.outcome, "inconclusive");
  assert.match(finding.reason, /Malformed evidence/);
});

test("accepts Prometheus evidence source", () => {
  const finding = evaluate({
    evidence: completeEvidence({
      source: "prometheus",
      samples: [
        {
          metricName: "demo_http_server_requests_total",
          labels: {
            serviceName: "demo-service",
            route: "/api/demo",
            method: "GET"
          },
          value: 1
        }
      ]
    })
  });

  assert.equal(finding.outcome, "pass");
});

test("reports invalid evidence source as inconclusive", () => {
  const finding = evaluate({
    evidence: {
      ...completeEvidence(),
      source: "prometheus-query"
    } as unknown as TelemetryEvidence
  });

  assert.equal(finding.outcome, "inconclusive");
  assert.match(finding.reason, /synthetic-fixture or prometheus/);
});

test("reports malformed sample labels as inconclusive", () => {
  const finding = evaluate({
    evidence: completeEvidence({
      samples: [
        {
          metricName: "demo_http_server_requests_total",
          labels: {
            serviceName: "",
            route: "/api/demo",
            method: "GET"
          },
          value: 1
        }
      ]
    })
  });

  assert.equal(finding.outcome, "inconclusive");
  assert.match(finding.reason, /Malformed evidence/);
});

test("reports malformed top-level input as inconclusive", () => {
  const finding = evaluateRequestMetricRequirement(null as unknown as EvaluationInput);

  assert.equal(finding.outcome, "inconclusive");
  assert.equal(finding.requirementId, "<invalid-input>");
  assert.match(finding.reason, /Input must be an object/);
});

test("produces deterministic findings for repeated evaluations", () => {
  const input: EvaluationInput = {
    requirement,
    evaluatedAt,
    evidence: completeEvidence({
      samples: [
        {
          metricName: "demo_http_server_requests_total",
          labels: {
            serviceName: "demo-service",
            route: "/api/demo",
            method: "GET"
          },
          value: 1
        }
      ]
    })
  };

  assert.deepEqual(
    evaluateRequestMetricRequirement(input),
    evaluateRequestMetricRequirement(input)
  );
});

test("reports invalid requirement boundaries as inconclusive", () => {
  const finding = evaluate({
    requirement: {
      ...requirement,
      minimumCount: -1
    }
  });

  assert.equal(finding.outcome, "inconclusive");
  assert.match(finding.reason, /minimumCount/);
});
