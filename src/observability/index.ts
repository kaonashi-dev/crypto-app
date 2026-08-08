/**
 * Observability barrel — import from here, not from the individual files.
 *
 * The gateway's rule: no module in `src/` calls `console` directly. Get a scoped
 * logger with `getLogger("<module>")`, and every record then inherits level
 * control, secret redaction, trace correlation, the /admin log tail and OTLP
 * export for free.
 *
 *   const log = getLogger("payments");
 *   log.info("payment created", { "payment.id": p.publicId, "payment.amount_cop": p.amountCop });
 *
 * See docs/architecture/observability.md for the environment variables and the attribute
 * conventions.
 */
export {
  getLogger,
  addSink,
  loggingConfig,
  exceptionAttributes,
  resource,
  LEVELS,
  type Level,
  type Logger,
  type LogRecord,
  type Attributes,
  type Sink,
} from "./logger";

export {
  withContext,
  addContextAttributes,
  currentContext,
  contextAttributes,
  parseTraceparent,
  traceparent,
  newTraceId,
  newSpanId,
} from "./context";

export { redact, safeUrl, fingerprint, isSecretKey } from "./redact";
export { recentLogs, type LogQuery } from "./buffer";
export { count, gauge, observe, snapshot, processStats, startHeartbeat } from "./metrics";
export { startOtlpExport, otlpStatus } from "./otlp";
