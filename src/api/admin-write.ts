/**
 * The console's write surface: merchant CRUD, credential rotation, and payments
 * issued by an operator.
 *
 * Deliberately a separate file from ./admin.ts. That one opens by promising every
 * route in it is a SELECT and that nothing there can corrupt a payment no matter
 * what it is asked to render — a promise worth more than keeping related handlers
 * next to each other, and one that a single POST added "just here" would quietly
 * void.
 *
 * Every route below satisfies three conditions, and none of them are optional:
 *
 *  1. `requireOperator` — a named, signed-in operator. An open console (no
 *     `ADMIN_PASSWORD`) is refused outright, because a change nobody can be
 *     attributed for is exactly what `AGENTS.md` rules out.
 *  2. An `admin_audit_log` row, written **inside the mutation's transaction**, so
 *     a committed change cannot exist without its record. The one exception is
 *     documented on `recordDetachedAudit` in services/audit.ts.
 *  3. No secret is returned twice. An API key and a webhook secret appear in the
 *     response to the call that generated them, and in nothing else — not a
 *     subsequent read, not the audit row, not a log attribute.
 *
 * The guard is attached per route rather than with `use("*")`. Both routers mount
 * at `/admin/api`, and a wildcard middleware registered on this one matches by
 * path, not by which router ends up answering — so a `use("*")` here would sit in
 * front of the read routes too and refuse them whenever the console runs open.
 * Naming the guard on each route costs a line and makes it visible at every
 * mutation, which is where you want to be able to see it.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import { and, count as countRows, eq } from "drizzle-orm";
import { db, schema } from "../db";
import { env, type NetworkId } from "../config";
import { createPayment } from "../services/payments";
import { publicPaymentView } from "../services/webhooks";
import { recordAudit, recordDetachedAudit } from "../services/audit";
import {
  apiKeyHashPrefix,
  hashApiKey,
  newApiKey,
  newWebhookSecret,
} from "../services/merchants";
import { requireOperator } from "./admin-auth";
import { createPaymentSchema, originSource, publicOrigin } from "./http";
import { count, getLogger } from "../observability";

export const adminWriteApi = new Hono();

const log = getLogger("admin-write");

const NAME_MAX = 120;
const URL_MAX = 2048;

/** bigint -> decimal string, as everywhere else on this wire. */
const s = (v: bigint | null | undefined): string | null => (v == null ? null : v.toString());

// -- Webhook URL policy ------------------------------------------------
/**
 * Whether a hostname names something on the gateway's own side of the network.
 *
 * This matters more than it looks. `deliverPendingWebhooks` POSTs merchant JSON
 * to whatever is stored in `clients.webhook_url`, and until this file existed only
 * a shell script could put a value there. A console text field turns that into
 * server-side request forgery reach: `169.254.169.254` is the cloud instance
 * metadata endpoint on every major provider, and a webhook aimed at it would have
 * the gateway fetch its own credentials and report the result as a delivery
 * failure — with the body in the log.
 *
 * **This is a guard, not a proof.** It blocks the literal forms; it does not
 * survive a hostname that resolves to a private address, which only a
 * resolve-then-pin check inside the deliverer would catch. It is the cheap half,
 * and the expensive half is not built here.
 */
function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1") return true;
  if (/^fe80:/.test(h)) return true; // IPv6 link-local
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // IPv6 unique-local

  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) {
    const [a, b] = h.split(".").map(Number) as [number, number, number, number];
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 169 && b === 254) return true; // link-local / instance metadata
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }
  return false;
}

/** Returns the rejection reason, or null when the URL is acceptable. */
function webhookUrlProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "must be an absolute URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "must be http:// or https://";
  }
  // Development is expected to point at localhost or a tunnel; production is not,
  // and the two failure modes are different enough to be worth separating.
  if (env.isProduction) {
    if (url.protocol !== "https:") return "must be https:// in production";
    if (isPrivateHost(url.hostname)) {
      return "must not be a loopback, link-local or private-range address";
    }
  }
  return null;
}

// -- Shared shapes -----------------------------------------------------

const nameField = z.string().trim().min(1).max(NAME_MAX);
// `.nullable().optional()` rather than `.optional()`: absent means "leave it
// alone" and an explicit null means "clear it", and a PATCH has to tell them
// apart.
const webhookUrlField = z.string().trim().max(URL_MAX).nullable().optional();

