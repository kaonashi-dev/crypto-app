/**
 * In-memory ring of the most recent log records, served by
 * `GET /admin/api/logs`.
 *
 * Testing this gateway means watching a payment cross three processes — an HTTP
 * request, a chain watcher, a confirmer — and the terminal that holds those logs
 * is usually not the one you are testing from (a deployed container has no
 * terminal at all). Keeping the last few hundred records addressable turns
 * "check the server output" into a request the console can make.
 *
 * Bounded and non-durable on purpose: this is a tail, not storage. Records have
 * already passed redaction by the time they arrive, and the route that exposes
 * them sits behind the same ADMIN_PASSWORD as the rest of the console.
 */
import { addSink, type LogRecord, type Level, LEVELS } from "./logger";

const SIZE = Math.max(0, Number(Bun.env.LOG_BUFFER ?? 500));

const ring: LogRecord[] = [];
let next = 0;
/** Monotonic sequence so a poller can ask for "everything after N". */
let sequence = 0;
const seqOf = new WeakMap<LogRecord, number>();

if (SIZE > 0) {
  addSink((record) => {
    seqOf.set(record, ++sequence);
    if (ring.length < SIZE) ring.push(record);
    else ring[next] = record;
    next = (next + 1) % SIZE;
  });
}

export type LogQuery = {
  /** Minimum severity, e.g. `warn`. */
  level?: Level;
  /** Scope prefix, e.g. `watcher` or `watcher:tron-nile`. */
  scope?: string;
  /** Substring match over body, scope and attribute values. */
  q?: string;
  /** Only records newer than this sequence number (for polling). */
  since?: number;
  limit?: number;
};

/** Recent records, oldest first, newest-bounded by `limit`. */
export function recentLogs(query: LogQuery = {}) {
  const min = query.level ? LEVELS[query.level] : 0;
  const needle = query.q?.trim().toLowerCase();
  const limit = Math.min(Math.max(query.limit ?? 200, 1), SIZE || 1);

  // Oldest first: the ring's write cursor is the oldest slot once it has wrapped.
  const ordered = ring.length < SIZE ? ring : [...ring.slice(next), ...ring.slice(0, next)];

  const matched = ordered.filter((r) => {
    if (r.severityNumber < min) return false;
    if (query.scope && !r.scope.startsWith(query.scope)) return false;
    if (query.since !== undefined && (seqOf.get(r) ?? 0) <= query.since) return false;
    if (needle) {
      const hay = `${r.scope} ${r.body} ${Object.entries(r.attributes)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ")}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });

  const page = matched.slice(-limit);
  return {
    records: page.map((r) => ({
      seq: seqOf.get(r) ?? 0,
      time: new Date(r.time).toISOString(),
      level: r.severityText,
      scope: r.scope,
      body: r.body,
      trace_id: r.traceId ?? null,
      span_id: r.spanId ?? null,
      attributes: r.attributes,
    })),
    /** Total kept, matched, and the highest sequence issued so far. */
    buffered: ring.length,
    matched: matched.length,
    capacity: SIZE,
    cursor: sequence,
  };
}
