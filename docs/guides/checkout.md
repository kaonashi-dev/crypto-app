# Checkout

## The hosted page

`checkout_url` from `POST /api/payments` points at `/pay/:publicId` — the
built SolidJS SPA (`bun run build:web`; without it the route answers `503`).
It shows the QR code, the copyable receiving address, a countdown to the
quote/grace deadline, and polls the payment's public status every few seconds.

> The checkout UI (`web/src/checkout/`) is intentionally rendered in
> **Spanish** — it is end-user-facing copy for payers in the Colombian market.
> The `/admin` console is a separate, English, dark operator surface; see
> [Architecture → Console](/architecture/console).

## Checkout payload

The SPA (or your own client) fetches everything it needs from one endpoint —
see [API → Public API](/api/public) for the exact field list:

```bash
curl -s http://localhost:3000/public/payments/<publicId>/checkout
```

Two URIs come back, built by `buildCheckoutAssets` in `src/api/routes.ts`:

- **`payment_uri`** — what the QR code encodes. On EVM it is an
  [EIP-681](https://eips.ethereum.org/EIPS/eip-681) URI: a token payment
  targets the *contract* and calls `transfer` (`ethereum:<contract>@<chainId>/transfer?address=<addr>&uint256=<raw>`),
  while a native-coin payment targets the payee directly with a `value=`
  (`ethereum:<addr>@<chainId>?value=<raw>`) — a native payment addressed in the
  token form would ask the wallet to call `transfer` on an account with no
  code. Tron has no such standard, so its `payment_uri` is the bare Base58
  address.
- **`wallet_uri`** — the deep link for an "open in wallet" button. Equal to
  `payment_uri` on EVM, and `null` on Tron, which has no wallet-agreed URI
  scheme; the UI tells the payer to send the exact amount manually instead.

Also on the response: `qr_data_url` (a data-URL PNG), `decimals` (for the
(network, asset) pairing — never assume 6), `family` (`evm` or `tron`), and
`quote_ttl_sec` / `grace_ttl_sec` — durations, since the payment view itself
only carries absolute deadlines (`quote_expires_at`, `grace_expires_at`).

## Quote window vs. grace window

- **Quote window** (`quote_expires_at`, `QUOTE_TTL_MINUTES` — 15 min default):
  how long the frozen rate is good for with zero funds received. If it lapses
  with nothing paid, the payment becomes `expired`.
- **Grace window** (`graceExpiresAt`, `GRACE_TTL_MINUTES` — 90 min default):
  opened the moment the *first* deposit is seen (`registerDeposit`, moving the
  payment to `detecting`), giving the payer extra time to complete the amount
  **at the same frozen rate**. If it lapses while still short, the payment
  becomes `underpaid_expired`.

Both are documented end to end in [Architecture → Payment
lifecycle](/architecture/payment-lifecycle).

## "I already paid" — on-demand check

```bash
curl -s -X POST http://localhost:3000/public/payments/<publicId>/check
```

See [API → Public API](/api/public) for the response fields. Lets the payer trigger an immediate chain read instead of waiting for the
background watcher. It only actually reaches the chain when all of these
hold: the payment is in an active status (`pending`, `detecting`,
`partially_paid`), the network is **Tron** (EVM's Alchemy WebSocket already
delivers transfers within seconds, so a scan there would spend calls for
nothing), and at least 10 seconds have passed since the last check for this
payment (`CHECK_COOLDOWN_MS`). The response always returns the current status
plus `checked` (whether this call actually scanned) and `cooldown_ms`
(remaining, or the full cooldown if this call skipped).

## Related

- [Webhooks](/guides/webhooks) — the notification counterpart to polling
- [API → Public API](/api/public) — exact request/response fields for all four public routes
