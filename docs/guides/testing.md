# Testing

## Faucets

| Network | Faucet | Gets you |
|---|---|---|
| `eth-sepolia`, `base-sepolia`, `polygon-amoy` | [faucet.circle.com](https://faucet.circle.com) | Test USDC (pick the network) |
| `bsc-testnet` | [bnbchain.org/en/testnet-faucet](https://www.bnbchain.org/en/testnet-faucet) | Test BNB — both gas and a payable asset here |
| `polygon-amoy` | [faucet.polygon.technology](https://faucet.polygon.technology) | Test POL |
| `tron-nile` | [nileex.io/join/getJoinPage](https://nileex.io/join/getJoinPage) | Test TRX and test USDT |

You also need each EVM network's gas coin (ETH on Sepolia/Base Sepolia — the
gateway does not quote it, but a payer's wallet still needs it to send a
transfer). Verify token contract addresses against Circle's docs before
relying on them; they can change.

## Generating test wallets

```bash
bun run scripts/wallets.ts
```

Prints two fresh, throwaway **payer** wallets (address + private key, for
funding from a faucet and using to pay a checkout — testnet only, never for
real funds), plus the gateway's own HD **receiving** addresses derived from
`HD_MNEMONIC` at indexes 0 and 1, for reference.

## Creating a payment without the API

```bash
bun run scripts/create-payment.ts [clientId] [amountCop] [network] [asset]
```

Mirrors `createPayment()` in `src/services/payments.ts` but injects a fixed
frozen rate (4,100 COP per token) instead of calling out to CoinGecko, so it
is deterministic and works offline. Defaults: the newest client, 50,000 COP,
`base-sepolia`, and the network's default stablecoin (`USDT` on Tron, `USDC`
on EVM). Prints the checkout URL and the EIP-681 URI.

```bash
bun run scripts/create-payment.ts "" 50000 tron-nile
```

## Postman / HTTPie collection

`docs/crypto-gateway.postman_collection.json` (in the repository root of
`docs/`, alongside this site) is every route, ordered as you'd actually drive
it — create a charge, watch it settle, inspect it from the console. Import
into Postman, Insomnia, Bruno, or HTTPie Desktop (Postman v2.1 is its
interchange format).

Collection variables to set first:

| Variable | Value |
|---|---|
| `baseUrl` | `http://localhost:3000` for local |
| `apiKey` | from `bun run seed`, printed once |
| `adminUser` / `adminPassword` | the console operator (`ADMIN_USER`, default `samuel`) and `ADMIN_PASSWORD` — run the Console folder's "Sign in" request once first |
| `publicId` | leave empty; "Create payment" fills it, so later requests follow the payment you just made |

Auth is set per folder: Merchant API sends `X-Api-Key`, the Console signs in
once and rides the session cookie, and the public checkout routes send
nothing.

## Standalone test scripts

None of these touch CoinGecko, an FX provider, Alchemy, or TronGrid — they use
fixed rates and inject deposits through the same service functions the
workers call. Each does need a migrated PostgreSQL database
(`DATABASE_URL`), and none clean up after themselves — use a disposable
development database.

```bash
bun run build:web               # required before api-test/admin-test (they assert SPA serving)
bun run scripts/smoke-test.ts   # state machine: partial, complete, overpay, dust, idempotency
bun run scripts/api-test.ts     # HTTP layer: auth, checkout endpoint (EIP-681/QR), SPA + assets
bun run scripts/admin-test.ts   # backoffice API: filters, tx-hash search, detail joins, bigint serialization
```

`smoke-test.ts` also runs the global expiry routine and can expire unrelated
stale rows in whatever database it points at — another reason to keep this
disposable.

Each script's first import is `./quiet`, which drops the service log to
`warn` so the `ok`/`FAIL` lines stay readable; override it to watch the
machinery work:

```bash
LOG_LEVEL=debug bun run scripts/smoke-test.ts
```

## Typechecking

There is no lint script or test runner beyond the scripts above. Run both
independent typechecks:

```bash
bun run typecheck        # src/ and scripts/
bun run typecheck:web    # web/src/ — also rejects unused symbols
```

See [Contributing → Verification](/contributing/verification) for the full
checklist.
