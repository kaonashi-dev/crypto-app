import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { db, schema } from "../db";
import { getLogger, count, observe, safeUrl, fingerprint, traceparent } from "../observability";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const log = getLogger("webhooks");

/** Retry ceiling — must match the `attempts < 8` filter in the query below. */
const MAX_ATTEMPTS = 8;

export async function enqueueWebhook(tx: Tx, payment: any, event: string) {
  const payload = JSON.stringify({
    event,
    payment: publicPaymentView(payment),
    timestamp: new Date().toISOString(),
  });
  await tx.insert(schema.webhookJobs).values({
    clientId: payment.clientId,
    paymentId: payment.id,
    event,
    payload,
  });
  count("webhooks.enqueued", { event });
  log.info("webhook enqueued", {
    "webhook.event": event,
    "payment.id": payment.publicId ?? payment.id,
    "client.id": payment.clientId,
    "webhook.payload_bytes": payload.length,
  });
}

export function publicPaymentView(p: any) {
  return {
    id: p.publicId ?? p.id,
    status: p.status,
    amount_cop: p.amountCop?.toString(),
    asset: p.asset,
    network: p.network,
    amount_crypto_raw: p.amountCryptoRaw?.toString(),
    confirmed_raw: p.confirmedRaw?.toString(),
    overpaid_raw: p.overpaidRaw?.toString(),
    address: p.address,
    quote_expires_at: p.quoteExpiresAt,
    grace_expires_at: p.graceExpiresAt,
    paid_at: p.paidAt ?? null,
    metadata: p.metadata ? JSON.parse(p.metadata) : null,
  };
}

async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Buffer.from(sig).toString("hex");
}

/** Worker: processes the pending webhook queue. */
export async function deliverPendingWebhooks() {
  const jobs = await db
    .select({
      job: schema.webhookJobs,
      webhookUrl: schema.clients.webhookUrl,
      secret: schema.clients.webhookSecret,
    })
    .from(schema.webhookJobs)
    .innerJoin(schema.clients, eq(schema.clients.id, schema.webhookJobs.clientId))
    .where(
      and(
        isNull(schema.webhookJobs.deliveredAt),
        lte(schema.webhookJobs.nextAttemptAt, new Date()),
        sql`${schema.webhookJobs.attempts} < ${MAX_ATTEMPTS}`
      )
    )
    .limit(20);

  if (jobs.length === 0) {
    log.trace("webhook queue empty");
    return;
  }
  log.debug("webhook batch picked up", { "webhook.batch_size": jobs.length });

  for (const { job, webhookUrl, secret } of jobs) {
    const base = {
      "webhook.job_id": job.id,
      "webhook.event": job.event,
      "client.id": job.clientId,
      "webhook.attempt": job.attempts + 1,
    };

    if (!webhookUrl) {
      // No URL configured for this merchant: mark delivered so we don't retry forever.
      await db
        .update(schema.webhookJobs)
        .set({ deliveredAt: new Date() })
        .where(eq(schema.webhookJobs.id, job.id));
      count("webhooks.skipped", { reason: "no_url" });
      log.info("webhook dropped — merchant has no webhook_url", base);
      continue;
    }

    const host = (() => {
      try {
        return new URL(webhookUrl).host;
      } catch {
        return "invalid-url";
      }
    })();
    const started = performance.now();

    try {
      const signature = await sign(secret, job.payload);
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Gateway-Signature": signature,
          // Lets the merchant's own logs join this delivery to the payment
          // trace on our side.
          ...(traceparent() ? { traceparent: traceparent()! } : {}),
        },
        body: job.payload,
        signal: AbortSignal.timeout(10_000),
      });
      const ms = performance.now() - started;
      observe("webhooks.duration", ms, { host });
      count("http.client.requests", { host, status: res.status });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      await db
        .update(schema.webhookJobs)
        .set({ deliveredAt: new Date() })
        .where(eq(schema.webhookJobs.id, job.id));

      count("webhooks.delivered", { event: job.event });
      log.info("webhook delivered", {
        ...base,
        "url.full": safeUrl(webhookUrl),
        "server.address": host,
        "http.response.status_code": res.status,
        // The signature is what the merchant verifies; a fingerprint is enough
        // to match our line against theirs without handing it out.
        "webhook.signature_fingerprint": fingerprint(signature),
        duration_ms: Math.round(ms),
      });
    } catch (e) {
      const attempts = job.attempts + 1;
      const backoffMs = Math.min(2 ** attempts * 5_000, 30 * 60_000); // 10s -> 20s -> ... -> 30min
      const nextAttemptAt = new Date(Date.now() + backoffMs);
      await db
        .update(schema.webhookJobs)
        .set({ attempts, nextAttemptAt })
        .where(eq(schema.webhookJobs.id, job.id));

      count("webhooks.failed", { event: job.event });
      const dead = attempts >= MAX_ATTEMPTS;
      const detail = {
        ...base,
        "url.full": safeUrl(webhookUrl),
        "server.address": host,
        "webhook.attempts": attempts,
        "webhook.max_attempts": MAX_ATTEMPTS,
        "webhook.next_attempt_at": nextAttemptAt,
        "webhook.backoff_s": Math.round(backoffMs / 1000),
        duration_ms: Math.round(performance.now() - started),
        err: e,
      };
      // The last failure is a dead letter — nothing retries it, so it is an
      // error, not another warning in a series.
      if (dead) {
        count("webhooks.dead");
        log.error("webhook dead-lettered — retries exhausted", detail);
      } else {
        log.warn("webhook delivery failed — will retry", detail);
      }
    }
  }
}
