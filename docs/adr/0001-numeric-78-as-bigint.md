# 0001 — `numeric(78,0)` as the raw-amount column type

**Status:** Accepted

## Context

Every on-chain amount in this gateway — `amount_crypto_raw`, `confirmed_raw`,
`pending_raw`, `overpaid_raw`, `amount_raw` on deposits and sweeps — is an
integer in the asset's smallest unit, and the TypeScript side represents it as
`bigint` everywhere. Postgres's `int8` (a native `bigint` column) tops out at
roughly 9.22 × 10¹⁸. An 18-decimal asset blows through that at ordinary
transaction sizes: 50,000 COP of BEP20 USDT is already ~1.2 × 10¹⁹ wei, and even
POL (18 decimals) passes `int8` at around 7,700 COP. Postgres does not round an
`int8` overflow — it raises `numeric field overflow`, which would fail to record
a deposit that is already confirmed on-chain, losing a payment the gateway has
already been paid for.

## Decision

Store every raw on-chain amount in a `numeric(78, 0)` column — precision 78,
scale 0 — read and written through Drizzle's `mode: "bigint"`, which keeps the
TypeScript side exactly as it was: `bigint` in, `bigint` out, never a float. 78
digits is the decimal width of `uint256`, so no ERC-20 amount can exceed it. The
helper lives once in `src/db/schema.ts`:

```ts
const rawAmount = (name: string) =>
  numeric(name, { precision: 78, scale: 0, mode: "bigint" });
```

COP amounts (`amount_cop`, `balance_cop`) stay `bigint`/`int8`: COP has no
decimals and no realistic COP figure approaches `int8`'s ceiling, so the wider
column would be cost with no corresponding safety.

## Consequences

- No raw amount can silently overflow its column regardless of which network or
  decimals count it belongs to — the type is sized for the worst case
  (`uint256`) rather than for today's assets.
- Every raw-amount field needs the same `mode: "bigint"` treatment; a column
  added without it would compile (Drizzle would infer `string`) but violate the
  bigint-everywhere convention silently, which is why `rawAmount()` is the only
  way any of these columns are declared.
- API and console JSON responses must serialize every bigint amount as a
  string — `JSON.stringify` throws on a raw bigint — which is why every response
  builder in `src/api/` routes bigint fields through an explicit `s()` helper
  rather than spreading a row.

*Source: `src/db/schema.ts:7-21`.*
