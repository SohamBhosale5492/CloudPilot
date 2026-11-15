import { trace } from "@opentelemetry/api";

export interface StructuredLogEntry {
  readonly timestamp: string;
  readonly level: "info" | "warn" | "error";
  readonly service: string;
  readonly message: string;
  readonly trace_id?: string;
  readonly span_id?: string;
  readonly route?: string;
  readonly method?: string;
  readonly status_code?: number;
}

export interface LogEmitterOptions {
  readonly serviceName?: string;
  readonly lokiPushUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Formats a structured JSON log record, enriching with active OpenTelemetry trace/span IDs if present.
 */
export function buildStructuredLogEntry(
  level: "info" | "warn" | "error",
  message: string,
  fields: {
    service?: string;
    route?: string;
    method?: string;
    status_code?: number;
    trace_id?: string;
    span_id?: string;
  } = {}
): StructuredLogEntry {
  const activeSpanContext = trace.getActiveSpan()?.spanContext();
  const traceId = fields.trace_id ?? activeSpanContext?.traceId;
  const spanId = fields.span_id ?? activeSpanContext?.spanId;

  return {
    timestamp: new Date().toISOString(),
    level,
    service: fields.service ?? process.env.OTEL_SERVICE_NAME ?? "demo-service",
    message,
    ...(traceId ? { trace_id: traceId } : {}),
    ...(spanId ? { span_id: spanId } : {}),
    ...(fields.route !== undefined ? { route: fields.route } : {}),
    ...(fields.method !== undefined ? { method: fields.method } : {}),
    ...(fields.status_code !== undefined ? { status_code: fields.status_code } : {})
  };
}

/**
 * Emits structured JSON log to stdout and asynchronously ships it to Grafana Loki if configured.
 */
export async function emitStructuredLog(
  entry: StructuredLogEntry,
  options: LogEmitterOptions = {}
): Promise<void> {
  const serialized = JSON.stringify(entry);
  if (entry.level === "error") {
    console.error(serialized);
  } else {
    console.log(serialized);
  }

  const lokiPushUrl = options.lokiPushUrl ?? process.env.LOKI_PUSH_URL;
  if (!lokiPushUrl) {
    return;
  }

  const nsTimestamp = `${BigInt(Date.parse(entry.timestamp) || Date.now()) * 1_000_000n}`;
  const payload = {
    streams: [
      {
        stream: {
          service_name: entry.service,
          level: entry.level
        },
        values: [[nsTimestamp, serialized]]
      }
    ]
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    await (options.fetchImpl ?? fetch)(lokiPushUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } catch {
    // Non-blocking best-effort shipping; stdout still has the structured log.
  } finally {
    clearTimeout(timer);
  }
}
