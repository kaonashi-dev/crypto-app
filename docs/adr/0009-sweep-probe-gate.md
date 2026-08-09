# 0009 — A pairing is swept only after the probe confirms it

**Status:** Accepted

## Context

Whether an EVM token can be swept without first sending it gas depends on
EIP-3009 (`transferWithAuthorization`), which is signed off-chain against the
contract's exact EIP-712 domain (`name()`, `version()`, `chainId`,
`verifyingContract`). Deployments genuinely differ — `name()` reads "USD Coin"
on some deployments and "USDC" on others; `version()` is "1" or "2" — and
guessing wrong produces a signature that fails on-chain **after** a ledger row
already exists for it. Assuming a mechanism from the symbol alone (`assets USDC
→ assume EIP-3009 everywhere`) is exactly the class of mistake this would
produce, and it would fail expensively and late rather than cheaply and early.

## Decision

A (network, asset) pairing is never marked sweepable by inference. It becomes
sweepable only after `bun run scripts/sweep-probe.ts` — the one script in the
repository that touches a chain, and only through view/constant calls, never a
signature or a broadcast — confirms the mechanism directly against the deployed
contract: EIP-3009 support via `authorizationState`, and the resolved domain's
hash cross-checked against the contract's own `DOMAIN_SEPARATOR()`. Only then
does a human add a `sweep: { via: … }` field to that pairing's entry in
`src/config.ts`'s `NETWORKS` registry. `sweepFor()` returns `undefined` for
every pairing without one, which is the safe default: an unprobed asset simply
accumulates, exactly as it always has.

The registry comments record this explicitly per pairing — Sepolia's USDC is
marked `sweep: { via: "eip3009" }` because the probe reached it and verified
the domain; Base Sepolia's USDC (registry-adjacent, also a Circle FiatToken,
almost certainly EIP-3009) is deliberately left **without** a `sweep` field,
because the probe could not reach that network to confirm it. "Almost
certainly" is not a verdict this gate accepts.

## Consequences

- No pairing can be swept on an assumption, including a reasonable one — the
  gate is the same for a token that is "obviously" the same standard as one the
  probe already cleared.
- Adding a network's sweep capability is a two-step, human-reviewed process
  (run the probe, read its verdict, add the registry field) rather than a
  one-line config change — deliberately, since the cost of being wrong is a
  signature nobody can spend and a ledger row describing a movement that never
  happened.
- The probe's report distinguishes "blocked" / "unknown" / "unreachable" from a
  verified mechanism precisely so that a later re-run — after an RPC key is
  added, say — can promote a pairing without anyone having to remember which
  ones were previously unresolved rather than confirmed absent.

*Source: `scripts/sweep-probe.ts` (module docblock); `src/config.ts`
(`sweepFor`, registry comments on `base-sepolia`/`bsc`/`polygon` tokens);
`docs/design/SWEEPING-PLAN.md` §4.2, §4.5.*
