import { createSignal } from "solid-js";

/**
 * The console's half of the session (see src/api/admin-auth.ts).
 *
 * There is no token to hold: the cookie is HttpOnly, so signing in is a POST
 * whose only visible effect is that subsequent requests stop returning 401.
 * Everything here therefore describes *state*, never a credential.
 */

export type Operator = {
  id: string;
  username: string;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
};

export type Session = {
  authenticated: boolean;
  /** "open" is the unauthenticated development mode — no ADMIN_PASSWORD is set. */
  mode: "session" | "open";
  user: Operator | null;
  session_ttl_hours?: number;
};

const SIGNED_OUT: Session = { authenticated: false, mode: "session", user: null };

/**
 * Set when any console request comes back 401.
 *
 * A session can lapse between two polls of a table, and the honest response is
 * to stop rendering merchant data immediately rather than wait for the identity
 * query to notice on its own schedule. `api.ts` raises this from the one place
 * every fetch passes through, so no route has to handle expiry itself.
 */
const [sessionExpired, setSessionExpired] = createSignal(false);
export { sessionExpired, setSessionExpired };

/** Resolves to a signed-out session on 401 rather than throwing: not being signed in is an answer, not an error. */
export async function fetchSession(): Promise<Session> {
  const res = await fetch("/admin/api/auth/me");
  if (res.status === 401) return SIGNED_OUT;
  if (!res.ok) throw new Error(`session ${res.status}`);
  return (await res.json()) as Session;
}

/** Thrown with a message meant to be shown on the login form. */
export class LoginError extends Error {}

export async function login(username: string, password: string): Promise<Operator> {
  const res = await fetch("/admin/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });

  if (res.ok) {
    const body = (await res.json()) as { user: Operator };
    setSessionExpired(false);
    return body.user;
  }

  const body = (await res.json().catch(() => null)) as
    | { error?: string; retry_after_s?: number }
    | null;

  // The server deliberately does not say which half of the credential was wrong;
  // repeating that here keeps the form from becoming a user directory.
  if (res.status === 429) {
    const mins = Math.ceil((body?.retry_after_s ?? 900) / 60);
    throw new LoginError(`Too many attempts. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`);
  }
  if (res.status === 409) {
    throw new LoginError("No operator account exists — ADMIN_PASSWORD is not set on this server.");
  }
  if (res.status === 401) throw new LoginError("Invalid username or password.");
  throw new LoginError(`Sign-in failed (${res.status}).`);
}

export async function logout(): Promise<void> {
  await fetch("/admin/api/auth/logout", { method: "POST" }).catch(() => {});
  setSessionExpired(true);
}
