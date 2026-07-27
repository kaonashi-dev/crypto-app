/**
 * The gateway's logging service.
 *
 * One place decides what a log record is, how it is filtered, how it is
 * redacted and where it goes; every module gets a scoped `Logger` from
 * `getLogger()` and calls a level method. Nothing in `src/` writes to `console`
 * directly — that is the invariant that makes level control, redaction, trace
 * correlation and export possible at all.
 *
 * ## Data model
 *
 * A record follows the OpenTelemetry log data model: an observed timestamp, a
 * numeric severity (1–24) with its text, a human `body`, a flat map of
 * `attributes`, and the trace/span ids of the context it was emitted in.
 * Attribute names follow OTel semantic conventions where one exists
 * (`http.request.method`, `db.system`, `exception.type`, `server.address`) and a
 * domain namespace where none does (`payment.*`, `deposit.*`, `chain.*`,
 * `rate.*`, `webhook.*`).
 *
 * Holding that shape without depending on the OTel SDK keeps the runtime free of
 * a large dependency tree while staying exportable: `otlp.ts` ships these exact
 * records to any OTLP/HTTP collector, and until one is configured they are just
 * lines on stdout.
 *
 * ## Configuration (all optional)
 *
 *   LOG_LEVEL     `info`, or a comma list with per-scope overrides:
 *                 `info,payments=debug,db=trace`. Longest matching scope prefix
 *                 wins, so `watcher=debug` covers `watcher:eth-sepolia`.
 *   LOG_FORMAT    `pretty` (default on a TTY) | `json` (default otherwise).
 *   LOG_COLOR     `0` to disable ANSI colour; `NO_COLOR` is honoured too.
 *   LOG_BUFFER    Records kept in memory for /admin/api/logs (default 500, 0 off).
 *   LOG_SILENT    `1` to drop the console sink (tests).
 *   SERVICE_VERSION, OTEL_SERVICE_NAME, OTEL_EXPORTER_OTLP_ENDPOINT — see otlp.ts.
 */
import { currentContext, withContext } from "./context";
import { isSecretKey, redact } from "./redact";

// -- Severity ----------------------------------------------------------
// Numbers are OpenTelemetry's: TRACE 1-4, DEBUG 5-8, INFO 9-12, WARN 13-16,
// ERROR 17-20, FATAL 21-24. Keeping them means a collector renders our levels
// natively instead of guessing from a string.
export const LEVELS = {
  trace: 1,
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
  fatal: 21,
} as const;

export type Level = keyof typeof LEVELS;

const LEVEL_NAMES = Object.keys(LEVELS) as Level[];

export type AttributeValue = string | number | boolean | null;
export type Attributes = Record<string, unknown>;

export type LogRecord = {
  /** Epoch milliseconds. */
  time: number;
  severityNumber: number;
  severityText: string;
  /** Emitting module, e.g. `payments`, `watcher:eth-sepolia`. */
  scope: string;
  body: string;
  attributes: Record<string, AttributeValue>;
  traceId?: string;
  spanId?: string;
};

export type Sink = (record: LogRecord) => void;

// -- Configuration -----------------------------------------------------

function parseLevel(value: string | undefined, fallback: Level): Level {
  const name = value?.trim().toLowerCase();
  return (LEVEL_NAMES as string[]).includes(name ?? "") ? (name as Level) : fallback;
}

/**
 * `LOG_LEVEL=info,payments=debug,db=trace` — a default plus scope overrides.
 * A bare level anywhere in the list sets the default.
 */
function parseLevelSpec(spec: string | undefined, fallback: Level) {
  const overrides: Array<[string, Level]> = [];
  let base = fallback;

  for (const part of (spec ?? "").split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq === -1) {
      base = parseLevel(entry, base);
      continue;
    }
    // `watcher:*=trace` and `watcher:=trace` both mean "scopes starting with watcher:".
    const scope = entry.slice(0, eq).trim().replace(/\*$/, "");
    const level = parseLevel(entry.slice(eq + 1), base);
    if (scope) overrides.push([scope, level]);
  }

  // Longest prefix first: a specific scope must beat a broader one.
  overrides.sort((a, b) => b[0].length - a[0].length);
  return { base, overrides };
}

const isProduction = Bun.env.NODE_ENV === "production";
const isTty = Boolean(process.stdout.isTTY);

