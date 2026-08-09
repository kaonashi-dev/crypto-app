# Payments

Four merchant-facing routes, all behind [`X-Api-Key`](/guides/authentication).
Field-by-field reference: [API → Merchant API](/api/merchant).

## Create a payment

```bash
curl -s -X POST http://localhost:3000/api/payments \
  -H "X-Api-Key: gk_test_..." -H "Content-Type: application/json" \
  -d '{"amount_cop": 50000, "asset": "USDC", "network": "base-sepolia",
       "metadata": {"order_id": "ORD-001"}}'
```

The request body (`createPaymentSchema` in `src/api/http.ts`):

| Field | Type | Notes |
|---|---|---|
| `amount_cop` | string or number, coerced to a positive `bigint` | COP has no decimals; minimum 1,000 |
| `asset` | one of `ASSETS` | every quotable symbol across served networks — see [Networks & assets](/guides/networks-and-assets) |
| `network` | one of `NETWORK_IDS` | the served networks (testnets, plus mainnets if `ENABLE_MAINNETS` is set) |
| `metadata` | any JSON value | optional; free-form, echoed back on every read and in webhooks (e.g. `order_id`) |

The `asset`/`network` enums alone don't guarantee the *pairing* exists (e.g.
`USDT` on `polygon-amoy` does not) — an invalid combination is rejected by
`createPayment` at 400 with `cannot_create_payment`, not by the schema.

On success (`201`), the gateway freezes a COP→crypto quote (market rate plus
spread, valid `QUOTE_TTL_MINUTES` — 15 by default) and derives a unique HD
address for the payment. The response is the same shape `GET
/api/payments/:publicId` returns, plus `checkout_url`.

## Get a payment

```bash
curl -s http://localhost:3000/api/payments/<publicId> -H "X-Api-Key: gk_test_..."
```

Returns the same view a webhook carries — status, amounts, `metadata`,
receiving `address` — scoped to the caller's own payments (`404` for anyone
else's, same as an unknown id).

## Poll status

```bash
curl -s http://localhost:3000/api/payments/<publicId>/status -H "X-Api-Key: gk_test_..."
```

A thinner, poll-shaped view meant for a backend loop: it adds `decimals` (so
raw amounts format without a second lookup) and `terminal` (`true` once
`status` is `paid`, `expired`, or `underpaid_expired`), so the poller can stop
without hardcoding which members of the status enum are ends.

## Money and amounts

Every amount is a `bigint` in the **smallest unit**, serialized as a **string**
on the wire (JSON numbers cannot carry an 18-decimal amount without losing
digits): `amount_cop`, `amount_crypto_raw`, `confirmed_raw`, `pending_raw`,
`overpaid_raw`. Decimals are a property of the (network, asset) *pairing*, not
of the symbol — read them from `decimals` on the status response, never
assume 6. See [Networks & assets](/guides/networks-and-assets).

## Payment state machine

`pending → detecting → partially_paid → paid`, with branches `expired` (quote
lapsed with no funds) and `underpaid_expired` (grace lapsed while partial).
The full lifecycle — quote freeze, watcher/confirmer, dust tolerance, partial
payments — is documented in [Architecture → Payment
lifecycle](/architecture/payment-lifecycle).

## Your account

```bash
curl -s http://localhost:3000/api/me -H "X-Api-Key: gk_test_..."
```

Returns `name` and the credited `balance_cop` (a string).