const merchantView = (row: typeof schema.clients.$inferSelect) => ({
  id: row.id,
  name: row.name,
  balance_cop: s(row.balanceCop),
  webhook_url: row.webhookUrl,
  is_active: row.isActive,
  created_at: row.createdAt,
  // The handle `src/api/auth.ts` logs on a rejected key, so an operator can match
  // a 401 in the log tail to the merchant it was aimed at. Not replayable.
  api_key_hash_prefix: apiKeyHashPrefix(row.apiKeyHash),
});

/** Reads a JSON body, reporting a parse failure rather than throwing. */
async function readJson(c: Context) {
  try {
    return { ok: true as const, raw: (await c.req.json()) as unknown };
  } catch {
    return { ok: false as const };
  }
}

/** Who made the request, as far as the audit row is concerned. */
const requestMeta = (c: Context) => ({
  ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
  userAgent: c.req.header("user-agent") ?? null,
});

const FOREIGN_KEY_VIOLATION = "23503";

/**
 * Whether an error is Postgres refusing to orphan a row.
 *
 * The SQLSTATE is not on the error drizzle throws: it wraps the driver's error in
 * its own `Failed query: …` and hangs the original off `cause`. That wrapping is
 * drizzle's business rather than a contract, so the chain is walked instead of the
 * one level being assumed — a delete that answered 500 instead of 409 would tell
 * an operator the console is broken when it is in fact working exactly as designed.
 */
function isForeignKeyViolation(e: unknown): boolean {
  for (let err = e as { code?: string; cause?: unknown } | undefined, depth = 0; err && depth < 5; depth++) {
    if (err.code === FOREIGN_KEY_VIOLATION) return true;
    err = err.cause as { code?: string; cause?: unknown } | undefined;
  }
  return false;
}

/** How many rows point at this merchant — the answer a refused delete owes. */
async function merchantReferences(clientId: string) {
  const [payments, ledger, webhooks] = await Promise.all([
    db.select({ n: countRows() }).from(schema.payments).where(eq(schema.payments.clientId, clientId)),
    db
      .select({ n: countRows() })
      .from(schema.ledgerEntries)
      .where(eq(schema.ledgerEntries.clientId, clientId)),
    db
      .select({ n: countRows() })
      .from(schema.webhookJobs)
      .where(eq(schema.webhookJobs.clientId, clientId)),
  ]);
  return {
    payments: Number(payments[0]?.n ?? 0),
    ledger_entries: Number(ledger[0]?.n ?? 0),
    webhook_jobs: Number(webhooks[0]?.n ?? 0),
  };
}

// -- POST /admin/api/clients -------------------------------------------
// Create a merchant. This is the only place in the system that returns a webhook
// secret at all: scripts/seed.ts prints the API key and never the secret, which
// left a merchant provisioned by this repository with no way to verify the
// signature on its own webhooks.
const createMerchantSchema = z.object({
  name: nameField,
  webhook_url: webhookUrlField,
});

adminWriteApi.post("/clients", requireOperator, async (c) => {
  const operator = c.get("operator")!;
  const body = await readJson(c);
  if (!body.ok) return c.json({ error: "bad_request", details: "invalid JSON body" }, 400);

  const parsed = createMerchantSchema.safeParse(body.raw);
  if (!parsed.success) {
    return c.json({ error: "bad_request", details: parsed.error.issues }, 400);
  }

  const webhookUrl = parsed.data.webhook_url?.trim() || null;
  if (webhookUrl) {
    const problem = webhookUrlProblem(webhookUrl);
    if (problem) return c.json({ error: "bad_request", details: `webhook_url ${problem}` }, 400);
  }

  const apiKey = newApiKey();
  const webhookSecret = newWebhookSecret();
  const apiKeyHash = await hashApiKey(apiKey);

  const created = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(schema.clients)
      .values({
        name: parsed.data.name,
        apiKeyHash,
        webhookSecret,
        webhookUrl,
      })
      .returning();

    await recordAudit(tx, {
      operator,
      action: "merchant.create",
      targetType: "client",
      targetId: row!.id,
      // Hand-built: a spread of `row` would put the key hash and the webhook
      // secret into a table that is never deleted from.
      detail: {
        name: row!.name,
        webhook_url: row!.webhookUrl,
        api_key_hash_prefix: apiKeyHashPrefix(apiKeyHash),
      },
      ...requestMeta(c),
    });

    return row!;
  });

  count("merchants.created");
  log.info("merchant created from the console", {
    "client.id": created.id,
    "client.name": created.name,
    "client.api_key_hash_prefix": apiKeyHashPrefix(apiKeyHash),
    "client.has_webhook_url": Boolean(webhookUrl),
    "operator.username": operator.username,
  });

  // The only response that will ever carry these two values.
  return c.json(
    { client: merchantView(created), api_key: apiKey, webhook_secret: webhookSecret },
    201
  );
});

