# Testing report — crypto-gateway

**Date:** 2026-07-22
**Scope:** validate the app, validate the API, create 2 test wallets, create a transaction.
**Environment:** macOS (arm64) · Bun 1.3.14 · Docker 29.4.0 · PostgreSQL 16 (Docker, `localhost:5433`)
**Result:** Code, typechecks, and both test suites pass. Two external-service blockers
(CoinGecko COP price, Alchemy networks) stop the live on-chain paths — neither is a code bug.

> All values below are **testnet / development only** (throwaway keys, the public
> anvil/hardhat mnemonic). Never reuse any of them with real funds.

---

## 1. Summary

| Area | Check | Result |
|---|---|---|
| DB | `bun run db:migrate` | ✅ applied (Postgres already up & healthy) |
| Types | `bun run typecheck` (backend) | ✅ pass |
| Types | `bun run typecheck:web` (frontend) | ✅ pass |
| Build | `bun run build:web` | ✅ built (195.74 kB JS / 12 kB CSS) |
| Tests | `bun run scripts/smoke-test.ts` (state machine) | ✅ ALL PASSED — 24 checks |
| Tests | `bun run scripts/api-test.ts` (HTTP layer) | ✅ ALL PASSED |
| API | live endpoints on `:3000` | ✅ auth + read paths OK |
| API | live `POST /api/payments` | ⚠️ blocked by CoinGecko COP gap |
| Wallets | 2 test payer wallets | ✅ generated |
| Transaction | payment created + served live | ✅ `s6qv5p8a8zxy3n` |
| Chain | Alchemy testnet RPC | ⚠️ networks not enabled on the app |

---

## 2. Environment applied (`.env`)

```
DATABASE_URL=postgres://postgres:gateway@localhost:5433/gateway
ALCHEMY_SEPOLIA_KEY=<redacted>
ALCHEMY_BASE_SEPOLIA_KEY=<redacted>   # same key, both networks
HD_MNEMONIC="test test test test test test test test test test test junk"  # public anvil/hardhat mnemonic
QUOTE_TTL_MINUTES=15
GRACE_TTL_MINUTES=90
SPREAD_BPS=75          # 0.75%
DUST_TOLERANCE_BPS=50  # 0.5%
PORT=3000
```

Postgres was already running (`crypto_gateway_db`, healthy) and migrations were re-applied
idempotently (drizzle reported the schema/migrations table already existed).

---

## 3. App validation

### Migrations
```bash
bun run db:migrate
# [✓] migrations applied successfully!
```

### Typechecks
```bash
bun run typecheck       # tsc --noEmit            -> exit 0
bun run typecheck:web   # tsc -p web/tsconfig.json -> exit 0
```

### Web build
```bash
bun run build:web
# web/dist/index.html                 0.42 kB
# web/dist/assets/index-*.css        12.00 kB
# web/dist/assets/index-*.js        195.74 kB
# ✓ built in 91ms
```

### State-machine smoke test — `scripts/smoke-test.ts`
Exercises HD derivation, COP→raw rounding, deposit registration, confirmation/settlement,
partial→complete, overpayment, dust tolerance, idempotency, and webhook enqueue. **24/24 ok.**

- `copToRaw` rounding (exact + ceil never under-charges)
- dust threshold: 10 USDC → 9.95 USDC (0.5%)
- exact full payment: `pending → detecting → paid`, merchant credited 40,000 COP
- idempotent replay: no double credit on re-register / re-confirm
- partial → complete: credited full 40,000 COP once
- overpayment: `overpaidRaw = 2 USDC`, credited original amount only
- dust tolerance: 99.6% → paid
- webhooks: 4 × `payment.paid` + `payment.partially_paid` enqueued

### HTTP-layer test — `scripts/api-test.ts`
Routing, api-key auth, EIP-681/QR checkout rendering, public status, SPA + static assets.
**ALL PASSED.** (Requires `bun run build:web` first — it asserts the SPA bundle is served.)

---

## 4. API validation (live, running server on `:3000`)

Seeded a demo merchant:
```bash
bun run seed
# Client created: bc81d6f6-1f86-4d47-9457-a8868ab08726
# API KEY: gk_test_<redacted — shown once, at seed time>
```

| Request | Expected | Actual |
|---|---|---|
| `GET /health` | 200 `{ok:true}` | ✅ `{"ok":true}` |
| `GET /api/me` (no key) | 401 | ✅ 401 |
| `GET /api/me` (bad key) | 401 | ✅ 401 |
| `GET /api/me` (valid key) | 200 | ✅ `{"name":"Cliente Demo","balance_cop":"0"}` |
| `POST /api/payments` (valid key) | 201 | ⚠️ 400 `{"error":"cannot_create_payment","details":"No COP price for USDC"}` |

The `POST` failure is the CoinGecko COP blocker (see §7.1), not an auth/routing defect.

---

## 5. Test wallets — `scripts/wallets.ts`

