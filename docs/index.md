# crypto-gateway

A crypto payment gateway that charges are denominated in **Colombian pesos (COP)**
and payable in stablecoins or in a chain's own coin, across EVM testnets and Tron.
Each payment gets a unique HD-derived address, is detected on-chain, confirmed,
and — once settled — credits the merchant's COP balance and fires a signed
webhook.

Stack: Bun + Hono (backend), SolidJS + TanStack Query/Router (frontend), Drizzle
ORM + PostgreSQL, viem + Alchemy for EVM, TronGrid for Tron.

## Two ways to use this documentation

**Integrating a merchant?** Start at [Quickstart](/guides/quickstart) — API key,
create a payment, open the checkout, poll status, receive a webhook, all with
runnable `curl` commands. Then:

- [Authentication](/guides/authentication) — `X-Api-Key`, key prefixes, rotation
- [Payments](/guides/payments) — create / get / status / `me`
- [Checkout](/guides/checkout) — the hosted `/pay/:publicId` page, QR, on-demand check
- [Webhooks](/guides/webhooks) — events, HMAC signature verification, retries
- [Networks & assets](/guides/networks-and-assets) — what you can quote, and its decimals
- [API reference](/api/) — every route, request/response fields, error shapes

**Operating or contributing to the gateway?** Read the [Architecture
overview](/architecture/overview) for the payment lifecycle, workers and
invariants, then [Operations → Local development](/operations/local-development)
to run it. The [Console API](/api/console) documents the `/admin` backoffice
(read routes plus the small, audited write surface), and
[Contributing](/contributing/) covers repository conventions and verification
(`bun run typecheck`, the standalone test scripts).

## Networks at a glance

Full table, decimals, and the native-vs-token distinction:
[Networks & assets](/guides/networks-and-assets). Registry source:
`NETWORKS` in `src/config.ts`.

| Network | Family | Testnet | Assets | Confirmations |
|---|---|---|---|---|
| `eth-sepolia` | EVM | yes | USDC | 5 |
| `base-sepolia` | EVM | yes | USDC | 3 |
| `bsc-testnet` | EVM | yes | USDT, USDC, **BNB** | 12 |
| `polygon-amoy` | EVM | yes | USDC, **POL** | 64 |
| `tron-nile` | Tron | yes | USDT, **TRX** | 19 |
| `bsc` *(withheld)* | EVM | no | USDT, USDC, **BNB** | 15 |
| `polygon` *(withheld)* | EVM | no | USDC, USDT, **POL** | 128 |

Assets in bold are a chain's own coin, not a token. `bsc` and `polygon` are
defined in the registry but not served (`NETWORK_IDS` excludes them) unless
`ENABLE_MAINNETS` is set — a historical payment on one still renders, but the
API will not quote or derive an address on it.

## Where things live

- [API reference](/api/) — conventions, merchant/public/console routes, errors
- [Architecture](/architecture/overview) — payment lifecycle, workers, data model, invariants
- [Operations](/operations/local-development) — running, configuring, deploying, troubleshooting
- [Contributing](/contributing/) — repository guide and verification steps
