# Architecture decision records

Nine records, mined from rationale that already existed as code comments rather
than invented after the fact — each links back to the source it was mined from.
Format is short Nygard (Status, Context, Decision, Consequences).

| # | Title | Area |
|---|---|---|
| [0001](./0001-numeric-78-as-bigint.md) | `numeric(78,0)` as the raw-amount column type | Data model |
| [0002](./0002-event-sourced-settlement.md) | Event-sourced settlement, never `balanceOf` | Payments / sweeping |
| [0003](./0003-decimals-per-pairing.md) | Decimals are a property of (network, asset), not of the symbol | Data model |
| [0004](./0004-in-process-workers.md) | In-process workers over a queue | Workers |
| [0005](./0005-console-read-write-split.md) | Console read/write router split | Console |
| [0006](./0006-operator-audit-on-mutation.md) | Operator identity and an audit row on every mutation | Console |
| [0007](./0007-signer-boundary.md) | The signer boundary and the remote-signing seam | Sweeping / custody |
| [0008](./0008-sweeps-no-payment-fk.md) | `sweeps` has no foreign key to `payments` | Sweeping |
| [0009](./0009-sweep-probe-gate.md) | A pairing is swept only after the probe confirms it | Sweeping |