// -- PATCH /admin/api/clients/:id --------------------------------------
const updateMerchantSchema = z
  .object({
    name: nameField.optional(),
    webhook_url: webhookUrlField,
    is_active: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "no fields to update",
  });

adminWriteApi.patch("/clients/:id", requireOperator, async (c) => {
  const operator = c.get("operator")!;
  const id = c.req.param("id");

  const body = await readJson(c);
  if (!body.ok) return c.json({ error: "bad_request", details: "invalid JSON body" }, 400);

  const parsed = updateMerchantSchema.safeParse(body.raw);
  if (!parsed.success) {
    return c.json({ error: "bad_request", details: parsed.error.issues }, 400);
  }

  const { name, is_active: isActive } = parsed.data;
  const webhookUrlGiven = parsed.data.webhook_url !== undefined;
  const webhookUrl = parsed.data.webhook_url?.trim() || null;
  if (webhookUrlGiven && webhookUrl) {
    const problem = webhookUrlProblem(webhookUrl);
    if (problem) return c.json({ error: "bad_request", details: `webhook_url ${problem}` }, 400);
  }

  const result = await db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(schema.clients)
      .where(eq(schema.clients.id, id))
      .for("update");
    if (!before) return null;

    const [after] = await tx
      .update(schema.clients)
      .set({
        ...(name !== undefined ? { name } : {}),
        ...(webhookUrlGiven ? { webhookUrl } : {}),
        ...(isActive !== undefined ? { isActive } : {}),
      })
      .where(eq(schema.clients.id, id))
      .returning();

    // Deactivation is the change worth being able to filter the trail on, so it
    // gets its own action rather than hiding inside a diff.
    const deactivating = isActive === false && before.isActive;

    await recordAudit(tx, {
      operator,
      action: deactivating ? "merchant.deactivate" : "merchant.update",
      targetType: "client",
      targetId: id,
      detail: {
        before: { name: before.name, webhook_url: before.webhookUrl, is_active: before.isActive },
        after: { name: after!.name, webhook_url: after!.webhookUrl, is_active: after!.isActive },
      },
      ...requestMeta(c),
    });

    return after!;
  });

  if (!result) return c.json({ error: "not_found" }, 404);

  log.info("merchant updated from the console", {
    "client.id": result.id,
    "client.name": result.name,
    "client.is_active": result.isActive,
    "operator.username": operator.username,
  });

  return c.json({ client: merchantView(result) });
});

// -- POST /admin/api/clients/:id/api-key -------------------------------
// Rotation is immediate and has no overlap window: the previous key stops
// authenticating on the very next request. A dual-key grace period is the obvious
// follow-up and is deliberately not built here — it needs a second column and an
// expiry, and inventing half of it would leave a key that looks revoked and is not.
adminWriteApi.post("/clients/:id/api-key", requireOperator, async (c) => {
  const operator = c.get("operator")!;
  const id = c.req.param("id");

  const apiKey = newApiKey();
  const apiKeyHash = await hashApiKey(apiKey);

  const result = await db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(schema.clients)
      .where(eq(schema.clients.id, id))
      .for("update");
    if (!before) return null;

    const [after] = await tx
      .update(schema.clients)
      .set({ apiKeyHash })
      .where(eq(schema.clients.id, id))
      .returning();

    await recordAudit(tx, {
      operator,
      action: "merchant.api_key.rotate",
      targetType: "client",
      targetId: id,
      // Prefixes of the hashes, which is what makes the rotation traceable in the
      // log tail without the row ever holding something usable.
      detail: {
        from_hash_prefix: apiKeyHashPrefix(before.apiKeyHash),
        to_hash_prefix: apiKeyHashPrefix(apiKeyHash),
      },
      ...requestMeta(c),
    });

    return after!;
  });

  if (!result) return c.json({ error: "not_found" }, 404);

  count("merchants.api_key_rotated");
  log.warn("merchant API key rotated — the previous key no longer authenticates", {
    "client.id": result.id,
    "client.name": result.name,
    "client.api_key_hash_prefix": apiKeyHashPrefix(apiKeyHash),
    "operator.username": operator.username,
  });

  return c.json({ client: merchantView(result), api_key: apiKey });
});

