/**
 * Operator accounts and console sessions for /admin.
 *
 * The console used to be one shared HTTP Basic credential: it kept the surface
 * off the open internet but could not say *who* looked, and revoking access meant
 * changing the password for everyone at once. This replaces it with named
 * accounts in `admin_users` and server-side sessions in `admin_sessions`.
 *
 * Two properties the storage is chosen for:
 *
 *  - **Passwords are argon2id, never a bare digest.** SHA-256 is right for an
 *    API key (a 24-byte random string is not guessable) and wrong for a password
 *    (an unsalted digest of one is a rainbow-table lookup away from the
 *    plaintext). Bun's defaults are m=64MiB, t=2, p=1 — above the OWASP minimum
 *    — which costs ~100ms per login and nothing anywhere else.
 *  - **The cookie holds a random token; the row holds its SHA-256.** A database
 *    dump therefore cannot be replayed as a signed-in browser, and because the
 *    session is a row rather than a signed stateless token, deleting it actually
 *    ends the session.
 *
 * `ADMIN_PASSWORD` stays the way in: `bootstrapOperator()` keeps one account —
 * `ADMIN_USER`, default `admin` — in step with it on every boot. That is what
 * makes the environment a recovery path for a deployment nobody can sign in to,
 * and it is why the preflight still refuses to start production without it.
 */
import { and, eq, gt, lt, sql as raw } from "drizzle-orm";
import { db, schema } from "../db";
import { env } from "../config";
import { count, getLogger } from "../observability";

const log = getLogger("admin-auth");

export type Operator = typeof schema.adminUsers.$inferSelect;

/** Name of the session cookie. Scoped to /admin by the route layer. */
export const SESSION_COOKIE = "gw_console_session";

const SESSION_TOKEN_BYTES = 32;
const MAX_USERNAME_LENGTH = 64;
/** Long enough that a truncated paste cannot become a working password. */
const MIN_PASSWORD_LENGTH = 8;

const sessionTtlMs = () => Math.max(env.adminSessionTtlHours, 1) * 3600_000;

/**
 * Whether operator sign-in is enforced at all.
 *
 * Unset `ADMIN_PASSWORD` leaves the console open, exactly as it was before this
 * module existed — no account exists to sign in as, so demanding one would lock
 * local development out of its own console. Production cannot reach this state:
 * the preflight refuses to boot without the variable.
 */
export const authEnabled = () => Boolean(env.adminPassword);

/** Usernames are matched as stored, so they are stored one way. */
export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase().slice(0, MAX_USERNAME_LENGTH);
}

async function sha256Hex(value: string): Promise<string> {
  return Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  ).toString("hex");
}

/**
 * A hash to verify against when the username does not exist.
 *
 * Without it, an unknown username answers in microseconds and a known one takes
 * an argon2id verification — a timing side channel that turns the login form
 * into a "does this operator exist?" oracle. Computed once, lazily, so a process
 * that never sees a failed login never pays for it.
 */
let decoyHash: Promise<string> | null = null;
function decoy(): Promise<string> {
  decoyHash ??= Bun.password.hash(crypto.randomUUID());
  return decoyHash;
}

/**
 * Creates the bootstrap operator, or brings its password back in step with the
 * environment. Idempotent, and safe to run on every boot.
 *
 * Rotating `ADMIN_PASSWORD` therefore rotates the account — which is the point:
 * it is the lever you have when the deployment is the thing you have locked
 * yourself out of. A rotation drops that operator's sessions, because a password
 * change that leaves the old browser signed in has not revoked anything.
 *
 * Returns the operator, or null when sign-in is disabled (no `ADMIN_PASSWORD`).
 */
export async function bootstrapOperator(): Promise<Operator | null> {
  if (!env.adminPassword) return null;

  const username = normalizeUsername(env.adminUser);
  const password = env.adminPassword;

  if (password.length < MIN_PASSWORD_LENGTH) {
    log.warn("ADMIN_PASSWORD is shorter than the minimum a login would accept", {
      "operator.username": username,
      "auth.min_password_length": MIN_PASSWORD_LENGTH,
    });
  }

  const [existing] = await db
    .select()
    .from(schema.adminUsers)
    .where(eq(schema.adminUsers.username, username));

  if (!existing) {
    const [created] = await db
      .insert(schema.adminUsers)
      .values({ username, passwordHash: await Bun.password.hash(password) })
      // Two processes booting against one database race here; the unique index
      // decides, and the loser reads the winner's row below.
      .onConflictDoNothing({ target: schema.adminUsers.username })
      .returning();

    if (created) {
      log.info("console operator created from the environment", {
        "operator.id": created.id,
        "operator.username": created.username,
      });
      return created;
    }
    const [raced] = await db
      .select()
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.username, username));
    return raced ?? null;
  }

  if (!(await Bun.password.verify(password, existing.passwordHash))) {
    const [updated] = await db
      .update(schema.adminUsers)
      .set({ passwordHash: await Bun.password.hash(password) })
      .where(eq(schema.adminUsers.id, existing.id))
      .returning();

    const revoked = await db
      .delete(schema.adminSessions)
      .where(eq(schema.adminSessions.userId, existing.id))
      .returning({ id: schema.adminSessions.id });

    log.warn("console operator password reset from ADMIN_PASSWORD — open sessions revoked", {
      "operator.id": existing.id,
      "operator.username": existing.username,
      "auth.sessions_revoked": revoked.length,
    });
    return updated ?? existing;
  }

  if (!existing.isActive) {
    // The bootstrap account is the recovery path; leaving it deactivated would
    // make ADMIN_PASSWORD a credential for an account that cannot sign in.
    const [reactivated] = await db
      .update(schema.adminUsers)
      .set({ isActive: true })
      .where(eq(schema.adminUsers.id, existing.id))
      .returning();
    log.warn("bootstrap console operator was deactivated — reactivated", {
      "operator.id": existing.id,
      "operator.username": existing.username,
    });
    return reactivated ?? existing;
  }

  log.debug("console operator present and in step with the environment", {
    "operator.id": existing.id,
    "operator.username": existing.username,
  });
  return existing;
}

