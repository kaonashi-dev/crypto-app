# Merchant API

Every route requires [`X-Api-Key`](/guides/authentication). Conventions
(money as strings, error shape, ids) are in [API conventions](/api/).

## `POST /api/payments`

Creates a payment: freezes a COP→crypto quote and derives a unique receiving
address.

**Body** (`createPaymentSchema`, `src/api/http.ts`):

| Field | Type | Notes |
|---|---|---|
| `amount_cop` | string or number → positive `bigint` | minimum 1,000 |
| `asset` | enum (`ASSETS`) | e.g. `USDC`, `USDT`, `BNB`, `POL`, `TRX` |
| `network` | enum (`NETWORK_IDS`) | e.g. `base-sepolia`, `tron-nile` |
| `metadata` | any JSON value | optional; echoed back verbatim |

**Response `201`:**

```json
{
  "id": "abc123defg4567",
  "status": "pending",
  "amount_cop": "50000",
  "asset": "USDC",
  "network": "base-sepolia",
  "amount_crypto_raw": "12195121",
  "confirmed_raw": "0",
  "overpaid_raw": "0",
  "address": "0x...",
  "quote_expires_at": "2026-08-08T05:15:00.000Z",
  "grace_expires_at": null,
  "paid_at": null,
  "metadata": { "order_id": "ORD-001" },
  "checkout_url": "http://localhost:3000/pay/abc123defg4567"
}
```

**Errors:** `400 bad_request` (invalid JSON body, or a schema violation —
`details` is the raw Zod issue list); `400 cannot_create_payment` (a valid
shape but an unsupported asset/network *pairing*, or below the 1,000 COP
minimum — `details` is the rejection message). See [Networks &
assets](/guides/networks-and-assets) for which pairings exist.

## `GET /api/payments/:publicId`

The same body `POST /api/payments` returns, minus `checkout_url` — the same
view a webhook carries. Scoped to the caller's own payments.

**Errors:** `404 not_found` — unknown id, or a `publicId` belonging to
another merchant (deliberately indistinguishable).

## `GET /api/payments/:publicId/status`

A poll-shaped view for a backend loop:

```json
{
  "id": "abc123defg4567",
  "status": "detecting",
  "terminal": false,
  "asset": "USDC",
  "network": "base-sepolia",
  "decimals": 6,
  "amount_cop": "50000",
  "amount_crypto_raw": "12195121",
  "confirmed_raw": "0",
  "pending_raw": "12195121",
  "overpaid_raw": "0",
  "quote_expires_at": "2026-08-08T05:15:00.000Z",
  "grace_expires_at": "2026-08-08T06:30:00.000Z",
  "paid_at": null
}
```

`decimals` is read from the registry for this exact (network, asset) pairing.
`terminal` is `true` once `status` is one of `paid`, `expired`,
`underpaid_expired` — poll until then, without hardcoding the status enum.

**Errors:** `404 not_found`, same rule as above.

## `GET /api/me`

```json
{ "name": "Cliente Demo", "balance_cop": "150000" }
```

The merchant's display name and its credited COP balance (a string).
