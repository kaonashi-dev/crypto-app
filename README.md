# Crypto payment gateway (MVP)

Crypto payment gateway: charges denominated in **COP**, payable in **USDC** on EVM
**testnets** (Ethereum Sepolia and Base Sepolia) or **USDT on Tron** (Nile testnet),
with a unique address per payment, on-chain detection (Alchemy WebSockets on EVM,
TronGrid polling on Tron), partial-payment handling with a grace window, a QR checkout,
signed (HMAC) webhooks, and COP balance crediting.

| Network | Asset | Detection | Address |
|---|---|---|---|
| `eth-sepolia` | USDC | Alchemy WS + chunked `getLogs` backfill | `m/44'/60'/0'/0/i` → `0x…` |
| `base-sepolia` | USDC | Alchemy WS + chunked `getLogs` backfill | `m/44'/60'/0'/0/i` → `0x…` |
| `tron-nile` | USDT | TronGrid polling (no WS on Tron) | `m/44'/195'/0'/0/i` → `T…` |

**Stack:** Bun + TypeScript + Hono + Drizzle ORM + PostgreSQL + viem + Alchemy + TronGrid.
**Web UI:** SolidJS + TanStack Query/Router + Tailwind CSS v4, built with Vite (`./web`),
served by the backend.

> See [`docs/OVERVIEW.md`](docs/OVERVIEW.md) for the project's objective and context.

> Testnet only. The mnemonic lives in `.env` for development only. In production you
> derive from an **xpub** (no private keys on the server) and sweep funds from a cold
> environment.

## How it works

1. The merchant creates a payment (`POST /api/payments`) authenticated with `X-Api-Key`.
2. The COP→token **quote is frozen** (market rate + spread, valid for 15 min) and a
   **unique HD address** is derived for that payment, on the chain's own coin type.
3. The payer opens the `checkout_url` (`/pay/:publicId`): QR, copyable address,
   countdown, and polling every 10 s.
4. The **watcher** (Alchemy WS filtered by the indexed `to` topic on EVM; TronGrid polling
   on Tron) detects the `Transfer`; the **confirmer** waits for confirmations (5 on
   Sepolia, 3 on Base Sepolia, 19 on Tron) with an anti-reorg re-check; once the amount is
   complete (within the 0.5% dust tolerance) the payment becomes `paid`, the COP balance
   is credited, and the `payment.paid` webhook is enqueued.
5. **Partial payments:** the first deposit opens a 90-minute grace window to complete the
   amount **at the frozen rate**. If it lapses without completing → `underpaid_expired`.

State machine: `pending → detecting → partially_paid → paid`, with branches `expired`
(quote lapsed with no funds) and `underpaid_expired` (grace lapsed while partial).

## Requirements

- Bun ≥ 1.1
- PostgreSQL 15+
- For the EVM networks: an Alchemy account with **Ethereum Sepolia** and **Base Sepolia**
  enabled on the app
- For `tron-nile`: nothing — TronGrid serves the public testnet without a key. Set
  `TRONGRID_API_KEY` only if you hit the per-IP rate limit.
- A **new** mnemonic, generated for this gateway alone (`bun run mnemonic:new`)

## Getting started

```bash
bun install
cp .env.example .env          # fill in ALCHEMY_*
bun run mnemonic:new --write  # generates HD_MNEMONIC into .env without printing it

# Start Postgres with Docker. DATABASE_URL in .env already points at localhost:5433.
bun run db:up

bun run db:generate           # (already versioned under drizzle/) generates migration SQL
bun run db:migrate            # applies it against Postgres
bun run seed                  # creates a demo client and prints its API KEY (shown once)

bun run build:web             # builds the Solid + Tailwind SPA into web/dist
bun run dev                   # API + watchers + workers (hot reload); serves web/dist at /pay/:id
```

**Checkout UI development.** The built SPA is served by the backend at `/pay/:publicId`.
For a hot-reloading UI dev loop, run the backend (`bun run dev`) and, in another shell,
the Vite dev server (`bun run dev:web`) on `http://localhost:5173` — it proxies `/api` and
`/public` to the backend. If you start the backend without building the UI first, `/pay/:id`
returns a 503 telling you to run `bun run build:web`.

