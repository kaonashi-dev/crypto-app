# Local development

## Requirements

- Bun ≥ 1.1
- PostgreSQL 15+ (the provided `docker-compose.yml` runs 16 on host port 5433)
- For the EVM testnets: an Alchemy account with Ethereum Sepolia, Base Sepolia, BNB
  Smart Chain testnet and Polygon Amoy enabled, one key per network. A network
  whose key is missing still accepts payments and derives addresses — nothing
  watches it, and the boot names it in a warning.
- For `tron-nile`: nothing required. TronGrid serves the public testnet without a
  key; set `TRONGRID_API_KEY` only if you hit the per-IP rate limit.
- A **new** mnemonic generated for this gateway alone — never reuse one, and never
  a mnemonic that has held real funds.

## Setup sequence

```bash
bun install
cp .env.example .env               # fill in ALCHEMY_*
bun run mnemonic:new --write       # generates HD_MNEMONIC into .env, never prints it

bun run db:up                      # Postgres via Docker, on localhost:5433
bun run db:migrate                 # applies drizzle/ migrations (drizzle-kit)
bun run seed                       # creates a demo client, prints its API key once

bun run build:web                  # builds the Solid + Tailwind SPA into web/dist
bun run dev                        # API + watchers + workers, hot reload
```

Each step, and why it is where it is:

1. **`bun install`** — Bun is the only supported runtime; dependencies are locked
   by `bun.lock`.
2. **`cp .env.example .env`** — Bun loads `.env` automatically. Never commit the
   real file; it holds RPC keys and the mnemonic. See
   [Configuration](./configuration.md) for every variable.
3. **`bun run mnemonic:new --write`** — writes a fresh `HD_MNEMONIC` line in place
   without ever printing the phrase to the terminal. Run it without `--write` to
   print the phrase instead, for pasting into a deployment's environment. Never
   substitute a published test mnemonic (hardhat/anvil, ganache, the BIP-39
   vector) — `preflight()` warns on testnets and refuses to boot if any served
   network is a mainnet.
4. **`bun run db:up`** — starts the `db` service from `docker-compose.yml`.
   `DATABASE_URL` in `.env.example` already points at `localhost:5433`.
5. **`bun run db:migrate`** — applies the versioned SQL under `drizzle/` with
   `drizzle-kit migrate`. See [Database](./database.md) for how this differs from
   `db:generate` and `db:deploy`.
6. **`bun run seed`** — creates one demo client (`scripts/seed.ts`) and prints its
   API key. The key is shown once; nothing after this prints it again except a
   console-issued rotation.
7. **`bun run build:web`** — builds the SPA into `web/dist`. Required before
   `/pay/:publicId` or `/admin*` will serve anything — without it they answer
   `503` telling you to build. `smoke-test.ts` does not need this; `api-test.ts`
   and `admin-test.ts` do.
8. **`bun run dev`** — starts the API, per-network supervisors, the expirer and
   webhook delivery together, with hot reload (`bun --watch`). This probes every
   configured RPC at boot.

## Checkout and console UI development

The built SPA is served by the backend at `/pay/:publicId` and every path under
`/admin`. For a hot-reloading UI loop, run the backend (`bun run dev`) and, in a
second shell, the Vite dev server:

```bash
bun run dev:web    # http://localhost:5173
```

Vite proxies `/api`, `/public` and `/admin/api` to the backend on port 3000, so the
UI dev server talks to a live database and real workers without a second build
step. If you start the backend without building the UI first, `/pay/:id` and
`/admin*` return `503` until `bun run build:web` runs.

## Creating a payment

```bash
curl -s -X POST http://localhost:3000/api/payments \
  -H "X-Api-Key: gk_test_..." -H "Content-Type: application/json" \
  -d '{"amount_cop": 50000, "asset": "USDC", "network": "base-sepolia"}'
# -> checkout_url: http://localhost:3000/pay/xxxxx
```

`scripts/create-payment.ts` and `scripts/wallets.ts` do the same thing
deterministically, useful for scripting a demo without copy-pasting a key. Test
funds: `faucet.circle.com` (USDC on the EVM testnets),
`bnbchain.org/en/testnet-faucet` (test BNB), `faucet.polygon.technology` (test
POL), `nileex.io/join/getJoinPage` (test TRX and test USDT on Tron Nile).

## Environment notes worth knowing up front

- The process runs API + all workers together via `setInterval` loops — there is
  no separate queue process. `railway.json` pins one replica for the same reason
  the workers have no leader election.
- Workers start per network only once that network's RPC answers, retrying every
  60s with exponential backoff. A network with no credential set is skipped at
  boot instead of retried, since probing a URL with no key can only ever fail.
- `SIGTERM` drains the Postgres pool before exit.

See [Configuration](./configuration.md) for every variable and its default, and
[Troubleshooting](./troubleshooting.md) for the failure modes you are most likely
to hit while setting this up.