const config = {
  ...parseLevelSpec(Bun.env.LOG_LEVEL, isProduction ? "info" : "debug"),
  format: (Bun.env.LOG_FORMAT?.trim().toLowerCase() ?? (isTty ? "pretty" : "json")) as
    | "pretty"
    | "json",
  // LOG_COLOR=1 forces colour on even without a TTY (piping into `less -R`,
  // a docker log follower); NO_COLOR and LOG_COLOR=0 force it off.
  color:
    Bun.env.LOG_COLOR === "1" ||
    (Bun.env.NO_COLOR === undefined && Bun.env.LOG_COLOR !== "0" && isTty),
  silent: Bun.env.LOG_SILENT === "1",
};

/** Resource attributes: what this process is, attached to every exported record. */
export const resource: Record<string, AttributeValue> = {
  "service.name": Bun.env.OTEL_SERVICE_NAME || "crypto-gateway",
  "service.version": Bun.env.SERVICE_VERSION || Bun.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) || "0.1.0",
  "deployment.environment.name": isProduction ? "production" : "development",
  "process.pid": process.pid,
  "process.runtime.name": "bun",
  "process.runtime.version": Bun.version,
};

function levelFor(scope: string): Level {
  for (const [prefix, level] of config.overrides) {
    if (scope === prefix || scope.startsWith(prefix)) return level;
  }
  return config.base;
}

// -- Attribute normalisation -------------------------------------------

/**
 * Flattens an attribute map to the single-level, primitive-valued shape the log
 * model wants, and redacts on the way.
 *
 * bigint is the reason this cannot be `JSON.stringify` at the sink: money in
 * this codebase is bigint everywhere and stringify throws on it. Amounts become
 * decimal strings, exactly as the API serialises them.
 */
function normalise(
  attrs: Attributes | undefined,
  out: Record<string, AttributeValue>,
  prefix = ""
): Record<string, AttributeValue> {
  if (!attrs) return out;

  for (const [rawKey, value] of Object.entries(attrs)) {
    const key = prefix ? `${prefix}.${rawKey}` : rawKey;
    if (value === undefined) continue;

    if (isSecretKey(key)) {
      out[key] = "***";
      continue;
    }
    if (value === null) {
      out[key] = null;
    } else if (typeof value === "string") {
      out[key] = redact(value);
    } else if (typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    } else if (typeof value === "bigint") {
      out[key] = value.toString();
    } else if (value instanceof Date) {
      out[key] = value.toISOString();
    } else if (value instanceof Error) {
      exceptionAttributes(value, out, key === "err" || key === "error" ? "exception" : key);
    } else if (Array.isArray(value)) {
      // Arrays stay a single attribute: a list of addresses is one fact, and
      // exploding it into indexed keys makes a log line unreadable.
      out[key] = redact(
        JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) ?? "[]"
      );
    } else if (typeof value === "object") {
      normalise(value as Attributes, out, key);
    } else {
      out[key] = redact(String(value));
    }
  }
  return out;
}

/** OTel `exception.*` attributes for a thrown value of any shape. */
export function exceptionAttributes(
  err: unknown,
  out: Record<string, AttributeValue> = {},
  prefix = "exception"
): Record<string, AttributeValue> {
  if (err instanceof Error) {
    out[`${prefix}.type`] = err.name;
    out[`${prefix}.message`] = redact(err.message);
    if (err.stack) out[`${prefix}.stacktrace`] = redact(err.stack);
    // viem and the postgres driver both hang the useful part off the error.
    const extra = err as { code?: unknown; shortMessage?: unknown; details?: unknown };
    if (typeof extra.code === "string" || typeof extra.code === "number") {
      out[`${prefix}.code`] = extra.code;
    }
    if (typeof extra.shortMessage === "string") {
      out[`${prefix}.short_message`] = redact(extra.shortMessage);
    }
    if (typeof extra.details === "string") out[`${prefix}.details`] = redact(extra.details);
    if (err.cause instanceof Error) out[`${prefix}.cause`] = redact(err.cause.message);
  } else {
    out[`${prefix}.type`] = typeof err;
    out[`${prefix}.message`] = redact(String(err));
  }
  return out;
}

// -- Sinks -------------------------------------------------------------

const sinks: Sink[] = [];