Two **fresh testnet payer wallets** (fund from `faucet.circle.com` for test USDC + an ETH
faucet for gas, then pay a checkout):

Private keys are deliberately not recorded here — `scripts/wallets.ts` prints a fresh pair
on demand, so a committed file never has to carry one.

| # | Address |
|---|---|
| 1 | `0xFBA20980e4FbDF1905cE51E43E6E302293FDD6CA` |
| 2 | `0xFaC4C3CB03E82C87916D9Ac7C7fa316d894588E2` |

Gateway **HD receiving** addresses (derived from `HD_MNEMONIC`, `m/44'/60'/0'/0/i`) — these
match the canonical anvil/hardhat sequence, confirming derivation is correct:

| Path | Address |
|---|---|
| `m/44'/60'/0'/0/0` | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` |
| `m/44'/60'/0'/0/1` | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` |

---

## 6. Transaction created — `scripts/create-payment.ts`

Because the live rate path is blocked (§7.1), the payment was created with a **fixed frozen
rate** (mirrors `src/services/payments.ts:createPayment`, injecting the rate instead of
calling CoinGecko). It is a genuine payment row with a unique HD-derived address.

```
merchant      : Cliente Demo (bc81d6f6-1f86-4d47-9457-a8868ab08726)
publicId      : s6qv5p8a8zxy3n
status        : pending
amount_cop    : 50000 COP
amount_usdc   : 12195122 raw (12.195122 USDC)
frozen_rate   : 4100 COP/USDC
network       : base-sepolia (chainId 84532)
pay-to addr   : 0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc  (index 5)
quote_expires : 2026-07-23T04:48:59.998Z
checkout_url  : http://localhost:3000/pay/s6qv5p8a8zxy3n
EIP-681 URI   : ethereum:0x036CbD53842c5426634e7929541eC2318f3dCF7e@84532/transfer?address=0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc&uint256=12195122
```

### Verified live through the running server
- `GET /api/payments/s6qv5p8a8zxy3n` (authed) → 200, full payment JSON with metadata.
- `GET /public/payments/s6qv5p8a8zxy3n/checkout` → 200 with EIP-681 `payment_uri`, QR
  `data:image/png;base64,…`, `decimals: 6`.
- `GET /pay/s6qv5p8a8zxy3n` (Solid SPA) → 200.

> To settle it end-to-end once Alchemy is enabled (§7.2): send **12.195122 USDC** on
> Base Sepolia from a test wallet (§5) to `0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc`.
> The watcher/confirmer will advance `pending → detecting → paid` and credit 50,000 COP.

---

## 7. Blockers found (external services, not code bugs)

### 7.1 CoinGecko can't price COP on the free tier
`src/services/rates.ts` calls `simple/price?ids=usd-coin&vs_currencies=cop`. The free public
API now returns an empty object for COP and 429s on multi-currency requests:

```
vs_currencies=usd       -> {"usd-coin":{"usd":0.999748}}       # works
vs_currencies=cop       -> {"usd-coin":{}}                     # empty -> throws "No COP price for USDC"
vs_currencies=usd,cop   -> 429 rate limit
```

So live `POST /api/payments` fails at the quote step.
**Fix options:** add a CoinGecko **demo/pro API key** (COP is supported on keyed tiers); or
add a fallback rate source / USD→COP FX; or seed the rate cache for demos.

### 7.2 Alchemy networks not enabled on the app
The key is **valid** and authenticates to app `fr6vbjctcxwfepig`, but the networks are off:

```
eth-sepolia  -> "ETH_SEPOLIA is not enabled for this app."
base-sepolia -> "BASE_SEPOLIA is not enabled for this app."
```

So the watcher/confirmer can't observe on-chain `Transfer` events.
**Fix:** enable **Ethereum Sepolia** and **Base Sepolia** at
`https://dashboard.alchemy.com/apps/fr6vbjctcxwfepig/networks` (one key serves both once
enabled — the same key in both env vars is fine).

---

## 8. Scripts added by this run

| File | Purpose |
|---|---|
| `scripts/wallets.ts` | Generate 2 fresh testnet payer wallets + print gateway HD receiving addresses. |
| `scripts/create-payment.ts` | Create a payment with a fixed frozen rate (bypasses the CoinGecko COP gap). Args: `[clientId] [amountCop] [network]`. |

Both follow the existing `scripts/` conventions (`seed.ts`, `smoke-test.ts`, `api-test.ts`).

---

## 9. Reproduce

```bash
bun install
bun run db:up                 # Postgres (Docker) on localhost:5433
bun run db:migrate
bun run typecheck
bun run typecheck:web
bun run build:web             # required before api-test
bun run scripts/smoke-test.ts
bun run scripts/api-test.ts
bun run seed                  # -> API key (shown once)
bun run start                 # API + workers on :3000

# wallets + a transaction
bun run scripts/wallets.ts
bun run scripts/create-payment.ts <clientId> 50000 base-sepolia
```
