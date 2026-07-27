/**
 * Secret scrubbing at the log boundary.
 *
 * Everything this process logs passes through here before it reaches a sink.
 * Doing it centrally rather than at each call site is deliberate: the lines that
 * leak a credential are the ones nobody wrote on purpose — a viem error that
 * quotes the full request URL (Alchemy carries the key as a path segment), a
 * connection error that echoes DATABASE_URL, a dumped request header.
 *
 * Two layers:
 *  1. Literal scrubbing — every secret-looking value in the environment is
 *     replaced wherever it appears in a message. This is the layer that catches
 *     leaks from third-party error strings.
 *  2. Shape scrubbing — patterns that are secrets regardless of whether we know
 *     the value (Authorization headers, credentials in URLs, `?api_key=`).
 *
 * Kept free of any import from ../config so that config.ts (which the boot
 * preflight lives in) can log without a circular import.
 */

/** Environment variable names whose value is a secret. */
const SECRET_ENV_RE =
  /(secret|password|passwd|mnemonic|api[_-]?key|apikey|private[_-]?key|credential|access[_-]?token)/i;

/**
 * Attribute keys whose value is never logged verbatim.
 *
 * Anchored on the last dot-segment so domain attributes keep working: this
 * masks `client.api_key` and `webhook.signature` while leaving `token.address`
 * and `token.decimals` (ERC-20 metadata, not credentials) untouched.
 */
const SECRET_ATTR_RE =
  /(^|\.)(secret|password|passwd|mnemonic|api_?key|authorization|cookie|set_?cookie|private_?key|credential|access_?token|refresh_?token|signature)$/i;

const MASK = "***";

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * One alternation of every secret literal in the environment, or null when the
 * process holds none. Built once — environment variables do not change at
 * runtime, and this runs on every log line.
 */
let literalRe: RegExp | null | undefined;

function secretLiterals(): RegExp | null {
  if (literalRe !== undefined) return literalRe;

  const values = new Set<string>();
  for (const [name, value] of Object.entries(Bun.env)) {
    // Short values are skipped: a 3-character "secret" would blank out
    // unrelated text everywhere it happens to occur.
    if (typeof value !== "string" || value.trim().length < 8) continue;
    if (SECRET_ENV_RE.test(name)) values.add(value.trim());
  }

  // DATABASE_URL is not secret-named but carries a password in its userinfo.
  const dbPassword = Bun.env.DATABASE_URL?.match(/\/\/[^/\s:@]+:([^@\s/]+)@/)?.[1];
  if (dbPassword && dbPassword.length >= 8) values.add(dbPassword);

  // Longest first, so a secret that contains another is masked whole.
  const sorted = [...values].sort((a, b) => b.length - a.length);
  literalRe = sorted.length ? new RegExp(sorted.map(escapeRe).join("|"), "g") : null;
  return literalRe;
}

/** Replaces every known or shaped secret in a string with `***`. */
export function redact(text: string): string {
  if (!text) return text;
  let out = text;

  const literals = secretLiterals();
  if (literals) out = out.replace(literals, MASK);

  return (
    out
      // Alchemy-style key as the last path segment: https://…/v2/<key>
      .replace(/(\/v2\/)[A-Za-z0-9_-]{8,}/g, `$1${MASK}`)
      // Credentials in a URL's userinfo: postgres://user:pw@host
      .replace(/(\/\/[^/\s:@]+:)[^@\s/]+@/g, `$1${MASK}@`)
      // Secret-ish query parameters
      .replace(/([?&](?:api[-_]?key|apikey|key|token|access_token|password)=)[^&\s"'）]+/gi, `$1${MASK}`)
      // Authorization headers quoted into an error report
      .replace(/\b(Basic|Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${MASK}`)
  );
}

/** True when an attribute key must never carry its value into the log. */
export function isSecretKey(key: string): boolean {
  return SECRET_ATTR_RE.test(key);
}

/**
 * Keeps a value identifiable without disclosing it: `a1b2…f9c0`.
 *
 * Used for things that must be correlatable across log lines but not usable —
 * an API key presented at the door, a webhook signature.
 */
export function fingerprint(value: string, keep = 4): string {
  if (value.length <= keep * 2) return MASK;
  return `${value.slice(0, keep)}…${value.slice(-keep)}`;
}

/**
 * A URL safe to log: credentials dropped, secret query parameters masked.
 * Returns the input redacted if it does not parse as a URL.
 */
export function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    return redact(u.toString());
  } catch {
    return redact(url);
  }
}