Create a payment:

```bash
curl -s -X POST http://localhost:3000/api/payments \
  -H "X-Api-Key: gk_test_..." -H "Content-Type: application/json" \
  -d '{"amount_cop": 50000, "asset": "USDC", "network": "base-sepolia",
       "metadata": {"order_id": "ORD-001"}}'
# -> returns checkout_url: http://localhost:3000/pay/xxxxx
```

Or charge in USDT over Tron:

```bash
curl -s -X POST http://localhost:3000/api/payments \
  -H "X-Api-Key: gk_test_..." -H "Content-Type: application/json" \
  -d '{"amount_cop": 60000, "asset": "USDT", "network": "tron-nile"}'
```

Asset/network pairings are validated against the registry in `src/config.ts`; asking for
`USDT` on an EVM network (or `USDC` on Tron) returns `400 Unsupported asset/network
combination`.

**Test USDC (EVM):** `faucet.circle.com` (pick the network). You also need testnet ETH for
gas. Verify the testnet token addresses in Circle's docs before use.

**Test USDT (Tron Nile):** [`nileex.io/join/getJoinPage`](https://nileex.io/join/getJoinPage)
gives test TRX and test USDT. Receiving TRC-20 costs the payer bandwidth/energy, not the
gateway; you only need TRX in the receiving account when you later sweep funds out.

## API

> [`docs/HTTPIE.md`](docs/HTTPIE.md) walks the whole lifecycle — create, pay, settle, inspect
> — as runnable HTTPie commands, including the console's filters and the money-as-strings rule.
> [`docs/crypto-gateway.postman_collection.json`](docs/crypto-gateway.postman_collection.json)
> is the same surface as an importable collection (HTTPie Desktop / Postman / Insomnia / Bruno).

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/payments` | `X-Api-Key` | Creates a payment (quote + address + `checkout_url`) |
| `GET` | `/api/payments/:publicId` | `X-Api-Key` | Payment status |
| `GET` | `/api/me` | `X-Api-Key` | Name + credited `balance_cop` |
| `GET` | `/public/payments/:publicId` | — | Public status, polled by the UI every 10s (no merchant data) |
| `GET` | `/public/payments/:publicId/checkout` | — | One-shot checkout payload: public view + QR + `payment_uri` + `wallet_uri` + `decimals` + `family` + `quote_ttl_sec`/`grace_ttl_sec` |
| `GET` | `/pay/:publicId` | — | Checkout page (SPA shell) |
| `GET` | `/health` | — | Liveness |
| `GET` | `/admin`, `/admin/deposits`, `/admin/users`, `/admin/p/:publicId` | — | Backoffice console (SPA shell; renders the login screen until you sign in) |
| `POST` | `/admin/api/auth/login` | — | Signs an operator in and sets the session cookie |
| `POST` | `/admin/api/auth/logout` | Session | Ends the session server-side |
| `GET` | `/admin/api/auth/me` | Session | Who is signed in (401 = show the login screen) |
| `GET` | `/admin/api/stats` | Session | Status counts, queue health, live business parameters |
| `GET` | `/admin/api/payments` | Session | Payment list — `status`, `network`, `asset`, `client_id`, `q`, `limit`, `offset` |
| `GET` | `/admin/api/payments/:publicId` | Session | One payment plus its deposits, webhook attempts and ledger entries |
| `GET` | `/admin/api/deposits` | Session | Flat deposit feed — `network`, `confirmed`, `q` |
| `GET` | `/admin/api/clients` | Session | Merchants with balances and payment counts |
| `GET` | `/admin/api/users` | Session | Console operators, last sign-in and open session counts |

Amounts are always in the **smallest unit** (`bigint`, serialized as a string): COP
without decimals, crypto in raw token units (USDC and USDT = 6 decimals). Never floats
for money.

On the checkout payload, `payment_uri` is what the QR encodes (EIP-681 on EVM, the bare
Base58 address on Tron) and `wallet_uri` is the deep link for the "open in wallet" button
— `null` on Tron, which has no such standard.

## Backoffice console (`/admin`)

An internal, **read-only** console for inspecting transactions during testing. Open
[`http://localhost:3000/admin`](http://localhost:3000/admin) once the backend is up and
the SPA is built.

> **Cross-merchant, and gated as one thing.** It exposes every merchant's payments plus
> internals the merchant API deliberately hides (HD derivation index, frozen rate, webhook
> delivery attempts, ledger entries). Signing in gets you all of it: there is no
> per-merchant scoping, so whoever gets in sees everything. Every route is a `SELECT`, so
> nothing in the console can mutate a payment.

### Signing in

The console asks for an operator username and password, and keeps you signed in with a
session cookie. Accounts live in `admin_users`; sessions live in `admin_sessions`, one row
per signed-in browser.

| | |
|---|---|
| **Account** | `ADMIN_USER` (default `samuel`) with the password in `ADMIN_PASSWORD` |
| **Created** | on every boot, by `bootstrapOperator()` — idempotent |
| **Password reset** | change `ADMIN_PASSWORD` and restart; that operator's open sessions are revoked |
| **Session length** | `ADMIN_SESSION_TTL_HOURS` (default 12), sliding while the session is in use |
| **No `ADMIN_PASSWORD`** | no account exists and the console runs **open** — development only; a production boot refuses to start |

Two properties worth stating, since both are the reason for a table rather than a
credential in the environment: passwords are stored as **argon2id** hashes, never a bare
digest — SHA-256 is right for a random API key and wrong for a password — and the cookie
carries a random token whose **SHA-256 is what the session row holds**, so a database dump
cannot be replayed as a signed-in browser. Signing out deletes the row; deactivating an
operator (`is_active = false`, by SQL for now) ends their sessions on the next request.

Failed sign-ins are throttled per (address, username) and per address, and every attempt is
logged with the reason separated — unknown operator, wrong password, deactivated — while
the response says only "invalid username or password". The console *shell* is public: it is
static markup with no data in it, and the login screen has to be servable. Everything under
`/admin/api` requires the session.

Four views:

- **Payments** — status mix across all payments as one bar (click a segment or legend entry
  to filter), plus a filterable, paginated table. Search spans public id, receiving
  address, `metadata` (so `order_id` works) and — via the deposits table — **transaction
  hash**, which is what you want when reconciling against a block explorer.
- **Payment detail** (`/admin/p/:publicId`) — the state machine as the page's hero: which
  path the payment took and where it stopped. Then the amount breakdown (required /
  confirmed / pending / overpaid, each with its raw integer), the frozen rate, the settle
  threshold after dust tolerance, and the three tables that explain the outcome — on-chain
  deposits, webhook delivery attempts, and ledger credits. Hashes and addresses link out
  to the right explorer per network.
- **Deposits** — a flat feed of every `Transfer` the watchers recorded. This answers "did
  the watcher see my transfer at all?": a deposit can be recorded with no effect on its
  payment (it landed after the grace window, or in a terminal state), which the payments
  list alone would not reveal.
- **Operators** (`/admin/users`) — who can open this console, when each last signed in, and
  how many sessions each has open. Read-only like the rest: accounts come from the boot, not
  from the browser, because granting access is a mutation and mutations here wait for the
  audit model listed under *Pending for production*.

**Auto-refresh is off by default.** Opening the console fetches once — three requests
(`stats`, `payments`, `clients`) — and then nothing until you press **Refresh** or switch
**Auto-refresh** on, at which point it refetches every 4 s. The choice is remembered per
browser (`localStorage`), so a console left open does not quietly poll all day. The header
shows the absolute time the data on screen was fetched (`data 05:07:46`), so a snapshot is
never mistaken for live state.

None of this reaches a paid provider — every `/admin/api/*` route is a plain Postgres
`SELECT`, with no Alchemy, CoinGecko or TronGrid call reachable from the console — but
polling still costs database and compute per open tab.

The header also carries the gateway's active parameters (quote TTL, grace TTL, spread, dust
tolerance), so a frozen quote or a settle slightly under the exact amount is reproducible
without reading `.env` on the server.

