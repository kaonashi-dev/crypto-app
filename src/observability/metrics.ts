/**
 * Counters and duration summaries, plus the heartbeat that prints them.
 *
 * Logs answer "what happened to this payment"; these answer "is anything
 * happening at all" — how many provider calls a five-minute test actually cost,
 * whether the confirmer is ticking, how many webhook attempts failed. Cheap
 * enough to increment on every hot path, and the heartbeat means a container
 * with no traffic still proves it is alive.
 *
 * Instrument names follow OpenTelemetry conventions (dotted, unit-suffixed for
 * durations) so they map onto real metrics if this ever grows an exporter.
 */
import { getLogger } from "./logger";
import { withContext } from "./context";

const log = getLogger("metrics");

type Summary = { count: number; sum: number; min: number; max: number };

const counters = new Map<string, number>();
const summaries = new Map<string, Summary>();
/** Values that describe a current state rather than an accumulation. */
const gauges = new Map<string, number>();

/** Attributes become part of the series name: `rpc.calls{network=tron-nile}`. */
function seriesName(name: string, attrs?: Record<string, string | number>): string {
  if (!attrs) return name;
  const parts = Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${v}`)
    .sort();
  return parts.length ? `${name}{${parts.join(",")}}` : name;
}

export function count(name: string, attrs?: Record<string, string | number>, by = 1): void {
  const key = seriesName(name, attrs);
  counters.set(key, (counters.get(key) ?? 0) + by);
}

export function gauge(name: string, value: number, attrs?: Record<string, string | number>): void {
  gauges.set(seriesName(name, attrs), value);
}

/** Records a duration in milliseconds against a summary series. */
export function observe(
  name: string,
  ms: number,
  attrs?: Record<string, string | number>
): void {
  const key = seriesName(name, attrs);
  const s = summaries.get(key);
  if (!s) summaries.set(key, { count: 1, sum: ms, min: ms, max: ms });
  else {
    s.count++;
    s.sum += ms;
    if (ms < s.min) s.min = ms;
    if (ms > s.max) s.max = ms;
  }
}

/** Everything recorded so far, for the heartbeat and /admin/api/diagnostics. */
export function snapshot() {
  return {
    counters: Object.fromEntries([...counters].sort()),
    gauges: Object.fromEntries([...gauges].sort()),
    durations_ms: Object.fromEntries(
      [...summaries].sort().map(([k, s]) => [
        k,
        {
          count: s.count,
          avg: Math.round((s.sum / s.count) * 100) / 100,
          min: Math.round(s.min * 100) / 100,
          max: Math.round(s.max * 100) / 100,
        },
      ])
    ),
  };
}

export function processStats() {
  const mem = process.memoryUsage();
  return {
    uptime_s: Math.round(process.uptime()),
    "process.memory.rss_mb": Math.round((mem.rss / 1024 / 1024) * 10) / 10,
    "process.memory.heap_used_mb": Math.round((mem.heapUsed / 1024 / 1024) * 10) / 10,
  };
}

const previous = new Map<string, number>();

/**
 * Periodic liveness line carrying the deltas since the last beat.
 *
 * Deltas rather than totals: what you want while a test runs is "12 RPC calls
 * and 1 deposit in the last minute", which a monotonic total makes you compute
 * by hand. Totals are still available from /admin/api/diagnostics.
 */
export function startHeartbeat(intervalSec = Number(Bun.env.HEARTBEAT_INTERVAL_SEC ?? 60)): void {
  if (intervalSec <= 0) return;

  const beat = () =>
    withContext({ attributes: { "worker.name": "heartbeat" } }, () => {
      const delta: Record<string, number> = {};
      for (const [key, value] of counters) {
        const diff = value - (previous.get(key) ?? 0);
        if (diff !== 0) delta[key] = diff;
        previous.set(key, value);
      }
      log.info("heartbeat", {
        ...processStats(),
        ...gaugeAttributes(),
        since_last: Object.keys(delta).length ? delta : null,
      });
    });

  const timer = setInterval(beat, intervalSec * 1000);
  // The heartbeat must not be the reason the process stays alive.
  timer.unref?.();
  log.debug("heartbeat scheduled", { interval_s: intervalSec });
}

function gaugeAttributes(): Record<string, number> {
  return Object.fromEntries([...gauges].sort());
}
