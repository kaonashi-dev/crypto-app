# 0007 — The signer boundary and the remote-signing seam

**Status:** Accepted

## Context

Treasury sweeping needs to produce signatures — EIP-712 typed-data
authorizations, raw EVM transactions, Tron digest signatures. Today those keys
are derived in-process from `HD_MNEMONIC`, which is the only option that makes
sense for a testnet MVP but is unacceptable for real value: it gives an
always-on, internet-facing process the standing ability to move money, with no
hardware boundary and no separate approval step. The gateway needs to be able
to upgrade to KMS/HSM/MPC custody later without that upgrade being a rewrite of
every call site that currently signs something.

## Decision

Every signature the gateway produces goes through the `Signer` interface in
`src/services/signer.ts` — `addressFor`, `signTypedData`, `signTransaction`,
`signDigest`, `fingerprint` — addressed by a `KeyRef` (`role` + `family` +
optional derivation index) rather than by a raw key. `LocalSigner` is the only
implementation today, and the module's own rule is load-bearing: **no module
outside `signer.ts` may import `derivation.ts` for key purposes** —
`deriveEvmAccount`/`deriveTronKey` are private to this file; address derivation
alone is re-exported through `wallet.ts` for the payment path, which never
needs to sign.

The boundary is enforced, not just documented: `getSigner()` throws for any
`SWEEP_SIGNER` value other than `local`, and `preflightSweeping()` in
`src/config.ts` refuses to boot a build that combines `SWEEP_ENABLED`, a served
mainnet, `SWEEP_SIGNER=local`, and `SWEEP_DRY_RUN` off — the exact combination
that would let an in-process key sign a real-value movement. `remote` is the
named seam for a future KMS/HSM/MPC client; it does not exist yet, and asking
for it fails loudly rather than silently falling back to local keys.

Three key roles are also kept structurally apart: **deposit** keys (one per
payment, can sign, release funds sitting at them), **relayer** keys (one per
family, hold only gas, pay for sweeps), and the **treasury** address, which is
a destination the gateway never holds a key for at all — no amount of process
compromise reaches consolidated funds through it.

## Consequences

- Upgrading custody to a real KMS/HSM/MPC provider is a new class implementing
  `Signer`, not a search-and-replace across the sweeper, `evm-sweep.ts`, or any
  worker — every caller already goes through the interface.
- The mainnet + local-signer combination cannot ship by accident: the same
  preflight mechanism that guards the public-mnemonic check on a served
  mainnet also guards this, so a build capable of serving real value is
  already the build that enforces the boundary.
- Until `remote` is implemented, real-value sweeping on a mainnet is only
  possible in dry-run — planned and logged, never signed — which is the
  intended state, not a workaround.

*Source: `src/services/signer.ts` (module docblock); `src/config.ts`
(`preflightSweeping`); `docs/design/SWEEPING-PLAN.md` §5, §10.*
