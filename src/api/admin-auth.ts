/**
 * Sign-in for the /admin console: the guard every console route sits behind, and
 * the three endpoints the login screen talks to.
 *
 * Why a cookie session rather than the HTTP Basic gate this replaces: Basic has
 * no sign-out (the browser keeps re-sending the credential until it is closed),
 * no identity (one shared password says nothing about who looked at a
 * cross-merchant view), and no revocation short of changing that password for
 * everyone. A session is a row — nameable, revocable, expiring.
 *
 * Cookie shape, and what each attribute is actually for:
 *   HttpOnly  — script in the console cannot read the token, so an injected
 *               script cannot exfiltrate a session.
 *   SameSite=Lax + JSON-only login — a cross-site form post cannot send
 *               `application/json`, and `c.req.json()` refuses anything else, so
 *               there is no CSRF-able state change here.
 *   Path=/admin — the token is never attached to /api or /pay requests, which
 *               have nothing to do with the console.
 *   Secure    — set whenever the request arrived over TLS (directly or through a
 *               proxy that forwarded the scheme), so a deployed console never
 *               emits a cookie a downgrade could read.
 */
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { env } from "../config";
import {
  SESSION_COOKIE,
  authEnabled,
  authenticate,
  createSession,
  normalizeUsername,
  resolveSession,
  revokeSession,
  sweepExpiredSessions,
  type Operator,
} from "../services/admin-auth";
import { addContextAttributes, count, getLogger } from "../observability";

const log = getLogger("admin-auth");

declare module "hono" {
  interface ContextVariableMap {
    /** The signed-in operator, or null when the console is running open. */
    operator: Operator | null;
  }
}

export const adminAuthApi = new Hono();

/** The one console route reachable without a session — the rest is the guard's. */
export const LOGIN_PATH = "/admin/api/auth/login";

const COOKIE_PATH = "/admin";

const credentials = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

// -- Brute-force throttle ----------------------------------------------
// A password form on the public internet is guessed at, not reasoned with. The
// window is per (ip, username) *and* per ip: the first stops one account being
// hammered, the second stops one host spraying many usernames. In memory
// deliberately — this is a single process, and a throttle that needs a database
// round trip to reject a flood is a way to make the flood expensive for us.
const THROTTLE_WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 10;
const attempts = new Map<string, { failures: number; resetAt: number }>();

function throttleState(key: string, now: number) {
  const entry = attempts.get(key);
  if (!entry || entry.resetAt <= now) return null;
  return entry;
}

/** Seconds the caller must wait, or 0 when they may try. */
function throttled(keys: string[], now: number): number {
  let wait = 0;
  for (const key of keys) {
    const entry = throttleState(key, now);
    if (entry && entry.failures >= MAX_FAILURES) {
      wait = Math.max(wait, Math.ceil((entry.resetAt - now) / 1000));
    }
  }
  return wait;
}

function recordFailure(keys: string[], now: number) {
  // Bounded: a spray from many addresses must not turn the throttle into the
  // memory leak it exists to prevent.
  if (attempts.size > 5_000) {
    for (const [key, entry] of attempts) if (entry.resetAt <= now) attempts.delete(key);
  }
  for (const key of keys) {
    const entry = throttleState(key, now);
    if (entry) entry.failures++;
    else attempts.set(key, { failures: 1, resetAt: now + THROTTLE_WINDOW_MS });
  }
}

function clearFailures(keys: string[]) {
  for (const key of keys) attempts.delete(key);
}

// -- Request helpers ---------------------------------------------------

const clientIp = (c: Context) =>
  c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

/** Whether the request reached us over TLS, including through a terminating proxy. */
function isSecureRequest(c: Context): boolean {
  const forwarded = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim();
  if (forwarded) return forwarded === "https";
  return new URL(c.req.url).protocol === "https:";
}

const operatorView = (user: Operator) => ({
  id: user.id,
  username: user.username,
  is_active: user.isActive,
  last_login_at: user.lastLoginAt,
  created_at: user.createdAt,
});

// -- Guard -------------------------------------------------------------

/**
 * Requires a live session for everything under /admin/api except the login
 * endpoint itself.
 *
 * The console *shell* is deliberately not gated: it is static markup that holds
 * no data, and it has to be servable for the login screen to exist at all. Every
 * byte of merchant data comes from the routes below this guard.
 */