// -- POST /admin/api/clients/:id/webhook-secret ------------------------
// `deliverPendingWebhooks` joins `clients` and reads the secret at *delivery*
// time, not at enqueue time — so rotating here re-signs every job still sitting
// in the queue. That is a real consequence for a merchant mid-retry, and the
// console says so at the point of rotation.
adminWriteApi.post("/clients/:id/webhook-secret", requireOperator, async (c) => {
  const operator = c.get("operator")!;
  const id = c.req.param("id");
  const webhookSecret = newWebhookSecret();

  const result = await db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(schema.clients)
      .where(eq(schema.clients.id, id))
      .for("update");
    if (!before) return null;

    const [after] = await tx
      .update(schema.clients)
      .set({ webhookSecret })
      .where(eq(schema.clients.id, id))
      .returning();

    await recordAudit(tx, {
      operator,
      action: "merchant.webhook_secret.rotate",
      targetType: "client",
      targetId: id,
      detail: { rotated: true },
      ...requestMeta(c),
    });

    return after!;
  });

  if (!result) return c.json({ error: "not_found" }, 404);

  // How many deliveries are about to be signed with the new secret instead of the
  // one the merchant is currently verifying against.
  const [pending] = await db
    .select({ n: countRows() })
    .from(schema.webhookJobs)
    .where(and(eq(schema.webhookJobs.clientId, id), eq(schema.webhookJobs.attempts, 0)));

  count("merchants.webhook_secret_rotated");
  log.warn("merchant webhook secret rotated — queued deliveries will use the new one", {
    "client.id": result.id,
    "client.name": result.name,
    "webhook.jobs_affected": Number(pending?.n ?? 0),
    "operator.username": operator.username,
  });

  return c.json({ client: merchantView(result), webhook_secret: webhookSecret });
});

// -- DELETE /admin/api/clients/:id -------------------------------------
/**
 * Deactivates, or — with `?hard=true` and nothing pointing at it — deletes.
 *
 * Two things worth being explicit about:
 *
 * **Deactivating is not freezing.** `is_active: false` makes `apiKeyAuth` reject
 * the merchant's calls immediately. It does *not* stop the watchers settling
 * payments already on chain, or crediting `balance_cop` when they do: settlement
 * is event-sourced from Transfer logs and never consults merchant state. Funds in
 * flight land exactly as they would have.
 *
 * **The foreign key is the guarantee, not the counts.** The counts below are for
 * the message; the delete itself runs inside a transaction and lets Postgres
 * refuse it, because counting first and deleting second races a watcher inserting
 * a deposit in between. The audit rows survive either way — `target_id` is text
 * with no foreign key, so the record of a merchant's creation and deletion
 * outlives the merchant, which is the point of keeping it.
 */
adminWriteApi.delete("/clients/:id", requireOperator, async (c) => {
  const operator = c.get("operator")!;
  const id = c.req.param("id");
  const hard = c.req.query("hard") === "true";

  if (!hard) {
    const result = await db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(schema.clients)
        .where(eq(schema.clients.id, id))
        .for("update");
      if (!before) return null;

      const [after] = await tx
        .update(schema.clients)
        .set({ isActive: false })
        .where(eq(schema.clients.id, id))
        .returning();

      await recordAudit(tx, {
        operator,
        action: "merchant.deactivate",
        targetType: "client",
        targetId: id,
        detail: { name: before.name, was_active: before.isActive },
        ...requestMeta(c),
      });

      return after!;
    });

    if (!result) return c.json({ error: "not_found" }, 404);

    log.warn("merchant deactivated from the console — its API key no longer authenticates", {
      "client.id": result.id,
      "client.name": result.name,
      "operator.username": operator.username,
    });
    return c.json({ client: merchantView(result), deleted: false });
  }

  try {
    const deleted = await db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(schema.clients)
        .where(eq(schema.clients.id, id))
        .for("update");
      if (!before) return null;

      await tx.delete(schema.clients).where(eq(schema.clients.id, id));

      await recordAudit(tx, {
        operator,
        action: "merchant.delete",
        targetType: "client",
        targetId: id,
        detail: { name: before.name, webhook_url: before.webhookUrl },
        ...requestMeta(c),
      });

      return before;
    });

    if (!deleted) return c.json({ error: "not_found" }, 404);

    count("merchants.deleted");
    log.warn("merchant deleted from the console", {
      "client.id": deleted.id,
      "client.name": deleted.name,
      "operator.username": operator.username,
    });
    return c.json({ deleted: true, id });
  } catch (e) {
    // Something still references this merchant. Anything else is a real fault and
    // belongs in the error handler, not swallowed as a polite 409.
    if (!isForeignKeyViolation(e)) throw e;

    const counts = await merchantReferences(id);
    log.warn("merchant delete refused — rows still reference it", {
      "client.id": id,
      "client.payments": counts.payments,
      "client.ledger_entries": counts.ledger_entries,
      "client.webhook_jobs": counts.webhook_jobs,
      "operator.username": operator.username,
    });
    return c.json(
      {
        error: "merchant_in_use",
        details: "Deactivate it instead — deleting would remove settlement history.",
        counts,
      },
      409
    );
  }
});

