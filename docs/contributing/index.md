# Contributing

This page is the prose version of `AGENTS.md`, the short, agent-facing invariant
sheet at the repository root. If you are an AI coding agent working in this
repo, **read `AGENTS.md` first** — it is kept deliberately
short and is the canonical source for the rules below; this page exists for a
human contributor who wants the same rules with more room to breathe, plus links
into the rest of the documentation.

## Sources of truth

- **Bun**, one package: a Bun/Hono backend plus a Vite/SolidJS frontend under
  `web/`. Dependencies are locked by `bun.lock`.
- **`src/config.ts`** (`NETWORKS`, token and native definitions, confirmations,
  explorers, sweep mechanisms) is authoritative for supported chains and assets.
  `NETWORK_IDS` is the served subset — every testnet, plus the mainnets when
  `ENABLE_MAINNETS` is set — and it is what the API validates against and the
  supervisor starts workers for. `NETWORKS` keeps every definition regardless, so
  a payment taken on a network later withheld still renders in the console.
  [Architecture overview](../architecture/overview.md) and
  [Networks & assets](../guides/networks-and-assets.md) describe this registry;
  neither replaces reading it.
- **Schema changes start in `src/db/schema.ts`.** Run `bun run db:generate`,
  commit the generated file under `drizzle/`, apply with `bun run db:migrate`.
  See [Database](../operations/database.md).

## Setup

Full sequence: [Local development](../operations/local-development.md). In
short: `bun install`, copy `.env.example`, `bun run mnemonic:new --write`,
`db:up`, `db:migrate`, `seed`, `build:web`, `dev`. Never read, print, or commit
the real `.env` — it holds RPC keys and the mnemonic. Never point any of this at
a real or production environment, database, credential set, or funds unless
explicitly asked to.

## Verification overview

There is no lint script or test runner suite. Two independent typechecks plus
three standalone scripts stand in for both — see
[Verification](./verification.md) for the full picture, including what each one
actually proves and does not prove.

## Architecture invariants, summarised

The full list lives in `AGENTS.md` and is not repeated in full here to avoid two
copies drifting apart. The shape of it:

- Payment state transitions belong to `src/services/payments.ts`; chain workers
  feed its `registerDeposit`/`confirmDeposit` contract rather than duplicating
  settlement logic.
- Money is `bigint` in the smallest unit, always. Decimals are a property of the
  **(network, asset) pairing**, never the symbol. Raw amounts live in
  `numeric(78, 0)` columns, not `bigint` — an 18-decimal asset passes `int8` at
  ordinary amounts.
- Deposit idempotency is `(network, txHash, logIndex)`; state transitions run
  under row locks; a deposit in a different asset than the one quoted is
  recorded, never credited.
- A chain's own coin (BNB, POL, TRX) is not a token — see
  [Networks & assets](../guides/networks-and-assets.md#native-coins) and
  [Wallets & keys](../architecture/wallets-and-keys.md).
- Nothing in `src/` calls `console` directly — see
  [Observability](../architecture/observability.md) and
  [Conventions](./conventions.md).
- `/admin` is cross-merchant and read-mostly; every mutation needs a named
  operator and an audit row in the same transaction — see
  [Console](../architecture/console.md) and
  [ADR-0006](../adr/0006-operator-audit-on-mutation.md).
- Treasury sweeping is a fully independent subsystem: settlement is
  event-sourced and never reads a balance, so sweeping cannot corrupt it — see
  [Sweeping](../architecture/sweeping.md) and
  [ADR-0002](../adr/0002-event-sourced-settlement.md). The key boundary
  (`src/services/signer.ts`) is the seam a KMS/HSM/MPC signer will fill later —
  see [ADR-0007](../adr/0007-signer-boundary.md).

Read `AGENTS.md` for the authoritative wording of every rule above; this page
only groups and links them.
