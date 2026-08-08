# 0003 — Decimals are a property of (network, asset), not of the symbol

**Status:** Accepted

## Context

A symbol like `USDC` or `USDT` does not have one fixed number of decimals across
chains: this gateway's own registry defines USDC at 6 decimals on Ethereum
Sepolia, Base Sepolia and Polygon Amoy, but at **18** decimals on BSC testnet —
same symbol, same asset in the payer's mind, different contract with a different
`decimals()`. Native coins compound the point: BNB and POL are 18 decimals like
Ether, but TRX is 6, matching the TRC-20s beside it on Tron rather than EVM
convention. Any code path that hardcoded "USDC is 6 decimals" or "assume 6"
would mis-size every quote, every raw-amount comparison and every sweep on BSC
by twelve orders of magnitude.

## Decision

Decimals are looked up from the registry by the **pairing**, never inferred
from the symbol alone. `tokenFor(network, asset)` and `assetFor(network, asset)`
in `src/config.ts` are the only sanctioned lookups; both take a network and
return the decimals declared on that network's own token or native entry. No
helper exists that maps a bare symbol to a decimals count, which is a
deliberate omission — adding one would immediately be wrong for at least one
served network.

## Consequences

- Every quote (`copToRaw`), every stored raw amount, and every sweep computation
  reads decimals fresh from the registry for the specific (network, asset) pair
  involved, rather than caching or assuming a value.
- Adding a new network cannot silently inherit another network's assumption
  about a symbol it happens to share — the registry entry has to state its own
  decimals explicitly, and `scripts/sweep-probe.ts` cross-checks that figure
  against the deployed contract's own `decimals()` before a pairing may be
  marked sweepable.
- The console and API always attach `decimals` to any response carrying a raw
  amount, rather than letting a client infer it from the asset symbol — the same
  discipline the backend applies to itself.

*Source: `src/config.ts` (registry comments on `bsc-testnet` tokens and native
asset decimals); `AGENTS.md`; `README.md`.*
