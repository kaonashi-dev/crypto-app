# crypto-gateway

A crypto payment gateway that charges denominated in **COP** (Colombian pesos),
payable in stablecoins or a chain's own coin across EVM testnets and Tron. Each
payment gets a unique on-chain address, is detected and confirmed automatically,
credits a COP balance, and fires a signed webhook. A backoffice console at
`/admin` gives operators inspection plus merchant provisioning and payment
issuance, and a treasury sweeper can consolidate deposit addresses — see
[What this is](#what-this-is) below for what is live versus dry-run-only.

**Stack:** Bun + TypeScript + Hono + Drizzle ORM + PostgreSQL + viem + Alchemy +
TronGrid, with a SolidJS + TanStack + Tailwind v4 SPA (`web/`) serving both the
checkout and the console.

> Testnets by default. Real value requires deliberate configuration
> (`ENABLE_MAINNETS`) that a public mnemonic and an in-process signer both
> refuse to boot into — see the [mainnet checklist](docs/operations/mainnet-checklist.md).

## Networks and assets

| Network | Assets | Detection | Address family |
|---|---|---|---|
| `eth-sepolia` | USDC | Alchemy WS + chunked `getLogs` backfill | `m/44'/60'` → `0x…` |
| `base-sepolia` | USDC | Alchemy WS + chunked `getLogs` backfill | `m/44'/60'` → `0x…` |
| `bsc-testnet` | USDT, USDC (18 dec), **BNB** | log filter for tokens, block scan for BNB | `m/44'/60'` → `0x…` |
| `polygon-amoy` | USDC, **POL** | log filter for tokens, block scan for POL | `m/44'/60'` → `0x…` |
| `tron-nile` | USDT, **TRX** | TronGrid polling (no WS on Tron) | `m/44'/195'` → `T…` |

Bold assets are a chain's own coin, not a token — no `Transfer` event, so it is
found by reading blocks rather than filtering logs. `bsc` and `polygon`
(mainnet) are defined in the registry but withheld unless `ENABLE_MAINNETS=true`.
**Decimals are per (network, asset) pairing, never per symbol** — USDC is 6
decimals on Polygon Amoy and 18 on BSC testnet; read them from `src/config.ts`,
never assume 6.

## Quickstart

```bash
bun install
cp .env.example .env && bun run mnemonic:new --write   # fill in ALCHEMY_*
bun run db:up && bun run db:migrate && bun run seed
bun run build:web
bun run dev
```

Full walkthrough, including creating a payment and watching a webhook fire:
[docs/guides/quickstart.md](docs/guides/quickstart.md).

## What this is

- **Merchant API** (`X-Api-Key`) to create a charge, poll its status, and check a
  merchant's credited balance.
- **Hosted checkout** (`/pay/:publicId`) — QR, countdown, live polling, an
  EIP-681 URI on EVM.
- **On-chain detection and settlement** — Alchemy WebSockets + backfill on EVM,
  TronGrid polling on Tron, confirmation depth per network, partial-payment
  grace window, dust tolerance, deposit idempotency, signed retrying webhooks.
- **Backoffice console** (`/admin`) — cross-merchant, read-mostly but not
  read-only: seven views (Payments, Payment detail, Deposits, Sweeps,
  Merchants, Build, Users) plus a Wallets panel. Merchant provisioning,
  credential rotation and operator-issued payments are real mutations, each
  requiring a signed-in operator and writing an `admin_audit_log` row in the
  same transaction as the change. See
  [docs/architecture/console.md](docs/architecture/console.md).
- **Treasury sweeping** (`src/services/sweeper.ts`) — consolidates per-payment
  deposit addresses into a treasury per family. It exists and can move real
  value once configured; it ships **off by default** and, even once enabled,
  defaults to a dry run that only plans and records — see
  [docs/operations/sweeping-runbook.md](docs/operations/sweeping-runbook.md).
  Settlement never reads a balance, so sweeping cannot affect what a payment
  settles at regardless of mode.

## Documentation

The full docs site lives under [`docs/`](docs) (VitePress; `bun run docs:dev`).

| Track | For | Start here |
|---|---|---|
| **Guides** | Integrating as a merchant | [guides/quickstart.md](docs/guides/quickstart.md) |
| **API reference** | Every route, request/response shape | [api/index.md](docs/api/index.md) |
| **Architecture** | How the system works internally | [architecture/overview.md](docs/architecture/overview.md) |
| **Operations** | Running, deploying, configuring, sweeping | [operations/local-development.md](docs/operations/local-development.md) |
| **Contributing** | Conventions and verification for changes | [contributing/index.md](docs/contributing/index.md) |
| **ADRs** | Why the load-bearing decisions were made | [adr/index.md](docs/adr/index.md) |
| **Design docs** | Canonical designs for sweeping and console writes | [design/SWEEPING-PLAN.md](docs/design/SWEEPING-PLAN.md), [design/CONSOLE-WRITE-PLAN.md](docs/design/CONSOLE-WRITE-PLAN.md) |

Agents working in this repository should read [`AGENTS.md`](AGENTS.md) first —
it is the short, invariant-focused sheet these docs expand on.

## Verification

```bash
bun run typecheck        # backend + scripts
bun run typecheck:web    # frontend, also rejects unused symbols
bun run build:web        # required before the two scripts below
bun run scripts/smoke-test.ts   # payment state machine against a real Postgres
bun run scripts/api-test.ts     # merchant HTTP layer + checkout + SPA serving
bun run scripts/admin-test.ts   # backoffice API: filters, search, serialization
```

None of the three scripts calls a paid provider — they inject deposits and use
fixed rates through the same services the real workers call. Details, and what
each one actually proves: [docs/contributing/verification.md](docs/contributing/verification.md).

## Deploying

Railway, via the included `Dockerfile` and `railway.json`:
[docs/operations/deployment.md](docs/operations/deployment.md). Before serving a
mainnet or enabling sweeping with real value, read
[docs/operations/mainnet-checklist.md](docs/operations/mainnet-checklist.md).

## Status

Testnet-proven end to end, including partial payments, overpay, dust tolerance,
reorg handling, and treasury sweeping in dry run. Still ahead of real
third-party funds: remote (KMS/HSM/MPC) signing for mainnet sweeping (the
seam exists in `src/services/signer.ts`; the implementation does not), Tron
sweep execution (its pairings plan correctly today and resolve to
`skipped: unimplemented`), multi-source price medians, API-key rotation with an
overlap window, and the Colombian PSAV/DIAN legal evaluation. See
[docs/architecture/sweeping.md](docs/architecture/sweeping.md) and the ADRs for
what is deliberately deferred versus what is simply unbuilt.