export const adminSessionGuard: MiddlewareHandler = async (c, next) => {
  if (c.req.path === LOGIN_PATH) return next();

  if (!authEnabled()) {
    // No ADMIN_PASSWORD: the console runs open, as it did before sign-in
    // existed. Production cannot reach this branch — the preflight refuses to
    // boot without the variable.
    c.set("operator", null);
    return next();
  }

  const session = await resolveSession(getCookie(c, SESSION_COOKIE) ?? "");
  if (!session) {
    count("admin.auth.rejected", { reason: "no_session" });
    log.debug("console request without a valid session", { "http.route": c.req.path });
    return c.json({ error: "unauthenticated" }, 401);
  }

  // Every record for the rest of this request names the operator.
  addContextAttributes({
    "operator.id": session.user.id,
    "operator.username": session.user.username,
  });
  c.set("operator", session.user);
  await next();
};

// -- POST /admin/api/auth/login ----------------------------------------

adminAuthApi.post("/login", async (c) => {
  if (!authEnabled()) {
    // Nothing to sign in to: no ADMIN_PASSWORD means no operator account exists.
    return c.json({ error: "auth_disabled" }, 409);
  }

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "bad_request" }, 400);
  }

  const body = credentials.safeParse(raw);
  if (!body.success) return c.json({ error: "bad_request" }, 400);

  const username = normalizeUsername(body.data.username);
  const ip = clientIp(c);
  const keys = [`ip:${ip ?? "unknown"}`, `user:${ip ?? "unknown"}:${username}`];
  const now = Date.now();

  const wait = throttled(keys, now);
  if (wait > 0) {
    count("admin.auth.rejected", { reason: "throttled" });
    log.warn("console login throttled", {
      "operator.username": username,
      "client.address": ip,
      "auth.retry_after_s": wait,
    });
    c.header("Retry-After", String(wait));
    return c.json({ error: "too_many_attempts", retry_after_s: wait }, 429);
  }

  const result = await authenticate(username, body.data.password);

  if (!result.ok) {
    recordFailure(keys, now);
    count("admin.auth.rejected", { reason: result.reason });
    // The reason is separated here and nowhere else: the response says only
    // "invalid credentials", but an operator locked out at 2am needs the log to
    // say whether the account is unknown, wrong-passworded or deactivated.
    log.warn("console login rejected", {
      "operator.username": username,
      "auth.failure_reason": result.reason,
      "client.address": ip,
      "user_agent.original": c.req.header("user-agent"),
    });
    return c.json({ error: "invalid_credentials" }, 401);
  }

  clearFailures(keys);
  const { token, expiresAt } = await createSession(result.user.id, {
    ip,
    userAgent: c.req.header("user-agent"),
  });
  await sweepExpiredSessions();

  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: isSecureRequest(c),
    path: COOKIE_PATH,
    expires: expiresAt,
  });

  count("admin.auth.accepted");
  log.info("console login", {
    "operator.id": result.user.id,
    "operator.username": result.user.username,
    "client.address": ip,
    "user_agent.original": c.req.header("user-agent"),
    "auth.session_expires_at": expiresAt,
  });

  return c.json({
    user: operatorView({ ...result.user, lastLoginAt: new Date() }),
    session_expires_at: expiresAt,
  });
});

// -- POST /admin/api/auth/logout ---------------------------------------
// Guarded like the rest, so a logout is always attributable. Deleting the row is
// what actually ends the session; clearing the cookie only tidies the browser.

adminAuthApi.post("/logout", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await revokeSession(token);
  deleteCookie(c, SESSION_COOKIE, { path: COOKIE_PATH });

  const operator = c.get("operator");
  if (operator) {
    count("admin.auth.logout");
    log.info("console logout", {
      "operator.id": operator.id,
      "operator.username": operator.username,
    });
  }
  return c.json({ ok: true });
});

// -- GET /admin/api/auth/me --------------------------------------------
// The console's first call. A 401 here is the signal to render the login screen,
// so the guard's rejection is the whole answer — this handler only ever runs for
// a request that already got through it.

adminAuthApi.get("/me", (c) => {
  const operator = c.get("operator");
  return c.json({
    authenticated: true,
    // "open" is the unauthenticated development mode, and the console says so on
    // screen rather than looking identical to a secured deployment.
    mode: operator ? "session" : "open",
    user: operator ? operatorView(operator) : null,
    session_ttl_hours: env.adminSessionTtlHours,
  });
});
