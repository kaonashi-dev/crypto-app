# API conventions

These hold across every route in [Merchant API](/api/merchant), [Public
API](/api/public), and [Console API](/api/console).

## Money is always a string

Every amount is a `bigint` internally and a **string** on the wire —
`amount_cop`, `amount_crypto_raw`, `confirmed_raw`, `pending_raw`,
`overpaid_raw`, `balance_cop`, and every console equivalent
(`fee_raw`, `threshold_raw`, …). JSON numbers cannot carry an 18-decimal token
amount without silently losing precision, so bigints are never emitted bare.

- `amount_cop` — Colombian pesos, which have **no decimal places**.
- Crypto amounts are in the asset's **smallest unit** (raw). Decimals are a
  property of the *(network, asset) pairing*, never the symbol — USDC is 6
  decimals on Polygon and 18 on BSC. Read `decimals` from the response you're
  looking at (e.g. `GET /api/payments/:publicId/status`), never assume 6. See
  [Networks & assets](/guides/networks-and-assets).

## Identifiers

- **`publicId`** (a short, URL-safe id, e.g. `abc123defg4567`) is what every
  merchant- and payer-facing route addresses a payment by — it appears as `id`
  in every payment JSON body and as `:publicId` in the URL. It is never the
  database `uuid`.
- The console additionally exposes the internal `uuid` on some detail views
  (e.g. `GET /admin/api/payments/:publicId` → `payment.uuid`), since it also
  joins across deposits, webhook jobs, and ledger entries by that key.
- Merchant `client_id` is a Postgres `uuid`.

## Errors

Every error response is `{ "error": "<machine-readable code>" }`, sometimes
with a `details` field carrying more (a string, or an array of Zod issues).
There is no separate "error object" shape — the top-level body *is* the
error. Full status-code-by-status-code reference: [Errors](/api/errors).

A `404 { "error": "not_found" }` is also the answer for "this exists, but not
for you" — a merchant's own payment lookup returns the same 404 for someone
else's `publicId` as for an id that never existed, so the endpoint is never an
oracle for which ids exist.

Every response carries an `x-trace-id` header; a `500` also echoes it in the
body (`trace_id`) so a failure can be found in `GET /admin/api/logs`.

## Idempotency of deposits

An on-chain transfer is recorded at most once, keyed by
`(network, txHash, logIndex)` (`logIndex` is `-1` for a native-coin transfer,
which has no log at all). The same transfer seen twice — by the live
WebSocket and a backfill sweep, or by a repeated Tron poll — inserts nothing
the second time (`ON CONFLICT DO NOTHING`) and is logged as a duplicate. This
is enforced by `registerDeposit` in `src/services/payments.ts`, not by any
API route; it applies uniformly no matter which watcher observed the
transfer.

## Authentication

Three separate schemes, none of which overlap:

| Surface | Scheme | Details |
|---|---|---|
| `/api/*` | `X-Api-Key` header | [Authentication](/guides/authentication) |
| `/public/*`, `/health`, `/pay/:publicId` | none | open by design |
| `/admin/api/*` | session cookie | [Console API](/api/console) |
