# Public API

No authentication. Conventions (money as strings, error shape) are in [API
conventions](/api/).

## `GET /health`

Liveness only — deliberately thin, and hit constantly by the deployment
platform. Does not touch Postgres, so a brief database blip does not cascade
into a restart loop.

```json
{ "ok": true, "service": "crypto-gateway", "uptime_s": 3123 }
```

## `GET /public/payments/:publicId`

The public status view — no merchant data (no `client_id`, no derivation
index, no rate internals). Polled by the checkout SPA. Same fields as
`GET /api/payments/:publicId` in [Merchant API](/api/merchant), minus the
merchant scoping.

**Errors:** `404 { "error": "not_found" }`.

## `GET /public/payments/:publicId/checkout`

One-shot checkout payload: the public view plus everything needed to render
the QR and deep link. See [Checkout](/guides/checkout) for how `payment_uri`
and `wallet_uri` differ by chain family.

```json
{
  "payment": { "id": "abc123defg4567", "status": "pending", "...": "..." },
  "payment_uri": "ethereum:0xUSDC@84532/transfer?address=0x...&uint256=12195121",
  "wallet_uri": "ethereum:0xUSDC@84532/transfer?address=0x...&uint256=12195121",
  "qr_data_url": "data:image/png;base64,...",
  "decimals": 6,
  "family": "evm",
  "quote_ttl_sec": 900,
  "grace_ttl_sec": 5400
}
```

`wallet_uri` is `null` on Tron (`family: "tron"`) — Tron has no wallet-agreed
deep-link standard, so `payment_uri` there is the bare Base58 address instead
of a URI.

**Errors:** `404 { "error": "not_found" }`.

## `POST /public/payments/:publicId/check`

On-demand chain check — the payer's "I already paid, look now" button,
instead of the gateway polling every open payment continuously. See
[Checkout](/guides/checkout#i-already-paid-on-demand-check) for exactly when
it reaches the chain (Tron only, active statuses only, 10-second cooldown per
payment).

```json
{
  "payment": { "id": "abc123defg4567", "status": "detecting", "...": "..." },
  "checked": true,
  "cooldown_ms": 10000
}
```

`checked` tells you whether this call actually scanned the chain; the
`payment` status is always current regardless. `cooldown_ms` is the remaining
wait when a call is skipped for being too soon.

**Errors:** `404 { "error": "not_found" }`.
