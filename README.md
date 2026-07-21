# Crypto payment gateway (MVP)

Crypto payment gateway: charges denominated in **COP**, payable in **USDC** on EVM
**testnets** (Ethereum Sepolia and Base Sepolia), with a unique address per payment,
on-chain detection via Alchemy WebSockets, partial-payment handling with a grace window,
a QR checkout (EIP-681), signed (HMAC) webhooks, and COP balance crediting.

**Stack:** Bun + TypeScript + Hono + Drizzle ORM + PostgreSQL + viem + Alchemy.

> See [`docs/OVERVIEW.md`](docs/OVERVIEW.md) for the project's objective and context.

> Testnet only. The mnemonic lives in `.env` for development only. In production you
> derive from an **xpub** (no private keys on the server) and sweep funds from a cold
> environment.

## How it works

1. The merchant creates a payment (`POST /api/payments`) authenticated with `X-Api-Key`.
2. The COP→USDC **quote is frozen** (market rate + spread, valid for 15 min) and a
   **unique HD address** is derived for that payment.
3. The payer opens the `checkout_url` (`/pay/:publicId`): EIP-681 QR, copyable address,
   countdown, and polling every 3 s.
4. The **watcher** (Alchemy WS, filtered by the indexed `to` topic) detects the
   `Transfer`; the **confirmer** waits for confirmations (5 on Sepolia, 3 on Base
   Sepolia) with an anti-reorg re-check; once the amount is complete (within the 0.5%
   dust tolerance) the payment becomes `paid`, the COP balance is credited, and the
   `payment.paid` webhook is enqueued.
5. **Partial payments:** the first deposit opens a 90-minute grace window to complete the
   amount **at the frozen rate**. If it lapses without completing → `underpaid_expired`.

State machine: `pending → detecting → partially_paid → paid`, with branches `expired`
(quote lapsed with no funds) and `underpaid_expired` (grace lapsed while partial).

## Requirements

- Bun ≥ 1.1
- PostgreSQL 15+
- An Alchemy account with one app on **Ethereum Sepolia** and another on **Base Sepolia**
- A **new** testnet mnemonic

## Getting started

```bash
bun install
cp .env.example .env          # fill in ALCHEMY_* and HD_MNEMONIC

# Quick Postgres with Docker (optional):
docker run -d --name gateway-pg -e POSTGRES_PASSWORD=gateway \
  -e POSTGRES_DB=gateway -p 5432:5432 postgres:16

bun run db:generate           # (already versioned under drizzle/) generates migration SQL
bun run db:migrate            # applies it against Postgres
bun run seed                  # creates a demo client and prints its API KEY (shown once)

bun run dev                   # API + watchers + workers (hot reload)
```

Create a payment:

```bash
curl -s -X POST http://localhost:3000/api/payments \
  -H "X-Api-Key: gk_test_..." -H "Content-Type: application/json" \
  -d '{"amount_cop": 50000, "asset": "USDC", "network": "base-sepolia",
       "metadata": {"order_id": "ORD-001"}}'
# -> returns checkout_url: http://localhost:3000/pay/xxxxx
```

**Test USDC:** `faucet.circle.com` (pick the network). You also need testnet ETH for gas.
Verify the testnet token addresses in Circle's docs before use.

## API

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/payments` | `X-Api-Key` | Creates a payment (quote + address + `checkout_url`) |
| `GET` | `/api/payments/:publicId` | `X-Api-Key` | Payment status |
| `GET` | `/api/me` | `X-Api-Key` | Name + credited `balance_cop` |
| `GET` | `/public/payments/:publicId` | — | Public status (for the UI, no merchant data) |
| `GET` | `/pay/:publicId` | — | Checkout page (QR + polling) |
| `GET` | `/health` | — | Liveness |

Amounts are always in the **smallest unit** (`bigint`, serialized as a string): COP
without decimals, crypto in raw token units (USDC = 6 decimals). Never floats for money.

## Webhooks

Events: `payment.paid`, `payment.partially_paid`, `payment.expired`,
`payment.underpaid_expired`. They are signed with **HMAC-SHA256** over the body; the
merchant validates the `X-Gateway-Signature` header with its `webhook_secret`. Retries
use exponential backoff (up to 8 attempts). Set a webhook URL on the client (e.g. from
`webhook.site`) to observe them.

Verification on the merchant side (example):

```ts
const expected = createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
const ok = timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers["x-gateway-signature"]));
```

## Tests

With a migrated Postgres and `DATABASE_URL` pointing at it:

```bash
bun run scripts/smoke-test.ts   # state machine: partial, complete, overpay, dust, idempotency
bun run scripts/api-test.ts     # HTTP layer: routing, auth, QR/EIP-681, public endpoint
bun run typecheck               # tsc --noEmit
```

Neither test touches CoinGecko or the chain: they inject deposits through the same
service functions the workers use.

## Structure

```
docs/
  OVERVIEW.md          objective, context, scope, roadmap
src/
  config.ts            env + network/token registry
  db/                  drizzle schema + connection
  services/
    rates.ts           CoinGecko + spread + 60s cache + copToRaw (rounds up)
    wallet.ts          HD derivation (global index reserved atomically)
    payments.ts        state machine (create / register deposit / confirm / expire)
    webhooks.ts        HMAC signing + retry queue
  workers/
    watcher.ts         Alchemy WS -> Transfer events (+ getLogs backfill)
    confirmer.ts       advances confirmations, anti-reorg re-check, settles
    expirer.ts         expires quotes/grace windows + delivers webhooks
  api/                 auth (X-Api-Key) + Hono routes
  ui/pay.ts            checkout HTML (QR + polling)
scripts/
  seed.ts              creates a demo client with an API key
  smoke-test.ts        state-machine test against a real Postgres
  api-test.ts          HTTP-layer test
drizzle/               versioned SQL migrations
```

> The checkout UI (`src/ui/pay.ts`) is intentionally rendered in Spanish, since it is
> end-user–facing copy for payers in the Colombian market.

## Environment notes

- The process runs **everything together** for the MVP (API + watcher + workers using
  `setInterval`). In production you split the watcher and API and use a real queue
  (e.g. pg-boss).
- The watcher/confirmer and CoinGecko require outbound access to `*.alchemy.com` and
  `api.coingecko.com`; in environments with a network allowlist these must be enabled.

## Built-in robustness

Deposit idempotency by `(network, txHash, logIndex)`; `FOR UPDATE` locks on every state
transition; anti-reorg verification before confirming; `getLogs` backfill to cover WS
outages; rounding up in the COP→crypto conversion; dust tolerance; a guard against
double-crediting when a deposit confirms after settlement; signed webhooks with retries;
and an audit ledger for the balance.

## Pending for production (phases 2/3)

xpub-based derivation + cold sweeping; splitting the workers from the API with a real
queue; multiple price sources with a median; rate limiting and API-key rotation; BTC via
BTCPay Server; USDT TRC-20 via TronGrid; an admin panel to resolve `underpaid_expired`;
and the Colombian PSAV/DIAN legal evaluation before handling real third-party funds.