export function addSink(sink: Sink): () => void {
  sinks.push(sink);
  return () => {
    const i = sinks.indexOf(sink);
    if (i !== -1) sinks.splice(i, 1);
  };
}

const COLOURS: Record<Level, string> = {
  trace: "\x1b[90m",
  debug: "\x1b[36m",
  info: "\x1b[32m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
  fatal: "\x1b[35m",
};
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const paint = (code: string, text: string) => (config.color ? `${code}${text}${RESET}` : text);

function formatTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function formatValue(value: AttributeValue): string {
  if (value === null) return "null";
  const text = String(value);
  return /[\s"]/.test(text) ? JSON.stringify(text) : text;
}

/**
 * Human-readable single line, plus an indented stack when there is one.
 * `time LEVEL scope  body  key=value …`
 */
function formatPretty(r: LogRecord): string {
  const level = LEVEL_NAMES.find((n) => LEVELS[n] === r.severityNumber) ?? "info";
  const head = [
    paint(DIM, formatTime(r.time)),
    paint(COLOURS[level], r.severityText.padEnd(5)),
    paint(DIM, r.scope.padEnd(22)),
    r.body,
  ].join(" ");

  let stack: string | undefined;
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(r.attributes)) {
    if (key === "exception.stacktrace") {
      stack = String(value);
      continue;
    }
    pairs.push(`${paint(DIM, key)}=${formatValue(value)}`);
  }

  let line = pairs.length ? `${head}  ${pairs.join(" ")}` : head;
  if (stack) line += `\n${stack.split("\n").map((l) => `    ${paint(DIM, l.trim())}`).join("\n")}`;
  return line;
}

/** One JSON object per line, in the OTel log-record shape. */
function formatJson(r: LogRecord): string {
  return JSON.stringify({
    timestamp: new Date(r.time).toISOString(),
    severity_text: r.severityText,
    severity_number: r.severityNumber,
    scope: r.scope,
    body: r.body,
    trace_id: r.traceId,
    span_id: r.spanId,
    ...resource,
    ...r.attributes,
  });
}

/**
 * stdout for everything below WARN, stderr from WARN up.
 *
 * `console.error` is not merely cosmetic here: platforms (Railway included)
 * classify a log line by its stream, so a warning that goes to stdout is
 * invisible to every "show me the errors" filter.
 */
const consoleSink: Sink = (record) => {
  const line = config.format === "json" ? formatJson(record) : formatPretty(record);
  if (record.severityNumber >= LEVELS.warn) console.error(line);
  else console.log(line);
};

if (!config.silent) addSink(consoleSink);

// -- Emission ----------------------------------------------------------

function emit(
  scope: string,
  level: Level,
  body: string,
  bound: Attributes | undefined,
  attrs: Attributes | undefined
): void {
  const ctx = currentContext();
  const attributes: Record<string, AttributeValue> = {};
  normalise(ctx?.attributes, attributes);
  normalise(bound, attributes);
  normalise(attrs, attributes);

  const record: LogRecord = {
    time: Date.now(),
    severityNumber: LEVELS[level],
    severityText: level.toUpperCase(),
    scope,
    body: redact(body),
    attributes,
    traceId: ctx?.traceId,
    spanId: ctx?.spanId,
  };

  for (const sink of sinks) {
    try {
      sink(record);
    } catch {
      // A failing sink must never take down the code that logged.
    }
  }
}

// -- Throttling --------------------------------------------------------

const THROTTLE_MS = 300_000; // re-report a persistent condition every 5 min
type ThrottleState = { body: string; at: number; suppressed: number };
const throttled = new Map<string, ThrottleState>();

// -- Logger ------------------------------------------------------------

export type SpanHandle = {
  /** Adds attributes to the record this span emits when it ends. */
  set(attrs: Attributes): void;
};

