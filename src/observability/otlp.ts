/**
 * Optional OTLP/HTTP log exporter.
 *
 * OpenTelemetry's wire protocol over HTTP+JSON is a POST of a documented JSON
 * envelope — no SDK required. Writing that envelope by hand keeps the runtime
 * dependency-free while making the logs consumable by anything that speaks OTLP
 * (an OpenTelemetry Collector, Grafana Alloy, Honeycomb, Uptrace, SigNoz…), which
 * is the whole point of having shaped the records the way logger.ts does.
 *
 * Off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set:
 *
 *   OTEL_EXPORTER_OTLP_ENDPOINT   e.g. http://localhost:4318
 *   OTEL_EXPORTER_OTLP_LOGS_ENDPOINT  full URL, if it is not `<base>/v1/logs`
 *   OTEL_EXPORTER_OTLP_HEADERS    `key=value,key2=value2` (auth tokens go here)
 *   OTEL_BSP_SCHEDULE_DELAY       flush interval in ms (default 5000)
 *
 * Failures here are reported through `console` rather than the logger: an
 * exporter that logs its own errors through the pipeline it is draining feeds
 * itself forever.
 */
import { addSink, resource, type AttributeValue, type LogRecord } from "./logger";
import { redact } from "./redact";

const BATCH_MAX = 512;
/** Drop point. A collector that is down must not turn into unbounded memory. */
const QUEUE_MAX = 4096;

function endpoint(): string | null {
  const explicit = Bun.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT?.trim();
  if (explicit) return explicit;
  const base = Bun.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim().replace(/\/+$/, "");
  return base ? `${base}/v1/logs` : null;
}

function headers(): Record<string, string> {
  const out: Record<string, string> = { "Content-Type": "application/json" };
  for (const pair of (Bun.env.OTEL_EXPORTER_OTLP_HEADERS ?? "").split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return out;
}

/** OTLP `AnyValue`: a one-key object naming the value's type. */
function anyValue(value: AttributeValue) {
  if (value === null) return {};
  if (typeof value === "number") {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  if (typeof value === "boolean") return { boolValue: value };
  return { stringValue: value };
}

const keyValues = (attrs: Record<string, AttributeValue>) =>
  Object.entries(attrs).map(([key, value]) => ({ key, value: anyValue(value) }));

function toLogRecord(r: LogRecord) {
  return {
    timeUnixNano: `${r.time}000000`,
    observedTimeUnixNano: `${r.time}000000`,
    severityNumber: r.severityNumber,
    severityText: r.severityText,
    body: { stringValue: r.body },
    attributes: keyValues({ ...r.attributes, "log.scope": r.scope }),
    ...(r.traceId ? { traceId: r.traceId } : {}),
    ...(r.spanId ? { spanId: r.spanId } : {}),
  };
}

let queue: LogRecord[] = [];
let dropped = 0;
let inFlight = false;
let lastError = "";

async function flush(url: string): Promise<void> {
  if (inFlight || queue.length === 0) return;
  inFlight = true;
  const batch = queue.slice(0, BATCH_MAX);
  queue = queue.slice(batch.length);

  const payload = {
    resourceLogs: [
      {
        resource: { attributes: keyValues(resource) },
        scopeLogs: [
          {
            scope: { name: "crypto-gateway", version: String(resource["service.version"]) },
            logRecords: batch.map(toLogRecord),
          },
        ],
      },
    ],
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (lastError) {
      console.log(`[otlp] export recovered (${dropped} records dropped while down)`);
      lastError = "";
      dropped = 0;
    }
  } catch (e) {
    // The batch is gone either way: retrying an export while the collector is
    // down is how a logging pipeline becomes the outage.
    const message = redact(e instanceof Error ? e.message : String(e));
    if (message !== lastError) {
      lastError = message;
      console.error(`[otlp] export failed, dropping records: ${message}`);
    }
    dropped += batch.length;
  } finally {
    inFlight = false;
  }
}

/**
 * Installs the exporter when an endpoint is configured. Returns the endpoint it
 * will ship to, or null when export is off.
 */
export function startOtlpExport(): string | null {
  const url = endpoint();
  if (!url) return null;

  addSink((record) => {
    if (queue.length >= QUEUE_MAX) {
      dropped++;
      return;
    }
    queue.push(record);
  });

  const delayMs = Number(Bun.env.OTEL_BSP_SCHEDULE_DELAY ?? 5000);
  const timer = setInterval(() => void flush(url), Math.max(delayMs, 250));
  timer.unref?.();

  // Best-effort drain on shutdown so the last records of a run are not lost.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => void flush(url));
  }

  return url;
}

/** Exporter state for /admin/api/diagnostics. */
export function otlpStatus() {
  return { endpoint: endpoint(), queued: queue.length, dropped, last_error: lastError || null };
}
