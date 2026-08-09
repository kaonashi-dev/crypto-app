# Sweeping runbook

Consolidating per-payment deposit addresses into one treasury per family. Full
design and rationale: [docs/design/SWEEPING-PLAN.md](../design/SWEEPING-PLAN.md).
Architecture summary: [Sweeping](../architecture/sweeping.md). This page is the
operational sequence: probe → dry-run → enable → reconcile → what to watch.

**The invariant that makes every step below low-risk:** settlement is
event-sourced from Transfer logs and never reads a balance. Sweeping an address
at any moment — including mid-grace on a `partially_paid` payment — cannot change
what that payment settles at. See
[ADR-0002](../adr/0002-event-sourced-settlement.md).

## 1. Probe

Before any pairing can be swept, confirm the mechanism against the contract
itself rather than assuming it:

```bash
bun run scripts/sweep-probe.ts                    # every served network
bun run scripts/sweep-probe.ts --network eth-sepolia
```

This is the one script that touches a chain, and every call it makes is a
view/constant call — it reads, never signs, never broadcasts. It reports, per
(network, asset): the on-chain `symbol()`/`decimals()` against the registry, and
for EVM tokens whether `authorizationState` (EIP-3009) answers and whether the
resolved EIP-712 domain's hash matches the contract's own `DOMAIN_SEPARATOR()`.
A pairing only becomes sweepable once its registry entry in `src/config.ts`
carries a `sweep: { via: … }` field — the probe's output tells you whether it is
safe to add one. See [ADR-0009](../adr/0009-sweep-probe-gate.md).

Output ends with `PROBE CLEAN` or a problem count; `blocked`, `unknown` and
`unreachable` mechanisms carry no verdict and must not be marked sweepable.

## 2. Dry run

```bash
SWEEP_ENABLED=1
SWEEP_DRY_RUN=1        # the default when SWEEP_ENABLED is set — this is explicit
TREASURY_ADDRESS_EVM=0x...
TREASURY_ADDRESS_TRON=T...
```

Restart. The sweeper starts per EVM network (Tron execution is Phase 3 — not
started; its pairings still get *planned* by the shared policy, then resolve to
`skipped: unimplemented`), selects candidates, and writes `planned`/`skipped`
rows with reasons. **Nothing is ever signed in this mode.** Watch:

- `GET /admin/api/sweeps` — the Sweeps console view. Most rows should be
  `skipped` with a reason (`below_floor`, `fee_too_high`, `gas_ceiling`,
  `no_treasury`, `unpriceable`, `unimplemented`) — that is normal operation, not
  a backlog.
- `GET /admin/api/stats` → `config.sweep_pairings` — which (network, asset)
  pairs this build can actually consolidate at all. An empty list here is the
  most common reason "nothing is sweeping."
- Logs at scope `sweeper:<network>` — `sweep planned` / `sweep deferred` lines
  carry the full economics (`sweep.amount_raw`, `sweep.min_raw`,
  `sweep.fee_raw`, `sweep.skip_reason`).

Stay here until the planned/skipped mix looks right for real balances.

## 3. Enable

```bash
SWEEP_DRY_RUN=0
```

On a **mainnet** build this also requires `SWEEP_SIGNER=remote` (not implemented
— see the [mainnet checklist](./mainnet-checklist.md)); on testnets,
`SWEEP_SIGNER=local` (the default) is accepted. Restart. Rows now progress
`planned → authorized → broadcast → confirmed`. Fund the relayer address first —
it pays gas for every non-native sweep and its own gas for native ones — the
sweeper logs it and warns at `error` when the tick finds it empty
(`relayer holds no gas — sweeps cannot be broadcast`).

Watch for the first `sweep confirmed` log line and a matching `confirmed` row in
`GET /admin/api/sweeps`, then let it run.

## 4. Reconcile

Independent of the switches above — it is read-only and useful before sweeping
is ever enabled:

```bash
SWEEP_RECON_ENABLED=1
```

Compares each deposit address's actual on-chain balance against
`Σ confirmed deposits − Σ confirmed sweeps`. This is the **one legitimate use**
of `balanceOf`/`getBalance` in the codebase outside the payment path — it never
writes to `payments`, `deposits`, or `sweeps`. It is also how value that arrived
on a chain no watcher covers becomes visible: the same BIP-32 key produces the
same address on every EVM chain, so a payer can send to a mainnet this gateway
does not serve and nothing else would ever notice.

Watch `sweep-recon:<network>` logs for `reconciliation drift` warnings, and
`GET /admin/api/diagnostics` → `metrics` → `sweeps.recon_drift` and
`sweeps.unswept_value_raw{network,asset}`. A drift within an in-flight sweep's
amount is expected and not logged as drift; anything else is a real
discrepancy worth investigating before it is dismissed as noise.

## What to watch on an ongoing basis

| Signal | Where | Meaning |
|---|---|---|
| `sweeps.relayer_balance_raw` | `/admin/api/diagnostics` metrics | Zero means sweeps are being planned that nothing can broadcast. |
| `sweeps.skipped{reason=…}` | metrics + Sweeps view | The counterpart to `deposits.ignored`; a steady count is normal deferral, not a backlog. |
| `sweeps.domain_failures{network,asset}` | metrics | An EIP-3009 domain that stopped verifying — the pairing must be disabled, not retried. |
| `sweeps.recon_drift` | metrics | Non-zero, sustained drift outside an in-flight sweep's amount. |
| `failed` rows | `/admin/api/sweeps?status=failed` | Dead-lettered after `SWEEP_MAX_ATTEMPTS` — needs an operator; there is no automatic retry past this. |
| `sweep already settled on-chain — reconciled without rebroadcasting` | logs | Normal recovery after a crash between broadcast and the ledger write — not an error. |

There is deliberately no "sweep now" button in the console — a write that moves
money is the last place to add a manual override before the role model exists to
attribute it. See [ADR-0006](../adr/0006-operator-audit-on-mutation.md).
