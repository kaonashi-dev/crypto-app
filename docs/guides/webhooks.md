# Webhooks

## Events

`src/services/webhooks.ts` enqueues one of four events, always from
`src/services/payments.ts`:

| Event | Enqueued when |
|---|---|
| `payment.paid` | confirmed sum reaches the settle threshold (required amount minus dust tolerance) |
| `payment.partially_paid` | a confirmation lands short of the threshold, the first time the payment goes partial |
| `payment.expired` | the quote window lapsed with zero funds received |
| `payment.underpaid_expired` | the grace window lapsed while still short — needs manual reconciliation |

## Configuring a URL

Set `webhook_url` on the merchant — via `POST /admin/api/clients` at creation,
or `PATCH /admin/api/clients/:id` (`null` clears it). With no URL configured,
jobs are marked delivered immediately rather than queued forever. In
production the URL must be `https://` and may not resolve to a loopback,
link-local, or private-range host by its literal form (`src/api/admin-write.ts`).

## Payload

```json
{
  "event": "payment.paid",
  "payment": {
    "id": "abc123...",
    "status": "paid",
    "amount_cop": "50000",
    "asset": "USDC",
    "network": "base-sepolia",
    "amount_crypto_raw": "12195121",
    "confirmed_raw": "12195121",
    "overpaid_raw": "0",
    "address": "0x...",
    "quote_expires_at": "2026-08-08T05:00:00.000Z",
    "grace_expires_at": "2026-08-08T06:15:00.000Z",
    "paid_at": "2026-08-08T05:03:11.000Z",
    "metadata": { "order_id": "ORD-001" }
  },
  "timestamp": "2026-08-08T05:03:12.000Z"
}
```

`payment` is `publicPaymentView()` — the same shape `GET
/api/payments/:publicId` returns. Amounts are strings; see
[Payments](/guides/payments).

## Signature

Every delivery carries `X-Gateway-Signature`: an HMAC-SHA256 of the **raw
request body**, hex-encoded, keyed with the client's `webhook_secret`
(`whsec_...` — see [Authentication](/guides/authentication) for how it is
minted and rotated).

**Node / Bun:**

```ts
import { createHmac, timingSafeEqual } from "crypto";

function verify(rawBody: string, signatureHeader: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

Verify against the **raw** body — parse-then-restringify JSON does not
reliably reproduce the exact bytes that were signed.

## Delivery and retries

`deliverPendingWebhooks` (a periodic worker, started from `src/index.ts`)
POSTs the payload with `Content-Type: application/json`,
`X-Gateway-Signature`, and — when present — the request's `traceparent`, so a
merchant's own tracing can join up with the gateway's. A non-2xx response or a
network error counts as a failure.

Failed deliveries retry with exponential backoff: `2^attempts * 5s`, capped at
30 minutes, up to **8 attempts** total. After the 8th failed attempt the job
is dead-lettered — nothing retries it further; `GET /admin/api/stats` and
`GET /admin/api/clients/:id` report pending/dead counts, and there is no
console re-queue action yet.

## Testing webhooks

Point `webhook_url` at [webhook.site](https://webhook.site) (or any request
bin) to see raw deliveries, including the signature header, before writing a
verifier.
