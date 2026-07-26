/**
 * Compact, de-duplicated logging for RPC failures.
 *
 * viem errors stringify to a multi-paragraph report (URL, request body, docs
 * link, version, stack trace). A misconfigured network re-throws that on every
 * poll tick, which buries the rest of the log. We print the one useful line,
 * then stay quiet until the message changes or REPEAT_MS elapses.
 */
const REPEAT_MS = 300_000; // re-report a persistent failure every 5 min

const lastLog = new Map<string, { message: string; at: number }>();

/**
 * Masks the provider key in any URL on its way to the log.
 *
 * Alchemy carries the key as the last path segment, and viem quotes the whole
 * request URL in its error report — so an unfiltered error puts a live
 * credential into whatever retains the platform's logs, where it outlives the
 * incident. Applied at the log boundary rather than at each call site, because
 * the paths that leak are the ones nobody wrote deliberately.
 */
export function redactKeys(text: string): string {
  return text.replace(/(\/v2\/)[A-Za-z0-9_-]{8,}/g, "$1***");
}

/** Pulls the provider's actual explanation out of a viem error. */
export function rpcErrorMessage(e: unknown): string {
  const err = e as { details?: unknown; shortMessage?: unknown; message?: unknown };

  const parts = [err?.details, err?.shortMessage].filter(
    (p): p is string => typeof p === "string" && p.length > 0
  );
  if (parts.length > 0) return redactKeys([...new Set(parts)].join(" — "));

  const raw = typeof err?.message === "string" ? err.message.split("\n")[0]! : String(e);
  return redactKeys(raw);
}

export function logRpcError(scope: string, e: unknown): void {
  const message = rpcErrorMessage(e);
  const prev = lastLog.get(scope);
  if (prev && prev.message === message && Date.now() - prev.at < REPEAT_MS) return;

  lastLog.set(scope, { message, at: Date.now() });
  console.error(`[${scope}] ${message}`);
}

/** Announces recovery so a silenced scope is known to be healthy again. */
export function clearRpcError(scope: string): void {
  if (lastLog.delete(scope)) console.log(`[${scope}] recovered`);
}
