import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { db, schema } from "../db";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

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
        sql`${schema.webhookJobs.attempts} < 8`
      )
    )
    .limit(20);

  for (const { job, webhookUrl, secret } of jobs) {
    if (!webhookUrl) {
      // No URL configured for this merchant: mark delivered so we don't retry forever.
      await db
        .update(schema.webhookJobs)
        .set({ deliveredAt: new Date() })
        .where(eq(schema.webhookJobs.id, job.id));
      continue;
    }
    try {
      const signature = await sign(secret, job.payload);
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Gateway-Signature": signature,
        },
        body: job.payload,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await db
        .update(schema.webhookJobs)
        .set({ deliveredAt: new Date() })
        .where(eq(schema.webhookJobs.id, job.id));
    } catch {
      const attempts = job.attempts + 1;
      const backoffMs = Math.min(2 ** attempts * 5_000, 30 * 60_000); // 10s -> 20s -> ... -> 30min
      await db
        .update(schema.webhookJobs)
        .set({ attempts, nextAttemptAt: new Date(Date.now() + backoffMs) })
        .where(eq(schema.webhookJobs.id, job.id));
    }
  }
}
