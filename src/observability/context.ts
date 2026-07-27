/**
 * Ambient log context: the trace a log line belongs to, and the attributes every
 * line inside that trace should carry.
 *
 * The gateway's interesting stories are not single functions — an HTTP request
 * creates a payment, which quotes a rate, reserves a derivation index and
 * derives an address; a worker tick scans a chain, registers a deposit and
 * settles it. Passing a correlation id down through those call chains would mean
 * changing every signature, so it rides in an AsyncLocalStorage instead and the
 * logger picks it up on its own.
 *
 * Ids follow the W3C Trace Context / OpenTelemetry shape (16-byte trace id,
 * 8-byte span id, lowercase hex) and an inbound `traceparent` header is adopted
 * rather than replaced, so these logs join a caller's trace when the gateway is
 * one hop in a larger system.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Attributes } from "./logger";

export type LogContext = {
  traceId: string;
  spanId: string;
  /** Attributes merged into every record emitted inside this context. */
  attributes: Attributes;
};

const storage = new AsyncLocalStorage<LogContext>();

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export const newTraceId = (): string => randomHex(16);
export const newSpanId = (): string => randomHex(8);

export function currentContext(): LogContext | undefined {
  return storage.getStore();
}

/** Attributes bound to the active context, for callers that build their own records. */
export function contextAttributes(): Attributes | undefined {
  return storage.getStore()?.attributes;
}

/**
 * Runs `fn` inside a log context.
 *
 * Nested calls inherit the enclosing trace and merge their attributes over it,
 * so a worker tick can open the trace and the deposit it finds can add
 * `payment.id` for the rest of that chain without either knowing about the other.
 */
export function withContext<T>(
  init: { traceId?: string; spanId?: string; attributes?: Attributes },
  fn: () => T
): T {
  const parent = storage.getStore();
  const ctx: LogContext = {
    traceId: init.traceId ?? parent?.traceId ?? newTraceId(),
    spanId: init.spanId ?? newSpanId(),
    attributes: { ...parent?.attributes, ...init.attributes },
  };
  return storage.run(ctx, fn);
}

/** Adds attributes to the current context in place, for the rest of its life. */
export function addContextAttributes(attributes: Attributes): void {
  const ctx = storage.getStore();
  if (ctx) Object.assign(ctx.attributes, attributes);
}

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

/** Parses a W3C `traceparent`, or null when absent/malformed. */
export function parseTraceparent(
  header: string | null | undefined
): { traceId: string; parentSpanId: string } | null {
  const m = header?.trim().match(TRACEPARENT_RE);
  if (!m) return null;
  const [, traceId, parentSpanId] = m as unknown as [string, string, string];
  // All-zero ids are invalid per the spec and mean "no trace".
  if (/^0+$/.test(traceId) || /^0+$/.test(parentSpanId)) return null;
  return { traceId, parentSpanId };
}

/** Serialises the active context as a `traceparent` for an outbound call. */
export function traceparent(): string | null {
  const ctx = storage.getStore();
  return ctx ? `00-${ctx.traceId}-${ctx.spanId}-01` : null;
}