Explorer URLs live in the network registry (`src/config.ts`) as `{v}` templates, since path
shapes differ per explorer (`/tx/:hash` on Etherscan, `/#/transaction/:hash` on Tronscan).

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
bun run build:web               # required before api-test/admin-test (they exercise SPA serving)
bun run scripts/smoke-test.ts   # state machine: partial, complete, overpay, dust, idempotency
bun run scripts/api-test.ts     # HTTP layer: auth, checkout endpoint (EIP-681/QR), SPA + assets
bun run scripts/admin-test.ts   # backoffice API: filters, tx-hash search, detail joins, bigint serialization
bun run typecheck               # backend: tsc --noEmit
bun run typecheck:web           # frontend: tsc -p web/tsconfig.json
```

No test touches CoinGecko or the chain: they inject deposits through the same service
functions the workers use.

## Structure

```
docs/
  OVERVIEW.md          objective, context, scope, roadmap
src/
  config.ts            env + network/token registry
  db/                  drizzle schema + connection
  services/
    rates.ts           (CoinGecko USD) x (FX USD->COP) + spread + cache + copToRaw (rounds up)
    wallet.ts          HD derivation per family (EVM m/44'/60', Tron m/44'/195')
    tron.ts            Base58Check codec + TronGrid client + Transfer-log decoding
    payments.ts        state machine (create / register deposit / confirm / expire)
    webhooks.ts        HMAC signing + retry queue
  workers/
    supervisor.ts      probes each network, starts its workers once the RPC answers
    watcher.ts         Alchemy WS -> Transfer events (+ chunked getLogs backfill)
    confirmer.ts       advances confirmations, anti-reorg re-check, settles
    tron-watcher.ts    TronGrid polling -> TRC-20 transfers (no WS on Tron)
    tron-confirmer.ts  same contract as confirmer.ts, over TronGrid
    rpc-log.ts         compact, de-duplicated RPC error logging
    expirer.ts         expires quotes/grace windows + delivers webhooks
  api/
    auth.ts            X-Api-Key middleware
    routes.ts          Hono routes (+ serves both SPA surfaces)
    admin.ts           read-only backoffice API (/admin/api/*), unauthenticated
web/                   Solid + Tailwind SPA (Vite) — checkout + console in one bundle
  index.html           SPA entry
  src/
    main.tsx           Solid root: QueryClient + RouterProvider, self-hosted fonts
    router.tsx         TanStack route tree — /pay/$publicId and /admin/*
    index.css          Tailwind entry + both palettes and the type system (@theme)
    lib/
      status.ts        PaymentStatus + the mark shapes both surfaces share
      checkout-api.ts  typed client for the public endpoints + payer-facing formatting
      clock.ts         ticking clock + duration formatting for countdowns
    checkout/
      CheckoutRoute.tsx  the payment order: quote lock, pay zone, live polling
      parts.tsx          slip shell, status copy, copy-to-clipboard fields, paid stamp
      NotFoundPage.tsx   unknown payment id, and the router's 404
    admin/
      AdminLayout.tsx     console shell: nav, refresh controls, live-refresh clock
      PaymentsRoute.tsx   stats strip, status-mix bar, URL filters, payment table
      PaymentDetailRoute.tsx lifecycle rail + amounts, deposits, webhooks, ledger
      DepositsRoute.tsx   flat on-chain deposit feed
      ui.tsx              status system, lifecycle rail, meter, panels, copy/explorer links
      api.ts              typed client + exact bigint formatting for the console
      console.ts          auto-refresh preference, shared clock, fetch timestamp
scripts/
  seed.ts              creates a demo client with an API key
  smoke-test.ts        state-machine test against a real Postgres
  api-test.ts          HTTP-layer test (+ checkout endpoint & SPA serving)
  admin-test.ts        backoffice API test (filters, search, detail joins, serialization)
drizzle/               versioned SQL migrations
vite.config.ts         Vite config (root=web, builds to web/dist)
```

> The checkout UI (`web/src/checkout/`) is intentionally rendered in Spanish, since
> it is end-user–facing copy for payers in the Colombian market. The console
> (`web/src/admin/`) is in English — it is an internal operator tool, a different audience,
> and it is deliberately dark so it is never mistaken for the payer-facing checkout.

## Web UI

One Vite bundle, one TanStack route tree, two surfaces. The backend returns the same shell
for `/pay/:publicId` and every path under `/admin`, and the router picks from there.

**Data.** Every fetch goes through TanStack Query. The checkout holds the checkout payload
forever (`staleTime: Infinity` — QR, decimals and window lengths cannot change) and polls
status every 10 s until the payment reaches a terminal state, at which point the interval
turns itself off. It also refetches on window focus, so a payer returning from their wallet
app sees the result of what they just did. The console does the opposite: refetch-on-focus
is off globally, and auto-refresh stays off until switched on, because a console left open
should not poll all day.

**Filters live in the URL.** `/admin?status=paid&network=tron-nile` is a shareable view,
Back undoes a filter, and the search box debounces 300 ms before writing to the URL rather
than querying on every keystroke.

**The checkout's design.** Palette from the inks of a Colombian $50.000 note — aubergine,
security-thread ochre, a violet-tinted paper — because the charge is denominated in COP and
the payer is Colombian. The COP amount is set in Bodoni Moda, a didone being the engraved
register of printed money; the token amount is set in mono and formatted machine-style (a
dot, no separators) because it is transcribed into a wallet and what is shown must be
exactly what lands on the clipboard. The rule between the two is the signature element: it
binds the charge to the token amount, and the share of it still inked is the share of the
frozen-quote window still running. On a partial payment it becomes the grace clock; on a
settled one it fills. Fonts are self-hosted (`@fontsource`) so a checkout page never depends
on a third-party font host, and the band along the top edge carries the payment's state.

## Deploying to Railway

Still testnet only — see the warning at the top. What follows makes the gateway reachable
on a public URL so a payer can open a checkout from a phone; it does not make it safe to
hold real third-party funds (see [Pending for production](#pending-for-production-phases-23)).

The repo ships the three files Railway reads: [`Dockerfile`](Dockerfile) (installs, builds
the SPA, and drops the Vite toolchain from the runtime image), [`.dockerignore`](.dockerignore),
and [`railway.json`](railway.json) (Dockerfile builder, `/health` health check, single
replica).

**1. Create the services.** In a Railway project, add a **PostgreSQL** database, then a
service from this repo. Railway detects the `Dockerfile` and builds it — no Nixpacks
configuration to maintain.

**2. Set the variables** on the app service:

| Variable | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` — a reference, so it tracks the database service |
| `HD_MNEMONIC` | its own mnemonic from `bun run mnemonic:new`, quoted — not the one your local `.env` uses, and not a published test phrase |
| `ADMIN_PASSWORD` | a generated password for the console operator (`ADMIN_USER`, default `samuel`); the boot refuses to start in production without it, and changing it resets that operator's password on the next deploy |
| `ALCHEMY_SEPOLIA_KEY` | your Alchemy key, if you want that network detected |
| `ALCHEMY_BASE_SEPOLIA_KEY` | likewise, for Base Sepolia |
| `PUBLIC_BASE_URL` | optional; pin `checkout_url`s to a custom domain, no trailing slash |

Do **not** set `PORT`; Railway injects it and the server binds to it. `NODE_ENV=production`
comes from the image. A network whose Alchemy key is absent is skipped at boot with one log
line — payments on it would be created but never detected — so set only the keys you have
and leave the rest off deliberately.

**3. Deploy.** The container's start command runs `bun run db:deploy` (drizzle-orm's
migrator over the versioned `drizzle/` folder, idempotent) and then the API and workers.
`drizzle-kit` is a devDependency, which is why deployed migrations go through
[`scripts/migrate.ts`](scripts/migrate.ts) rather than `bun run db:migrate`.

**4. Create a merchant** to get an API key. From a local shell with `DATABASE_URL` pointed
at the Railway database — its **public** proxy URL, with `?sslmode=require` appended:

```bash
DATABASE_URL='postgres://...proxy.rlwy.net:PORT/railway?sslmode=require' bun run seed
```

Then `POST https://<your-app>.up.railway.app/api/payments` with that key; the returned
`checkout_url` is an `https://` link, because the origin is read from the forwarded scheme
rather than from the plain-HTTP request Railway's edge hands the container.

**Keep it at one replica.** `railway.json` pins `numReplicas: 1`. The watchers, confirmers
and expirer are in-process `setInterval` loops with no leader election, so a second replica
duplicates every provider call and every poll. Deposit idempotency and the row locks mean
it would not corrupt a payment, but it doubles the metered spend for nothing. Splitting the
workers out behind a real queue is phase 2.

**Health check.** `GET /health` returns `{"ok":true}` without touching Postgres — it reports
that the process is serving, deliberately not that the database is reachable, so a brief
database blip cannot cascade into a restart loop that drops the WebSocket subscriptions too.

**Cost.** The container is idle-cheap by design (see [Provider cost](#provider-cost)), but
it is a long-running process with WebSocket subscriptions, not a scale-to-zero function; it
bills for wall-clock time.

## Environment notes

- The process runs **everything together** for the MVP (API + watcher + workers using
  `setInterval`). In production you split the watcher and API and use a real queue
  (e.g. pg-boss).
- The watcher/confirmer and the rate service require outbound access to `*.alchemy.com`,
  `api.coingecko.com` and the FX provider (`open.er-api.com`, falling back to
  `cdn.jsdelivr.net`); in environments with a network allowlist these must be enabled.
- **COP is not a CoinGecko `vs_currency`** (it returns HTTP 200 with an empty object), so
  the rate is a cross: asset→USD from CoinGecko × USD→COP from the FX provider. Set
  `FALLBACK_USD_COP` if you want a last-resort rate when every provider is unreachable.
- Workers start per network only once that network's RPC answers, retrying every 60s.
  If a network is not enabled on the Alchemy app the gateway logs one line and keeps
  serving; it picks the network up automatically once you enable it — no restart. A network
  whose key is not set at all is skipped at boot instead, since probing a URL with no
  credential in it can only ever fail.
- The boot preflight (`preflight()` in `src/config.ts`) exits on a missing `DATABASE_URL`,
  `HD_MNEMONIC`, or — in production — `ADMIN_PASSWORD`, rather than letting the gap surface
  later inside a request or a worker tick. In production the last of those is also what the
  console signs operators in with, so a deployment can never boot with a console nobody can
  reach *and* nobody can be kept out of. `SIGTERM` drains the Postgres pool before exit.
- The same preflight exits on an `HD_MNEMONIC` that fails its BIP-39 checksum, and on one
  of the published test mnemonics whenever any registered network is not a testnet — that
  pairing means every address the gateway hands a payer has a private key in a README
  somewhere. On testnets it is a warning instead, since that is a legitimate way to work.
- **One database, one tree.** `hd_counter` stores the BIP-32 fingerprint of the mnemonic
  that issued its indexes, and `reserveDerivationIndex` will not issue from any other, so a
  swapped `HD_MNEMONIC` fails at boot (and at the next payment) instead of quietly
  continuing the sequence into addresses the previous seed owns. Rotating on purpose means
  rotating both: a fresh database, or — on a testnet, where the orphaned addresses hold
  nothing worth recovering — `UPDATE hd_counter SET seed_fingerprint = NULL WHERE id = 1`
  before the first boot on the new seed. Addresses already handed to payers keep deriving
  from the old mnemonic either way; that is what makes this a decision and not a setting.

## Provider cost

Alchemy and TronGrid are metered; Postgres and this app's own endpoints are not. The
design principle is therefore: **never ask a provider something the database can answer,
and never poll on behalf of a payer who could just tell us.**

Three rules implement that:

1. **Nothing open, nothing spent.** Every worker checks the DB first and returns before
   touching the provider. With no open payments and no maturing deposits, the gateway
   makes *zero* provider calls — it used to spend ~780/hour sitting idle, because the
   confirmers asked for the block height before checking whether anything needed it.
2. **On-demand beats continuous.** The checkout's **"Ya envié el pago — búscalo"** button
   (`POST /public/payments/:publicId/check`) scans the chain for that one payment, so the
   background sweep can run slowly instead of polling every open payment every 15 s. The
   endpoint is public, so it is cooldown-gated per payment (10 s) — otherwise it would be
   a lever for burning quota rather than saving it. It is a no-op on EVM, where the
   WebSocket already delivers transfers in seconds.
3. **Cadences are env dials, not constants.** See `BACKFILL_INTERVAL_SEC`,
   `TRON_POLL_INTERVAL_SEC`, `CONFIRMER_INTERVAL_SEC` in `.env.example`.

Provider calls per hour, at the defaults:

| Situation | Before | Now |
|---|---:|---:|
| Idle (no open payments) | ~780 | ~4 |
| 1 open Tron payment | 600 | 60 + 1 per button press |
| 1 open EVM payment | 720 (300 of them `getLogs`) | 72 (60 `getLogs`) |
| A network left disabled | 60 probes | 4 (exponential backoff, 15 min cap) |

> The checkout's 10 s status poll and the console's refresh only read Postgres — they cost
> nothing at the provider. Slowing them down saves database work, not money. The console's
> auto-refresh is off by default for the same reason it exists: it is a snapshot tool.

`eth_getLogs` dominates the EVM bill (Alchemy prices it far above `eth_blockNumber`), which
is why the backfill window and interval are the first dials to reach for. Live detection is
the WebSocket; the backfill only has to catch what a reconnection missed.

## Built-in robustness

Deposit idempotency by `(network, txHash, logIndex)`; `FOR UPDATE` locks on every state
transition; anti-reorg verification before confirming; `getLogs` backfill to cover WS
outages; rounding up in the COP→crypto conversion; dust tolerance; a guard against
double-crediting when a deposit confirms after settlement; signed webhooks with retries;
and an audit ledger for the balance.

**Deposits are bounded in time.** A transfer only settles a payment if it arrived *at or
after* the payment was created. On Tron this is enforced twice — `min_timestamp` on the
TronGrid query and a local re-check — because an HD address can carry unrelated history
(and every address derived from a shared testnet mnemonic certainly does). Without it,
an address's old transfers would settle a brand-new order.

### Tron specifics

- **No WebSocket.** Tron has no log subscription, so `tron-watcher.ts` polls every 15 s;
  polling is the primary path, not a backfill.
- **No block number or log index** in TronGrid's TRC-20 listing, so each candidate is
  resolved via `gettransactioninfobyid`. The amount is then re-read from the transaction's
  own event log rather than trusted from the listing, and the log's position becomes the
  `logIndex` that keeps deposits idempotent.
- **No payment-link standard.** EVM checkouts emit an EIP-681 URI so the wallet opens
  pre-filled; Tron wallets do not agree on one, so the QR carries the bare Base58 address
  and the UI surfaces a copyable exact amount instead. `wallet_uri` is `null` for Tron.
- **Confirmations:** 19 blocks (~57 s), Tron's SR irreversibility threshold.

## Pending for production (phases 2/3)

xpub-based derivation + cold sweeping; splitting the workers from the API with a real
queue; multiple price sources with a median; rate limiting and API-key rotation; BTC via
BTCPay Server; and the Colombian PSAV/DIAN legal evaluation before handling real
third-party funds.

On the backoffice specifically, the console at `/admin` covers **inspection** only. Still
pending:

- **Scoping, and an access log.** Operators are now named accounts with their own sessions,
  so the console can say who signed in and when — but sign-ins are the only thing recorded,
  and a *read* of a cross-merchant view leaves no trace. There is also still no
  API-key-scoped merchant view (the merchant dashboard would be a filter over the same
  data), and no way to create, disable or reset an operator except through the environment
  and a restart. Both wait on the audit model below.
- **Resolving `underpaid_expired`.** The console surfaces these payments and the funds held
  against them, but the state has no exit in the code. Resolving one means a refund or a
  manual credit, both of which mutate balances and need an audit trail and authentication
  first.
- **Re-queueing dead webhooks.** `deliverPendingWebhooks` stops permanently at 8 attempts.
  The console shows which jobs gave up; there is no retry path yet.
