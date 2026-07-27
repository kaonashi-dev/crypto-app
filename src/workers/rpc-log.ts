/**
 * RPC failure reporting, on top of the logging service.
 *
 * viem errors stringify to a multi-paragraph report (URL, request body, docs
 * link, version, stack trace). A misconfigured network re-throws that on every
 * poll tick, which buries the rest of the log. We log the one useful line as the
 * record body, keep the full detail in `exception.*` attributes (visible at
 * LOG_LEVEL=debug and in the OTLP export), and de-duplicate: a repeating failure
 * is reported once, then again only when the message changes or five minutes
 * pass — at which point it also says how many it swallowed.
 *
 * Redaction is not done here any more; every record passes through the logger's
 * scrubber, which knows every secret in the environment rather than just
 * Alchemy's URL shape.
 */
import { getLogger, redact, count } from "../observability";

/** Pulls the provider's actual explanation out of a viem error. */
export function rpcErrorMessage(e: unknown): string {
  const err = e as { details?: unknown; shortMessage?: unknown; message?: unknown };

  const parts = [err?.details, err?.shortMessage].filter(
    (p): p is string => typeof p === "string" && p.length > 0
  );
  if (parts.length > 0) return redact([...new Set(parts)].join(" — "));

  const raw = typeof err?.message === "string" ? err.message.split("\n")[0]! : String(e);
  return redact(raw);
}

/**
 * Reports an RPC failure for `scope` (e.g. `watcher:eth-sepolia:backfill`),
 * collapsing repeats.
 */
export function logRpcError(scope: string, e: unknown): void {
  count("rpc.errors", { scope });
  getLogger(scope).repeat("rpc", "error", rpcErrorMessage(e), { err: e });
}

/** Announces recovery so a silenced scope is known to be healthy again. */
export function clearRpcError(scope: string): void {
  getLogger(scope).resolved("rpc", "rpc recovered");
}

/** @deprecated Use `redact` from ../observability; kept for existing callers. */
export const redactKeys = redact;
