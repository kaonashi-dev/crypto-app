# Quickstart

An end-to-end run: stand the gateway up, mint an API key, create a payment,
open the checkout, poll status, and receive a webhook. Everything below is
runnable as shown.

## Prerequisites

```bash
bun install
cp .env.example .env               # fill in ALCHEMY_* keys you have
bun run mnemonic:new --write       # generates a private HD_MNEMONIC into .env

bun run db:up                      # Postgres 16 on localhost:5433 (docker compose)
bun run db:migrate                 # applies drizzle/ migrations
```

Never substitute a published test mnemonic (hardhat/anvil, ganache, the BIP-39
vector) — `preflight()` in `src/config.ts` refuses to boot with one on a served
mainnet, and warns on testnets.

Create a merchant and print its API key (shown once):

```bash
bun run seed
```

Build the checkout/console SPA — the backend serves `/pay/*` and `/admin*` only
once this exists:

```bash
bun run build:web
```

Start the API, watchers and workers:

```bash
bun run dev
```

For a hot-reloading UI dev loop instead, run `bun run dev` in one shell and
`bun run dev:web` (Vite, port 5173) in another; Vite proxies `/api`, `/public`
and `/admin/api` to port 3000.

## 1. Create a payment

Using `curl` (see [Authentication](/guides/authentication) for the `X-Api-Key`
header, and [Payments](/guides/payments) for every field):

```bash
curl -s -X POST http://localhost:3000/api/payments \
  -H "X-Api-Key: gk_test_..." \
  -H "Content-Type: application/json" \
  -d '{"amount_cop": 50000, "asset": "USDC", "network": "base-sepolia",
       "metadata": {"order_id": "ORD-001"}}'
```

The same call with [HTTPie](https://httpie.io):

```bash
http POST :3000/api/payments X-Api-Key:gk_test_... \
  amount_cop:=50000 asset=USDC network=base-sepolia
```

The response carries `checkout_url` (`http://localhost:3000/pay/<publicId>`)
plus the frozen quote and receiving address — see
[Payments](/guides/payments) for the full body.

**Offline/deterministic alternative.** `scripts/create-payment.ts` mirrors
`createPayment()` but injects a fixed rate instead of quoting live, so it works
without network access:

```bash
bun run scripts/create-payment.ts [clientId] [amountCop] [network] [asset]
bun run scripts/create-payment.ts "" 50000 tron-nile
```

## 2. Open the checkout

Open the `checkout_url` from step 1 in a browser
(`/pay/:publicId`) — it renders the QR code, the receiving address, and a
countdown, and polls `GET /public/payments/:publicId` every few seconds. See
[Checkout](/guides/checkout) for the underlying endpoints.

## 3. Fund the payment

You need testnet funds in your own wallet to pay the checkout — see
[Testing](/guides/testing) for faucets, or generate a throwaway payer wallet
with:

```bash
bun run scripts/wallets.ts
```

## 4. Poll status

A merchant backend polls the poll-shaped endpoint until `terminal` is `true`:

```bash
curl -s http://localhost:3000/api/payments/<publicId>/status \
  -H "X-Api-Key: gk_test_..."
```

## 5. Receive the webhook

Set a webhook URL on the client (e.g. from [webhook.site](https://webhook.site))
via the console (`POST /admin/api/clients` or `PATCH /admin/api/clients/:id`),
then watch `payment.paid` (or `payment.partially_paid`, `payment.expired`,
`payment.underpaid_expired`) arrive, signed with `X-Gateway-Signature`. See
[Webhooks](/guides/webhooks) for the event bodies and signature verification.

## Next

- [Networks & assets](/guides/networks-and-assets) — every quotable pairing and its decimals
- [Testing](/guides/testing) — faucets, the Postman collection, the standalone test scripts
- [API reference](/api/) — every route, field by field
