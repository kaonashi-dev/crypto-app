# Mainnet checklist

`bsc` (USDT, USDC, BNB) and `polygon` (USDC, USDT, POL) are defined in the
registry (`src/config.ts`) but **not served** unless `ENABLE_MAINNETS=true`.
Withheld is not the same as absent: both definitions stay loaded, so a payment
already taken on one still renders in the console and resolves its explorer
links — the flag only controls whether the API will quote the network or derive
a fresh address on it. `GET /admin/api/diagnostics` reports both facts per
network (`offered`, `enabled`).

The flag is deliberately **not inferred** from whether an Alchemy key is present
— a network with no key still hands out addresses, it just never watches them.

## Before flipping `ENABLE_MAINNETS=true`

- [ ] **Generate a private mnemonic.** `bun run mnemonic:new --write`. The
      preflight refuses to boot when a publicly known `HD_MNEMONIC`
      (hardhat/anvil, ganache, the BIP-39 test vector) meets any *offered*
      mainnet — every address the gateway would hand a payer has a published
      private key otherwise. Because `hd_counter.seed_fingerprint` binds the
      database to one tree, rotating the mnemonic also means a fresh database
      (or, only on a testnet where the orphaned addresses hold nothing worth
      recovering, resetting the fingerprint column — see
      [Local development](./local-development.md)).
- [ ] **Fund a relayer, if sweeping.** The relayer key derives from
      `HD_MNEMONIC` at BIP-44 account 1 and needs a small balance of each
      chain's fee currency before it can broadcast anything.
- [ ] **Set both Alchemy keys you intend to serve.** `ALCHEMY_BSC_KEY`,
      `ALCHEMY_POLYGON_KEY`. Unset means the network is offered but unwatched —
      payments would be created but never detected.
- [ ] **Understand the confirmation wait.** 15 blocks on BSC, 128 on Polygon
      (~4 minutes) before a payment settles — both deliberately conservative
      for mainnet finality.
- [ ] **Decide on sweeping before funds accumulate.** Nothing here moves funds
      out of deposit addresses automatically until `SWEEP_ENABLED` is set — see
      the [sweeping runbook](./sweeping-runbook.md). Real value sitting at
      per-payment addresses is the expected state either way; sweeping is how
      you consolidate it, not a precondition for accepting it.

## The remote-signer gate

`preflightSweeping()` enforces a second, independent boundary once sweeping is on:

> `SWEEP_ENABLED` + a served mainnet + `SWEEP_SIGNER=local` + `SWEEP_DRY_RUN` off
> → **refuses to boot.**

An always-on process may not hold the keys that move real value. The only ways
past this gate on a mainnet build:

1. Set `SWEEP_SIGNER=remote` — not implemented yet (`getSigner()` throws;
   this is the Phase 6 KMS/HSM/MPC seam in
   [docs/design/SWEEPING-PLAN.md](../design/SWEEPING-PLAN.md)), or
2. Keep `SWEEP_DRY_RUN` on — candidates are planned and logged, never signed, or
3. Leave `ENABLE_MAINNETS` unset and serve testnets only.

This is the same public-mnemonic mechanism reused: a build that can serve a
mainnet is already the thing that arms both checks, so the custody boundary is
enforced by construction rather than left as a policy someone has to remember.
See [ADR-0007](../adr/0007-signer-boundary.md).

## Also required for a served mainnet family

`TREASURY_ADDRESS_EVM` and/or `TREASURY_ADDRESS_TRON` — whichever families are
served — must be set and well-formed before `SWEEP_ENABLED` will boot at all,
regardless of the signer/dry-run gate above. See
[Configuration](./configuration.md#treasury-sweeping).
