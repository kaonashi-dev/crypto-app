# Networks & assets

Source of truth: `NETWORKS` in `src/config.ts`. `NETWORK_IDS` is the subset
actually offered — every testnet, plus the two mainnets below only when
`ENABLE_MAINNETS` is set. Validate and iterate over `NETWORK_IDS`; `NETWORKS`
keeps every definition (including withheld mainnets) so a historical payment
on one still renders in the console.

## Served today (testnets)

| Network | Family | Tokens (decimals) | Native coin (decimals) | Confirmations | Credential env |
|---|---|---|---|---|---|
| `eth-sepolia` | EVM | USDC (6) | — (not accepted) | 5 | `ALCHEMY_SEPOLIA_KEY` |
| `base-sepolia` | EVM | USDC (6) | — (not accepted) | 3 | `ALCHEMY_BASE_SEPOLIA_KEY` |
| `bsc-testnet` | EVM | USDT (18), USDC (18) | **BNB** (18) | 12 | `ALCHEMY_BSC_TESTNET_KEY` |
| `polygon-amoy` | EVM | USDC (6) | **POL** (18) | 64 | `ALCHEMY_AMOY_KEY` |
| `tron-nile` | Tron | USDT (6) | **TRX** (6) | 19 | none (TronGrid serves Nile keyless; `TRONGRID_API_KEY` only raises a rate limit) |

## Defined but withheld (mainnets)

Registered in `NETWORKS`, excluded from `NETWORK_IDS` unless
`ENABLE_MAINNETS=true` — the API will not quote or derive an address on these
otherwise, though a payment already taken on one still resolves and renders.

| Network | Family | Tokens (decimals) | Native coin (decimals) | Confirmations | Credential env |
|---|---|---|---|---|---|
| `bsc` | EVM | USDT (18), USDC (18) | **BNB** (18) | 15 | `ALCHEMY_BSC_KEY` |
| `polygon` | EVM | USDC (6), USDT (6) | **POL** (18) | 128 | `ALCHEMY_POLYGON_KEY` |

Turning `ENABLE_MAINNETS` on is not a formality — it is what makes the
mnemonic's derived addresses hold real value, and it arms the preflight check
that refuses to boot on a publicly known seed. See [Operations → Mainnet
checklist](/operations/mainnet-checklist).

## Decimals are a property of the *pairing*, never the symbol

USDC is 6 decimals on `eth-sepolia`/`base-sepolia`/`polygon-amoy`/`polygon`,
but **18** on `bsc-testnet`/`bsc`. USDT is 18 on BSC and 6 everywhere else it
appears. The native coins are 18 decimals on every EVM network here and 6 on
Tron (TRX is quoted in sun, like the TRC-20 beside it). Nothing in the code
assumes 6 — always read `decimals` from the registry (`tokenFor` /
`assetFor`) or from an API response's own `decimals` field, never hardcode
it per symbol. Raw amounts are stored in `numeric(78, 0)` columns for exactly
this reason: an 18-decimal amount at everyday values exceeds what a
Postgres `bigint` (int8, ~9.22×10¹⁸) can hold.

## Not every symbol exists on every network

`asset` and `network` are each validated against a flat enum (`ASSETS`,
`NETWORK_IDS`), but a specific **pairing** can still be unsupported — the enums
alone can't express that. Notable gaps:

- **`USDT` on `polygon-amoy`** — Tether publishes no canonical Amoy deployment; the pairing simply does not exist.
- **`USDC`/`USDT` are never payable on `bsc`/`bsc-testnet`'s or `polygon`'s native coin route** — `BNB`/`POL` are separate assets from the stablecoins on the same network, not a fallback for them.
- **`eth-sepolia` and `base-sepolia` accept no native coin at all** (`native: null`) — this gateway quotes stablecoins there only, even though ETH still exists on those chains.

`createPayment` rejects an unsupported pairing at request time
(`cannot_create_payment`, 400) rather than the schema silently allowing it.

## Native coin vs. token

A chain's own coin (BNB, POL, TRX) is **not a token** and does not share the
token detection path: it emits no `Transfer` event, so it cannot be filtered,
subscribed to, or fetched with `eth_getLogs`. It is found by reading blocks
(`workers/native-watcher.ts`) or, on Tron, the account's transaction list.
Consequences that show up across the API and the codebase:

- Its deposits carry `logIndex = -1` (a sentinel; real log indexes start at 0).
- Its EIP-681 checkout URI addresses the payee directly with `value=`, instead of calling `transfer` on a contract.
- It has no contract address — use `assetFor(network, asset)`, which is
  tagged (`kind: "native" | "token"`), rather than `tokenFor`, which only
  covers contract-backed assets.
- Detection reads nothing while no payment is quoted in a native coin —
  a native watcher has no event filter to lean on, so it costs roughly one RPC
  call per block for as long as any native-coin payment is open. Quoting a
  stablecoin avoids that cost entirely.

## Explorers and addresses

Each network carries `explorer.tx` / `explorer.address` URL templates (`{v}`
substituted with the hash/address) — the shapes differ per explorer family
(Etherscan-style `/tx/:hash` vs. Tronscan's hash-router
`/#/transaction/:hash`), which is why the console reads them from the
registry rather than building one URL scheme.

Addresses derive per family: EVM at `m/44'/60'/0'/0/i`, Tron at
`m/44'/195'/0'/0/i` — see [Architecture → Wallets &
keys](/architecture/wallets-and-keys).

## Faucets and diagnostics

See [Testing](/guides/testing) for faucet links per network, and
`GET /admin/api/diagnostics` (or `/stats`) for which networks are currently
`offered` and `enabled` (offered *and* holding a working RPC credential) — see
[Console API](/api/console).