export type AuthFailure = "unknown_user" | "bad_password" | "deactivated";

/**
 * Checks a username/password pair.
 *
 * The three failure reasons are for the log, never for the response: telling a
 * caller that the password was wrong rather than the user unknown is how a login
 * form becomes a user directory.
 */
export async function authenticate(
  username: string,
  password: string
): Promise<{ ok: true; user: Operator } | { ok: false; reason: AuthFailure }> {
  const [user] = await db
    .select()
    .from(schema.adminUsers)
    .where(eq(schema.adminUsers.username, normalizeUsername(username)));

  if (!user) {
    await Bun.password.verify(password, await decoy());
    return { ok: false, reason: "unknown_user" };
  }
  if (!(await Bun.password.verify(password, user.passwordHash))) {
    return { ok: false, reason: "bad_password" };
  }
  // Checked after the password so a deactivated account is not distinguishable
  // from a wrong password by how long the answer takes.
  if (!user.isActive) return { ok: false, reason: "deactivated" };

  return { ok: true, user };
}

/**
 * Opens a session and returns the token to put in the cookie.
 *
 * The token is returned exactly once, here — nothing stores or logs it, so a
 * session can be revoked but never recovered.
 */
export async function createSession(
  userId: string,
  meta: { ip?: string | null; userAgent?: string | null } = {}
): Promise<{ token: string; expiresAt: Date }> {
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(SESSION_TOKEN_BYTES))).toString(
    "base64url"
  );
  const expiresAt = new Date(Date.now() + sessionTtlMs());

  await db.insert(schema.adminSessions).values({
    userId,
    tokenHash: await sha256Hex(token),
    expiresAt,
    ipAddress: meta.ip ?? null,
    userAgent: meta.userAgent?.slice(0, 300) ?? null,
  });

  await db
    .update(schema.adminUsers)
    .set({ lastLoginAt: new Date() })
    .where(eq(schema.adminUsers.id, userId));

  return { token, expiresAt };
}

/**
 * Resolves a cookie token to its operator, or null for anything that is not a
 * live session: unknown token, expired row, deactivated account.
 *
 * Expiry is enforced in the WHERE clause rather than in JavaScript, so a clock
 * or a code path cannot be talked into accepting a stale row. The window slides:
 * a session in continuous use is extended once it is past halfway, which keeps
 * an operator watching a payment settle from being signed out mid-incident
 * without turning every request into a write.
 */
export async function resolveSession(
  token: string
): Promise<{ user: Operator; expiresAt: Date } | null> {
  if (!token) return null;
  const tokenHash = await sha256Hex(token);

  const [row] = await db
    .select({ session: schema.adminSessions, user: schema.adminUsers })
    .from(schema.adminSessions)
    .innerJoin(schema.adminUsers, eq(schema.adminUsers.id, schema.adminSessions.userId))
    .where(
      and(
        eq(schema.adminSessions.tokenHash, tokenHash),
        gt(schema.adminSessions.expiresAt, new Date())
      )
    );

  if (!row) return null;
  if (!row.user.isActive) {
    // Deactivating an operator has to end their session too, not wait for it to
    // lapse.
    await db.delete(schema.adminSessions).where(eq(schema.adminSessions.id, row.session.id));
    count("admin.auth.rejected", { reason: "deactivated" });
    return null;
  }

  const ttl = sessionTtlMs();
  let expiresAt = row.session.expiresAt;
  if (expiresAt.getTime() - Date.now() < ttl / 2) {
    expiresAt = new Date(Date.now() + ttl);
    await db
      .update(schema.adminSessions)
      .set({ expiresAt, lastSeenAt: new Date() })
      .where(eq(schema.adminSessions.id, row.session.id));
  }

  return { user: row.user, expiresAt };
}

/** Ends one session. Silent when the token is already unknown — logout is idempotent. */
export async function revokeSession(token: string): Promise<void> {
  if (!token) return;
  await db
    .delete(schema.adminSessions)
    .where(eq(schema.adminSessions.tokenHash, await sha256Hex(token)));
}

/**
 * Drops sessions that can no longer authenticate anyone. Called after a
 * successful login, which is both the cheapest moment to pay for it and the only
 * one that reliably happens on a console nobody is using.
 */
export async function sweepExpiredSessions(): Promise<number> {
  const gone = await db
    .delete(schema.adminSessions)
    .where(lt(schema.adminSessions.expiresAt, new Date()))
    .returning({ id: schema.adminSessions.id });
  if (gone.length) log.debug("expired console sessions swept", { "auth.sessions_deleted": gone.length });
  return gone.length;
}

/** Live session count per operator, for the console's Users view. */
export async function activeSessionCounts(): Promise<Map<string, number>> {
  const rows = await db
    .select({
      userId: schema.adminSessions.userId,
      n: raw<number>`count(*)::int`,
    })
    .from(schema.adminSessions)
    .where(gt(schema.adminSessions.expiresAt, new Date()))
    .groupBy(schema.adminSessions.userId);
  return new Map(rows.map((r) => [r.userId, Number(r.n)]));
}