// -- POST /admin/api/payments ------------------------------------------
/**
 * A payment created by an operator, on a merchant's behalf.
 *
 * Calls the same `createPayment()` the merchant API does, with the same request
 * schema and the same `checkout_url` construction (see ./http.ts), so the console
 * reproduces what a merchant integration would get rather than approximating it.
 *
 * Two costs this route has and the rest of the console does not:
 *
 *  - It **reaches a paid provider.** `createPayment` quotes through
 *    `getRateCopE6`, which is CoinGecko behind a cache. Every other
 *    `/admin/api/*` route is a Postgres SELECT or a cached chain read.
 *  - It **consumes an HD derivation index permanently**, and there is no delete
 *    for a payment. A misclick costs an index, not money.
 */
const consoleCreateSchema = createPaymentSchema.extend({
  client_id: z.string().uuid(),
});

adminWriteApi.post("/payments", requireOperator, async (c) => {
  const operator = c.get("operator")!;

  const body = await readJson(c);
  if (!body.ok) return c.json({ error: "bad_request", details: "invalid JSON body" }, 400);

  const parsed = consoleCreateSchema.safeParse(body.raw);
  if (!parsed.success) {
    return c.json({ error: "bad_request", details: parsed.error.issues }, 400);
  }

  const [client] = await db
    .select()
    .from(schema.clients)
    .where(eq(schema.clients.id, parsed.data.client_id));
  if (!client) return c.json({ error: "not_found", details: "no such merchant" }, 404);

  if (!client.isActive) {
    // A refusal on policy rather than a typo, so it is worth a row: "why was
    // nothing created" is a question the trail should answer.
    await recordDetachedAudit({
      operator,
      action: "payment.create",
      targetType: "client",
      targetId: client.id,
      outcome: "denied",
      detail: { reason: "merchant_inactive", amount_cop: parsed.data.amount_cop.toString() },
      ...requestMeta(c),
    });
    return c.json(
      { error: "merchant_inactive", details: "This merchant is deactivated." },
      409
    );
  }

  let payment;
  try {
    payment = await createPayment({
      clientId: client.id,
      amountCop: parsed.data.amount_cop,
      asset: parsed.data.asset,
      network: parsed.data.network as NetworkId,
      metadata: parsed.data.metadata,
    });
  } catch (e: any) {
    // createPayment already logged which rule refused it and why.
    log.warn("console payment not created", {
      "client.id": client.id,
      "operator.username": operator.username,
      err: e,
    });
    return c.json({ error: "cannot_create_payment", details: e.message }, 400);
  }

  await recordDetachedAudit({
    operator,
    action: "payment.create",
    targetType: "payment",
    targetId: payment.publicId,
    detail: {
      client_id: client.id,
      client_name: client.name,
      amount_cop: payment.amountCop.toString(),
      asset: payment.asset,
      network: payment.network,
      address: payment.address,
    },
    ...requestMeta(c),
  });

  const checkoutUrl = `${publicOrigin(c)}/pay/${payment.publicId}`;
  log.info("checkout issued from the console", {
    "payment.id": payment.publicId,
    "client.id": client.id,
    "url.full": checkoutUrl,
    "http.origin_source": originSource(c),
    "operator.username": operator.username,
  });

  return c.json({ ...publicPaymentView(payment), checkout_url: checkoutUrl }, 201);
});
