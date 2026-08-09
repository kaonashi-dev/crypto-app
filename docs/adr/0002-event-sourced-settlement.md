# 0002 — Event-sourced settlement, never `balanceOf`

**Status:** Accepted

## Context

Treasury sweeping (moving value out of per-payment deposit addresses into a
consolidated treasury) has to coexist with the payment state machine without
being able to corrupt it. A design where the payment path ever asked "what is
this address's balance right now" would make settlement dependent on *when* a
sweep happened to run: emptying an address mid-grace on a `partially_paid`
payment could make a later top-up look like the payment's *first* deposit
instead of its continuation, or a settled payment's confirmed sum could shrink
retroactively once its address was swept.

## Decision

`registerDeposit` and `confirmDeposit` in `src/services/payments.ts` accumulate
`confirmed_raw`/`pending_raw` **only** from `Transfer` log data (EVM) and native
transfer data read from block bodies (native coins, Tron). There is no
`balanceOf`, no `eth_getBalance`, and no `readContract` anywhere in the payment
path. Sweeping is built as a fully separate subsystem on top of this guarantee
(`src/services/sweeper.ts`, `src/workers/sweeper.ts`): it sums confirmed
deposits minus confirmed sweeps from the `deposits`/`sweeps` tables — itself
event-sourced, never a live balance read — to decide what remains to move.

The one deliberate exception is reconciliation (`src/workers/sweep-recon.ts`),
which reads `balanceOf`/`getBalance` explicitly for auditing and writes to
nothing in the payment or sweep tables — it exists to *detect* drift between
the ledger and the chain, not to feed either.

## Consequences

- Sweeping an address at any moment — including mid-grace on a partially paid
  payment — cannot change what that payment settles at. The address stays
  usable after being swept, and a later top-up to the same (now empty) address
  is still detected and credited normally.
- Sweeping and the payment state machine never coordinate and can never race
  each other, which is what lets sweeping ship as an independently testable
  subsystem (`scripts/sweep-test.ts`) without touching `smoke-test.ts`'s
  assumptions.
- Reconciliation is the one place a balance read is legitimate, and it is
  scoped narrowly on purpose: it never writes to `payments`, `deposits`, or
  `sweeps`, so the exception cannot be mistaken for a second settlement path.

*Source: `src/services/sweeper.ts:9-20`; `src/workers/sweep-recon.ts` (module
docblock).*