export interface Logger {
  readonly scope: string;
  trace(body: string, attrs?: Attributes): void;
  debug(body: string, attrs?: Attributes): void;
  info(body: string, attrs?: Attributes): void;
  warn(body: string, attrs?: Attributes): void;
  error(body: string, attrs?: Attributes): void;
  fatal(body: string, attrs?: Attributes): void;
  /** True when a record at this level would be emitted — guard expensive attribute building. */
  enabled(level: Level): boolean;
  /** A logger with extra bound attributes, and optionally a narrower scope. */
  child(scope?: string, attrs?: Attributes): Logger;
  /**
   * Starts a timer. The returned function emits the record with `duration_ms`,
   * so a call site reads as one statement in and one statement out.
   */
  time(body: string, attrs?: Attributes): (extra?: Attributes, level?: Level) => number;
  /**
   * Runs `fn` as a timed unit of work in its own trace span: one record on
   * success (`duration_ms`), one at ERROR on failure, and the error re-thrown.
   */
  span<T>(name: string, attrs: Attributes, fn: (span: SpanHandle) => Promise<T>): Promise<T>;
  /**
   * Emits at most one record per `key` per 5 minutes while the body stays the
   * same, then reports how many it swallowed. For conditions that repeat on
   * every worker tick — an unreachable RPC would otherwise bury the log.
   */
  repeat(key: string, level: Level, body: string, attrs?: Attributes): void;
  /** Clears a `repeat` key and announces recovery once, if it had been firing. */
  resolved(key: string, body?: string, attrs?: Attributes): void;
}

function makeLogger(scope: string, bound?: Attributes): Logger {
  const at = (level: Level) => (body: string, attrs?: Attributes) => {
    if (LEVELS[level] < LEVELS[levelFor(scope)]) return;
    emit(scope, level, body, bound, attrs);
  };

  const logger: Logger = {
    scope,
    trace: at("trace"),
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    fatal: at("fatal"),

    enabled: (level) => LEVELS[level] >= LEVELS[levelFor(scope)],

    child: (childScope, attrs) =>
      makeLogger(childScope ? `${scope}:${childScope}` : scope, { ...bound, ...attrs }),

    time(body, attrs) {
      const started = performance.now();
      return (extra, level: Level = "debug") => {
        const ms = performance.now() - started;
        at(level)(body, { ...attrs, ...extra, duration_ms: Math.round(ms * 100) / 100 });
        return ms;
      };
    },

    span(name, attrs, fn) {
      // A span gets its own span id inside the caller's trace, so the records
      // emitted by `fn` group under it rather than under whatever opened the trace.
      return withContext({ attributes: {} }, async () => {
        const started = performance.now();
        const extra: Attributes = {};
        try {
          const result = await fn({ set: (more) => Object.assign(extra, more) });
          at("debug")(name, {
            ...attrs,
            ...extra,
            duration_ms: Math.round((performance.now() - started) * 100) / 100,
          });
          return result;
        } catch (e) {
          at("error")(name, {
            ...attrs,
            ...extra,
            duration_ms: Math.round((performance.now() - started) * 100) / 100,
            err: e,
          });
          throw e;
        }
      });
    },

    repeat(key, level, body, attrs) {
      const fullKey = `${scope} ${key}`;
      const prev = throttled.get(fullKey);
      const now = Date.now();

      if (prev && prev.body === body && now - prev.at < THROTTLE_MS) {
        prev.suppressed++;
        return;
      }
      throttled.set(fullKey, { body, at: now, suppressed: 0 });
      at(level)(body, prev?.suppressed ? { ...attrs, suppressed: prev.suppressed } : attrs);
    },

    resolved(key, body = "recovered", attrs) {
      const fullKey = `${scope} ${key}`;
      const prev = throttled.get(fullKey);
      if (!prev) return;
      throttled.delete(fullKey);
      at("info")(body, prev.suppressed ? { ...attrs, suppressed: prev.suppressed } : attrs);
    },
  };

  return logger;
}

const registry = new Map<string, Logger>();

/**
 * The logger for a module. Scopes are dot/colon-free words plus a colon-joined
 * qualifier where a module runs once per network (`watcher:eth-sepolia`), which
 * is also what LOG_LEVEL overrides match on.
 */
export function getLogger(scope: string, attrs?: Attributes): Logger {
  if (attrs) return makeLogger(scope, attrs);
  let logger = registry.get(scope);
  if (!logger) {
    logger = makeLogger(scope);
    registry.set(scope, logger);
  }
  return logger;
}

/** The effective configuration, for the boot banner and /admin diagnostics. */
export function loggingConfig() {
  return {
    level: config.base,
    overrides: Object.fromEntries(config.overrides),
    format: config.format,
    color: config.color,
    silent: config.silent,
    sinks: sinks.length,
  };
}
