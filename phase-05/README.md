# CloudPilot Phase 05 — Gap Engine

Status: implemented for review; not marked complete until acceptance evidence is reviewed.

## Scope

Phase 05 implements a deterministic, evidence-based gap engine that evaluates expected observability requirements (Phase 03) against pre-collected inspector evidence (Phase 04), producing typed `GapFinding` records.

The engine does not:
- Call inspectors or make network requests (collection is strictly separated from evaluation)
- Implement remediation, persistence, APIs, or dashboards
- Claim that synthetic test results prove real-world accuracy

Implementation lives in `phase-01/demo-service/src/gap-engine.ts` to reuse the existing TypeScript build and test harness.

## Outcome Semantics

| Outcome | Meaning |
|---|---|
| `pass` | Sufficient, fresh, complete evidence confirms the requirement is met |
| `gap` | Sufficient, fresh, complete evidence confirms the requirement is **not** met |
| `unknown` | Evidence is unavailable or insufficient to determine pass or gap |
| `inconclusive` | Evidence is malformed, stale, or internally conflicting |

> [!IMPORTANT]
> A confirmed `gap` requires sufficient, complete evidence. Absent or incomplete evidence always yields `unknown`, never `gap`.

## Rules and Signal Coverage

| Signal | Rule ID | Coverage |
|---|---|---|
| metric | `CP-RULE-OBS-GAP-METRIC-PRESENT:1.0.0` | Delegates to `evaluateRequestMetricRequirement()` from Phase 01. Supports pass, gap, unknown, and inconclusive. |
| health | `CP-RULE-OBS-GAP-HEALTH-PROBE:1.0.0` | Evaluates HTTP probe outcome with freshness check. Supports pass, gap, unknown, and inconclusive. |
| log | `CP-RULE-OBS-GAP-LOG-UNCONFIGURED:1.0.0` | No backend in Phase 04 — always `unknown`. |
| trace | `CP-RULE-OBS-GAP-TRACE-UNCONFIGURED:1.0.0` | No backend in Phase 04 — always `unknown`. |
| alert | `CP-RULE-OBS-GAP-ALERT-UNCONFIGURED:1.0.0` | No backend in Phase 04 — always `unknown`. |

## Evidence Mapping Contract

`evaluateExpectedObservabilityModel()` accepts an array of `InspectorEvidence` and matches by `requirementId`:

- **No match** → `unknown` (evidence must be collected and supplied before evaluation)
- **Multiple matches for one ID** → `inconclusive` (ambiguous mapping; deduplicate before calling)
- **Exactly one match** → evaluated per signal-specific rule

Output is sorted deterministically by `requirementId`.

## Configuration

```typescript
GapEngineConfig {
  metricConfigs?: Record<string, MetricEvaluationConfig>;  // keyed by requirement ID
  maxHealthEvidenceAgeMs?: number;                          // required for health pass/gap
  evaluatedAt?: Date;                                       // inject for deterministic tests
}

MetricEvaluationConfig {
  serviceName: string;
  route: string;
  method?: string;
  minimumCount: number;
  maxEvidenceAgeMs: number;
}
```

`ExpectedMetricRequirement` intentionally omits deployment attributes (`serviceName`, `route`) and policy thresholds. Provide these explicitly via `metricConfigs[requirementId]`. Missing config returns `unknown` — defaults are never silently filled in.

## Freshness Checks

- **Metric**: staleness is enforced by the Phase 01 evaluator using `MetricEvaluationConfig.maxEvidenceAgeMs`.
- **Health**: staleness is enforced by the gap engine using `GapEngineConfig.maxHealthEvidenceAgeMs`. If not set, pass and gap verdicts cannot be issued and are returned as `inconclusive`.
- Evaluation time is pinned once per batch via `GapEngineConfig.evaluatedAt` for consistency.

## Baseline Test Scenarios

The test suite contains 21 fixture-based scenarios. All evidence is synthetic; no network calls are made.

**Included challenge cases (seeded for precision/recall baseline):**

| Label | Scenario | Expected outcome | Risk mitigated |
|---|---|---|---|
| False-positive challenge | Stale healthy health probe evidence | `inconclusive` | Prevents cached-healthy evidence from producing spurious `pass` verdicts |
| False-negative challenge | Complete metric evidence with zero matching samples | `gap` | Ensures a zero-count result is correctly classified as a gap, not dismissed as `unknown` |

> [!NOTE]
> These are synthetic fixtures. They establish that the engine's logic distinguishes the cases correctly. They do not measure precision or recall against real-world telemetry; that requires live seeded-fault experiments deferred to Phase 13.

## Limitations

- **Log, trace, alert**: no backend adapters are integrated in Phase 04. All requirements in these families return `unknown`. Configure adapters in a future phase to enable evaluation.
- **Gap vs. absence**: the engine never classifies absent evidence as a confirmed gap. Only sufficient, complete, fresh evidence can produce `gap`.
- **DNS rebinding**: inherited from Phase 04. Not mitigated at the gap engine layer.
- **Metric dimensions**: `ExpectedMetricRequirement.dimensions` (from Phase 03) defines expected label names but the Phase 01 evaluator checks `metricName`, `serviceName`, `route`, and optionally `method`. Full dimension validation is deferred to a future rule version.
- **No persistence, API, or policy gate**: deferred to Phases 06–08.
