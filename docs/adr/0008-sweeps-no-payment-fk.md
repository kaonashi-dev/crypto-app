# 0008 — `sweeps` has no foreign key to `payments`

**Status:** Accepted

## Context

A sweep moves value out of a deposit address. It would seem natural for a
`sweeps` row to reference the `payment` whose address is being swept — every
other on-chain table in the schema (`deposits`, `ledger_entries`, `webhook_jobs`)
references `payments`. But an address can hold value that no single payment
claims cleanly: several deposits (a payment's own, plus a later one after it
went terminal), a deposit in an asset the payment never quoted (recorded but
never credited — see the mismatch guard in `services/payments.ts`), or a
transfer that matches no payment row at all, since the same BIP-32 key that
derives a deposit address on one EVM chain derives the identical address on
every EVM chain, including ones this gateway does not serve.

## Decision

`sweeps` (`src/db/schema.ts`) carries `network`, `address`, `asset` and a
`derivation_index` — never a `payment_id` or `deposit_id`. A sweep is about
*an address and an asset*, not a payment. Candidate selection
(`src/services/sweeper.ts`) sums confirmed `deposits` grouped by
`(address, asset)` directly, independent of which payment(s) those deposits
belonged to or whether they ever settled one.

## Consequences

- The sweeper can recover exactly the funds most likely to be stranded — value
  from a deposit its payment never quoted, or from no payment at all — which
  coupling `sweeps` to `payments` would make invisible to it by construction.
- Nothing in `sweeps` is read by the payment state machine, and nothing in the
  payment state machine writes to `sweeps` — reinforcing
  [ADR-0002](./0002-event-sourced-settlement.md)'s independence rather than
  creating a second path between the two tables.
- A console view showing "which payments does this sweep relate to" is not a
  simple join — it has to be derived from `(network, address, asset)` against
  `deposits`/`payments` at query time, same as the sweeper itself does, rather
  than read off a foreign key.

*Source: `src/db/schema.ts:229-244` (the `sweeps` table docblock).*
