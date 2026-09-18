# Sweeping Plan — Deposit Addresses to Treasury

Status: **Phases 0, 1, 2 and 4 implemented; 3, 5 and 6 outstanding.** Off by
default — with none of the `SWEEP_*` variables set, the gateway behaves exactly
as it did before.

This document is the design and delivery plan for automatically consolidating
funds that arrive at per-payment deposit addresses into a single treasury
wallet. Sections 1–10 are the design and are unchanged; §11 records what each
phase actually delivered, and §16 the findings that came out of building it.

| Phase | State | Where |
|---|---|---|
| 0 — capability probe | **done** | `scripts/sweep-probe.ts` |
| 1 — model + policy, dry run | **done** | `src/db/schema.ts`, `src/services/sweeper.ts`, `src/workers/sweeper.ts` |
| 2 — EIP-3009 | **done, unexercised on-chain** | `src/services/signer.ts`, `src/services/evm-sweep.ts` |
| 3 — Tron delegation | not started | — |
| 4 — native coins | **done, unexercised on-chain** | `src/services/evm-sweep.ts` |
| 5 — batch relayer | not started | — |
| 6 — custody + mainnet gate | **gate done**, `RemoteSigner` not started | `preflightSweeping()` in `src/config.ts` |
| reconciliation (§9) | **done** | `src/workers/sweep-recon.ts` |

"Unexercised on-chain" is the honest limit: the signing, planning and
exactly-once paths are verified (`scripts/sweep-test.ts`, and an `eth_call`
simulation against the live Sepolia USDC contract), but no sweep has moved value,
because that needs a funded treasury address and a funded relayer. See §16.4.

---

## 1. Context

### 1.1 What exists today

The gateway derives one receiving address per payment from a single BIP-32 tree
(`HD_MNEMONIC`), issues it to the payer, and watches it for `Transfer` events.
`src/services/derivation.ts` derives the address **and has access to the private
key** — `deriveEvmAddress`/`deriveTronAddress` both read `node.privateKey` — but
nothing in the codebase ever signs a transaction with it.

Verified by inspection:

- No `sendTransaction`, `writeContract`, `signTransaction`, or viem
  `WalletClient` anywhere in `src/`.
- Every occurrence of the word "sweep" in `src/` refers to *scanning* (block
  backfill, expiry sweep) or to `sweepExpiredSessions` in
  `src/services/admin-auth.ts`. None of them move money.
- `src/workers/` contains `watcher`, `native-watcher`, `confirmer`,
  `tron-watcher`, `tron-confirmer`, `expirer`, `rpc-log`, `supervisor`. There is
  no sweeper.

**Consequence:** funds accumulate at N derived addresses indefinitely. The
gateway credits the merchant's `balance_cop` ledger, but the actual crypto never
moves. There is no operational path to it other than importing the mnemonic into
a wallet by hand and stepping through derivation indices.

### 1.2 The incident that motivated this

On 2026-07-27 a payment was quoted for roughly 15,000 COP / ~4.7 USDC on
`eth-sepolia` at derivation index 5. The payer sent real USDC on Ethereum
mainnet (contract `0xa0b86991…3606eb48`) to that deposit address instead of
Sepolia test USDC — and underpaid by ~13% relative to the quote.

Two independent failures, either of which alone was fatal:

1. Wrong chain. The watcher only subscribes to the Sepolia contract on chain
   11155111. Mainnet is not a served network, so detection was structurally
   impossible.
2. Underpaid far outside the 0.5% dust tolerance.

The money sat at that address, unswept, with no native balance for gas.
**That stranded balance is the exact failure mode this plan removes.**

It also demonstrates the systemic property that makes sweeping urgent: because
the same BIP-32 key produces the same address on every EVM chain, a deposit
address is live on *every* EVM chain simultaneously, including mainnets the
gateway does not serve. Value can land somewhere the gateway will never look.

### 1.3 The load-bearing fact that makes this safe

**Settlement is event-sourced, never balance-based.**

Verified: there is not a single `balanceOf`, `eth_getBalance`, or `readContract`
call in `src/`. `registerDeposit`/`confirmDeposit` in `src/services/payments.ts`
accumulate `confirmed_raw` from `Transfer` log data (and, for native coins, from
block bodies read by `native-watcher.ts`).

Therefore **sweeping a deposit address at any moment cannot corrupt settlement**,
including mid-grace-window on a `partially_paid` payment. A payer topping up
later still produces a new `Transfer` to the same address, which is still
detected and still credited. The address stays usable after being emptied.

This is what allows the sweeper to be a fully independent subsystem: it never
has to coordinate with the payment state machine, and it can never race it.

---

## 2. Objective

Move confirmed on-chain value from per-payment deposit addresses to a treasury
wallet, automatically, at a cost that stays a small fraction of the swept amount,
without ever putting settlement correctness or key material at risk.

### 2.1 Success criteria

| # | Criterion |
|---|---|
| S1 | No confirmed deposit remains at a deposit address longer than the configured policy window, on any served network |
| S2 | Cost per swept unit stays under a configured ceiling; uneconomic sweeps are deferred, never executed at a loss |
| S3 | Exactly-once: a crash, restart, or retry at any point never moves funds twice |
| S4 | Every sweep is reconcilable — on-chain reality and the `sweeps` ledger can be proven to agree |
| S5 | Settlement figures (`confirmed_raw`, `balance_cop`, payment status) are bit-identical whether or not the sweeper ran |
| S6 | The application process never holds the treasury key |

### 2.2 Non-objectives

Explicitly out of scope, to keep the change reviewable:

- **Payouts / off-ramp.** Moving value from treasury to a merchant's bank is a
  separate system with separate compliance surface.
- **Refunds.** Sweeping does not preclude refunds (they are paid from treasury),
  but the refund flow itself is not designed here.
- **Console-driven manual sweeps.** This plan adds **read-only** sweep views only.
  A manual "sweep now" button stays deferred — but note the stated reason has
  since changed: the audit model it was waiting on now exists
  (`admin_audit_log`, `requireOperator`, `src/services/audit.ts`, added with the
  console's merchant write surface). What remains is that a button which *moves
  funds* is a different class of mutation from one that edits a merchant row: it
  is irreversible, it is the sweeper's own safety policy being overridden by
  hand, and it wants a second pair of eyes rather than a single operator session.
  Attribution was necessary, not sufficient.
- **Cross-chain consolidation / bridging.** One treasury address per network.
- **Recovering funds already stranded on unserved mainnets.** That is a manual
  operator task; see §11.3.

---

## 3. Constraints imposed by this repository

These come from `AGENTS.md` and the existing code. The design is shaped by them,
not merely compatible with them.

| Constraint | Effect on this design |
|---|---|
| `src/config.ts` is authoritative for chains/assets; iterate `NETWORK_IDS`, resolve stored rows against `NETWORKS` | Sweep capability becomes **registry data**, not a lookup table in the sweeper |
| Importing `src/config.ts` must stay side-effect free; `preflight()` is the only thing that exits | Capability probing happens in the worker/preflight, never at module load |
| Raw amounts are `numeric(78, 0)`, mode `bigint` — never `bigint` columns | `sweeps` uses the existing `rawAmount()` helper |
| Decimals belong to the (network, asset) pairing | Sweep thresholds are configured per pairing, never per symbol |
| Nothing calls `console`; use `getLogger` from `src/observability`, attributes not interpolation | All sweeper records follow `docs/architecture/observability.md` and OTel semantic conventions |
| Payment state transitions live in `src/services/payments.ts` | The sweeper **never** touches `payments` or `deposits` rows |
| Schema changes start in `src/db/schema.ts` → `bun run db:generate` → commit under `drizzle/` | One generated migration per phase |
| Verification is standalone scripts importing `./quiet` first; no test runner | A new `scripts/sweep-test.ts` follows that shape |
| `hd_counter.seed_fingerprint` binds the DB to one tree | The sweeper asserts the same fingerprint before signing anything |
| Mainnets are registered but withheld unless `ENABLE_MAINNETS`; a public seed + mainnet refuses to boot | The custody gate in §10 reuses this exact mechanism |

---

## 4. Architecture

### 4.1 The core problem: gas at the leaf

A deposit address is an EOA holding only a token. Moving an ERC-20 out of it
requires native gas *at that address*. The naive design — send gas, then sweep —
costs two transactions per deposit and strands leftover gas dust at every
address forever. At scale that is a permanent, compounding loss.

Three mechanisms avoid it, chosen per (network, asset):

| Mechanism | Applies to | Transactions | Native needed at leaf |
|---|---|---|---|
| **`eip3009`** — signed authorization, relayer pays gas | USDC (Circle FiatToken) | 1 | none |
| **`prefund`** — send gas, then transfer | tokens without 3009/2612 | 2 | yes, and dust remains |
| **`delegate`** — delegate staked energy, then transfer | Tron TRC-20 | 1 + reclaimable delegation | none (energy is lent, not spent) |
| **`native`** — transfer `balance − gasCost` | BNB, POL, TRX themselves | 1 | it *is* the native balance |

### 4.2 EVM + USDC: EIP-3009

`transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, v, r, s)`.

The deposit address signs an EIP-712 typed message **off-chain** — no gas, no
native balance, no nonce consumed on that account. The relayer submits it and
pays. Value moves deposit → treasury in one transaction.

Two properties matter enormously here:

1. **The 3009 `nonce` is a random 32-byte value, and the token contract records
   it as used.** Replaying an identical authorization is rejected on-chain. This
   gives us exactly-once *enforced by the chain*, not merely by our database —
   see §6.3.
2. `transferWithAuthorization` (as opposed to `receiveWithAuthorization`) lets
   any sender submit. The only "front-running" risk is a stranger paying our gas
   for us, which is harmless. This keeps the relayer decoupled from the treasury
   address.

**The EIP-712 domain must be read from chain, never assumed.** Deployments differ
(`name()` returns `"USD Coin"` on some, `"USDC"` on others; `version()` is `"1"`
or `"2"`). Getting it wrong produces a signature that fails on-chain after we
have already written a ledger row. Resolution order, cached per (network, asset)
after first success:

1. `eip712Domain()` (ERC-5267) if present — authoritative, single call.
2. Else `name()` + `version()`.
3. Cross-check the assembled domain separator against the contract's
   `DOMAIN_SEPARATOR()`. **Mismatch disables sweeping for that pairing and logs
   at `error`** rather than signing something that cannot settle.

Phase 0 (§9) does exactly this probe before any code depends on it.

### 4.3 Tron + USDT: resource delegation

TRC-20 transfers consume energy and bandwidth. Sending TRX to each deposit
address spends it permanently.

Instead: stake TRX once in the treasury account, then per sweep
`DelegateResourceContract` energy → deposit address, submit the `transfer`,
`UnDelegateResourceContract`. The staked TRX is never spent, only lent, and is
reclaimable in full.

Notes:

- An account that has received a TRC-20 transfer already exists on-chain, so the
  ~1 TRX activation fee is normally already paid by the payer's transfer.
- Delegation has a minimum lock period; the sweeper must tolerate un-delegation
  being deferred rather than treating it as failure.
- If delegation is unavailable, fall back to `prefund` with a small TRX float and
  log the degradation — it is a cost regression, not an outage.

### 4.4 Native coins

BNB/POL/TRX arriving as the quoted asset cannot use any authorization scheme —
the value *is* the gas. Sweep `balance − (gasLimit × gasPrice × safetyFactor)`.

Gas price moves between estimate and inclusion, so this is inherently racy.
Mitigation: a `SWEEP_NATIVE_HEADROOM_BPS` dial, and on failure re-estimate and
retry rather than fixing the subtraction. Accept that a small native residue is
normal and is *not* an error condition.

### 4.5 Capability lives in the registry

Per `AGENTS.md`, `NETWORKS` is authoritative. Sweep capability is therefore an
asset property, not sweeper-internal knowledge:

```ts
// src/config.ts — extends EvmTokenDef
export type SweepVia =
  | { via: "eip3009"; domain?: { name: string; version: string } } // domain probed if absent
  | { via: "prefund" }
  | { via: "delegate" }   // Tron TRC-20
  | { via: "native" };

export type EvmTokenDef = {
  address: `0x${string}`;
  decimals: number;
  /** How value leaves a deposit address. Absent = not sweepable yet. */
  sweep?: SweepVia;
};
```

A pairing with no `sweep` is simply never swept. Adding a network cannot silently
inherit a wrong assumption, and the "which assets can we consolidate" question is
answered by reading the registry.

---

## 5. Where the key boundary sits

This is the most consequential decision in the plan, so it is isolated behind one
interface from day one — even in Phase 1, when the implementation is trivially
local.

```ts
// src/services/signer.ts
export interface Signer {
  /** Address for a derivation index on a family, without exposing the key. */
  addressFor(index: number, family: "evm" | "tron"): Promise<string>;
  /** EIP-712 typed-data signature. The key never leaves the implementation. */
  signTypedData(index: number, payload: TypedDataPayload): Promise<Hex>;
  /** Raw transaction signature, for prefund/native/Tron paths. */
  signTransaction(index: number, tx: UnsignedTx): Promise<Hex>;
  /** Must equal hd_counter.seed_fingerprint or the caller refuses to proceed. */
  fingerprint(): Promise<string>;
}
```

Two implementations:

- **`LocalSigner`** — derives from `env.mnemonic` in-process. Testnet only. The
  preflight refuses to pair it with a served mainnet, reusing the existing
  public-seed check in `src/config.ts`.
- **`RemoteSigner`** — KMS/HSM/MPC. The application holds a *reference*, never
  key material.

No call site outside `signer.ts` may import from `derivation.ts` for key
purposes. That single rule is what makes the custody upgrade in Phase 6 a
swap rather than a rewrite.

**The treasury key is never in either implementation.** The treasury is a
destination address only; the gateway never spends from it.

---

## 6. Data model

### 6.1 Table

```ts
// src/db/schema.ts

export const sweepStatus = pgEnum("sweep_status", [
  "planned",     // policy selected it; nothing signed yet
  "authorized",  // signed; safe to (re)broadcast — the authorization is idempotent
  "broadcast",   // submitted, awaiting confirmations
  "confirmed",   // final
  "failed",      // terminal after max attempts; needs an operator
  "skipped",     // deliberately not swept (below threshold, gas too high)
]);

export const sweeps = pgTable("sweeps", {
  id: uuid("id").primaryKey().defaultRandom(),
  network: text("network").notNull(),
  address: text("address").notNull(),          // the deposit address (source)
  derivationIndex: integer("derivation_index").notNull(),
  asset: text("asset").notNull(),              // the symbol that is being moved
  amountRaw: rawAmount("amount_raw").notNull(),
  toAddress: text("to_address").notNull(),     // treasury, snapshotted at plan time
  via: text("via").notNull(),                  // 'eip3009' | 'prefund' | 'delegate' | 'native'

  // EIP-3009 replay key. Random 32 bytes, persisted BEFORE signing.
  // This column is what makes retries exactly-once (see 6.3).
  authorizationNonce: text("authorization_nonce"),
  validBefore: timestamp("valid_before"),

  txHash: text("tx_hash"),
  blockNumber: rawAmount("block_number"),
  gasUsedRaw: rawAmount("gas_used_raw"),       // cost accounting, in native units
  status: sweepStatus("status").notNull().default("planned"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at").notNull().defaultNow(),
  lastError: text("last_error"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  // One live sweep per (network, address, asset). Partial index so historical
  // confirmed/failed rows never block a later sweep of the same address —
  // an address is reusable and will receive again.
  uniqueIndex("sweeps_live_idx")
    .on(t.network, t.address, t.asset)
    .where(sql`status in ('planned','authorized','broadcast')`),
  uniqueIndex("sweeps_auth_nonce_idx").on(t.network, t.authorizationNonce),
  index("sweeps_due_idx").on(t.status, t.nextAttemptAt),
]);
```

Deliberately **no foreign key to `payments` or `deposits`.** A sweep is about an
*address and an asset*, not a payment. An address may hold value from several
deposits, or from a transfer that never matched a payment at all (the mainnet
incident). Coupling them would make the sweeper unable to recover exactly the
funds most likely to be stranded.

### 6.2 Migration

`bun run db:generate` → commit under `drizzle/`. Additive only: a new enum, a new
table, no change to existing columns. Safe to deploy ahead of the worker, which
is what Phase 1 does.

### 6.3 Exactly-once (criterion S3)

The dangerous window is *broadcast without a durable record*. Ordering:

1. `planned` row committed (unique index rejects a concurrent duplicate).
2. Generate `authorizationNonce`, persist it, commit → status `authorized`.
3. Sign using that stored nonce.
4. Broadcast.
5. On confirmation → `confirmed`.

A crash anywhere after step 2 is safe: recovery re-signs **the same stored
nonce**, producing a byte-identical authorization. If the first broadcast landed,
the token contract rejects the replay and we reconcile to `confirmed`; if it did
not, the rebroadcast succeeds. Either way the funds move exactly once, and the
guarantee is enforced by the chain rather than by our locking.

This is why the nonce is persisted *before* signing rather than generated at
signing time. For `prefund`/`native` paths, which have no authorization nonce,
the account nonce plays the same role and must be persisted identically.

---

## 7. Policy — when to sweep

Policy is pure and lives in `src/services/sweeper.ts`, separate from execution,
so it is unit-testable without a chain.

```
sweep(address, asset) if ALL of:
  confirmed_value(address, asset) >= SWEEP_MIN_RAW[network][asset]
  AND estimated_gas_cost <= confirmed_value × SWEEP_MAX_COST_BPS / 10_000
  AND current_gas_price <= SWEEP_GAS_CEILING[network]
  AND no live sweep row exists for (network, address, asset)
```

- **Never sweep unconfirmed value.** Reuse the existing `deposits.confirmed`
  flag; the `confirmer` already applies the per-network confirmation depth and
  already unwinds reorged deposits.
- **Sweep regardless of payment status.** Per §1.3 this is safe. A `pending` or
  `partially_paid` payment keeps working after its address is emptied.
- **Batch window.** Poll on `SWEEP_INTERVAL_SEC`; collect all eligible pairings
  and group them per network before execution.
- **Defer, don't drop.** Failing the economic test yields `skipped` with a
  reason, re-evaluated next tick. Value accumulating at one address makes it
  eligible later — which is the correct behaviour for small tickets.

### 7.1 New dials

Added to `env` in `src/config.ts`, following the existing commented style:

| Variable | Default | Purpose |
|---|---|---|
| `SWEEP_ENABLED` | `false` | Master switch. Off = plan and log, never sign |
| `SWEEP_DRY_RUN` | `true` | Write `planned` rows, never sign. Phase 1 lives here |
| `SWEEP_INTERVAL_SEC` | `120` | Poll cadence |
| `SWEEP_MIN_USD` | `5` | Floor, converted per pairing via the existing rate service |
| `SWEEP_MAX_COST_BPS` | `200` | Refuse if gas exceeds 2% of swept value |
| `SWEEP_GAS_CEILING_GWEI` | per network | Hard ceiling |
| `SWEEP_MAX_ATTEMPTS` | `8` | Matches the webhook dead-letter convention |
| `SWEEP_NATIVE_HEADROOM_BPS` | `500` | Gas headroom for native sweeps |
| `TREASURY_ADDRESS_EVM` | — | Required when `SWEEP_ENABLED` |
| `TREASURY_ADDRESS_TRON` | — | Required when `SWEEP_ENABLED` and Tron served |

`preflight()` gains: if `SWEEP_ENABLED` and a treasury address for a served
family is missing or malformed → refuse to boot. Consistent with the existing
rule that `preflight()` is the only place that exits.

---

## 8. Execution

### 8.1 Worker

`src/workers/sweeper.ts`, registered in `supervisor.ts` alongside
`watcher`/`confirmer` so it inherits the RPC-probe gate — it will not start until
the network's RPC actually answers.

It follows `confirmer.ts` exactly: `setInterval` → `withContext` →
`log.time("sweeper tick")` → DB-before-RPC → `count`/`gauge` →
`logRpcError`/`clearRpcError`.

```ts
export function startSweeper(network: NetworkId) {
  const log = getLogger(`sweeper:${network}`, { "chain.network": network });

  setInterval(async () => {
    await withContext(
      { attributes: { "chain.network": network, "worker.name": "sweeper" } },
      async () => {
        const tick = log.time("sweeper tick");
        try {
          // DB first (free) before RPC (metered) — same discipline as confirmer.
          const candidates = await eligible(network);
          gauge("sweeps.eligible", candidates.length, { network });
          if (candidates.length === 0) return log.trace("nothing eligible");

          if (env.sweepDryRun) {
            await recordPlanned(candidates);
            return tick({ "sweeps.planned": candidates.length, "sweep.dry_run": true });
          }
          // ... authorize → broadcast → confirm
        } catch (e) {
          logRpcError(`sweeper:${network}`, e);
        }
      }
    );
  }, env.sweepIntervalSec * 1000);
}
```

### 8.2 Concurrency and nonces

- **Deposit addresses do not contend.** Under `eip3009` they never send a
  transaction at all. Sweeps across addresses are embarrassingly parallel.
- **The relayer is the serialization point.** One nonce sequence per network, so
  broadcasts go through a single-writer queue per network. This is the throughput
  ceiling and the thing to measure first under load.
- Confirmation is polled by the same worker, reusing the network's configured
  confirmation depth rather than inventing a second definition of "final".

### 8.3 Batching (Phase 5)

A helper contract accepting `N` authorizations in one transaction amortises the
21k base cost. Expected ~86k gas standalone → ~65k inside a batch, improving with
batch size.

Deferred deliberately: it adds a deployed contract and an audit surface, and the
single-sweep path must be proven correct first. The `sweeps` schema already
supports it — several rows sharing one `txHash` requires no change.

---

## 9. Reconciliation

Without this, S4 is unprovable and the whole subsystem is unauditable.

A periodic job (own cadence, `SWEEP_RECON_INTERVAL_SEC`, default hourly):

1. For every address issued on a served network, read on-chain balance per asset.
   **This is the one place `balanceOf` is legitimate** — for auditing, never for
   settlement. The §1.3 invariant must be preserved and stated in a comment at
   that call site.
2. Compare against `confirmed_raw − Σ confirmed sweeps`.
3. Emit `gauge("sweeps.unswept_value_raw")` per (network, asset) and log any
   drift at `warn` with both figures as attributes.

Drift is expected and benign in two cases that must be classified, not alarmed
on: value below threshold awaiting accumulation, and in-flight sweeps.

This job is also what surfaces value that arrived **on an unserved chain** — the
mainnet incident would have been caught here within the hour instead of by manual
investigation.

---

## 10. Custody

`LocalSigner` reading a mnemonic from an environment variable is appropriate for
testnet and unacceptable for real volume. Automating sweeps sharpens this: it
gives an always-on process the ability to sign movements of money.

The mechanism to enforce the gate already exists. `src/config.ts` refuses to boot
when a publicly-known seed is paired with a served mainnet. Phase 6 extends the
same check: **`SWEEP_ENABLED` + a served mainnet + `LocalSigner` → refuse to
boot.** Real money therefore cannot be swept by an in-process key by
construction, not by policy.

Target separation:

- **Deposit keys** — many, individually low-value, necessarily hot. Isolated
  signer service; the API process holds no key material.
- **Treasury key** — one, high-value. Never in the application at all. KMS
  (AWS/GCP) or MPC custody (Fireblocks, Turnkey, Dfns).

Choosing the custody vendor is a business decision with cost and compliance
implications. It is the gate on mainnet, and it is **not** a code decision —
flagged here for an explicit call rather than assumed.

---

## 11. Delivery phases

Each phase is independently shippable and independently verifiable.

### Phase 0 — Capability probe *(no production code)* — **done**

`scripts/sweep-probe.ts`: for every served (network, asset), report whether the
contract implements EIP-3009, and the resolved EIP-712 domain cross-checked
against `DOMAIN_SEPARATOR()`.

**Result** (2026-07-27, from the chain):

| network | asset | mechanism | EIP-712 domain |
|---|---|---|---|
| eth-sepolia | USDC | **eip3009**, verified | `name="USDC"`, `version="2"` |
| base-sepolia | — | *no verdict* | RPC unreachable — network not enabled on the Alchemy app |
| tron-nile | USDT | delegate (`authorizationState` reverts — no 3009, as expected of a TRC-20) | — |
| bsc-testnet, polygon-amoy | — | *not probed* | no RPC credential in this environment |

Sepolia USDC does implement 3009, so the phase order held. Three things worth
recording:

- The domain resolved through `name()`+`version()`, **not** `eip712Domain()` —
  this deployment does not implement ERC-5267, so the §4.2 fallback is not
  hypothetical, it is the path actually taken.
- `transferWithAuthorization` is absent from the bytecode because Circle's USDC
  sits behind a proxy. Selector scanning is therefore not a usable capability
  test; `authorizationState` answering is.
- The registry's `decimals` cross-checked against every contract the probe could
  reach.

A pairing acquires `sweep` in `src/config.ts` only after this probe confirms it.
`base-sepolia` is Circle's FiatToken too and is almost certainly 3009-capable —
and is deliberately left without a mechanism, because §4.2's whole point is that
an unverified capability is not a capability.

### Phase 1 — Model + policy, dry-run only — **done**

Schema, migration (`drizzle/0004_illegal_mordo.sql`), registry `sweep` field,
dials, policy function, worker in `SWEEP_DRY_RUN`. No signer, no signing, no
broadcast.

**Accepted:** both typechecks clean; `scripts/sweep-test.ts` passes 48 checks
including S5 as a before/after comparison of every settlement figure across a
confirmed sweep.

One deviation from §7, and it matters. The candidate query sums **`deposits`**,
not `payments.confirmed_raw`. A deposit in an asset its payment never quoted is
marked confirmed and credits nothing (the mismatch guard in `payments.ts`), so it
is invisible in `confirmed_raw` while being real value at a real address of ours
— exactly the funds most likely to be stranded. Summing the payment column would
have made them permanently unsweepable. `sweep-test.ts` covers this with a BNB
transfer to a USDC invoice on `bsc-testnet`.

### Phase 2 — EIP-3009 on Sepolia — **done, unexercised on-chain**

`Signer` interface + `LocalSigner`; authorize → broadcast → confirm; retries on
the stored nonce.

**Verified:** the signing path was simulated with `eth_call` against the live
Sepolia USDC contract. It reverts with `ERC20: transfer amount exceeds balance`
— not an invalid-signature error — which means the contract recovered our
signer, matched it to `from`, accepted the nonce, and only then failed on the
(correctly zero) balance. The EIP-712 domain, the typed-data hash, the v/r/s
split and the calldata encoding are therefore all confirmed against the real
deployment without spending anything.

**Not accepted yet:** no value has moved. That needs `TREASURY_ADDRESS_EVM` and
a funded relayer — see §16.4.

The exactly-once path (§6.3) is covered in `sweep-test.ts` by a simulated crash
between persisting the nonce and broadcasting: recovery re-signs the stored nonce
and reproduces a byte-identical authorization. On-chain, `authorizationState` is
consulted *before* every broadcast, so a recovery that cannot know whether the
first attempt landed asks the token rather than guessing.

### Phase 3 — Tron — **not started**

Delegation, sweep, un-delegation, with `prefund` fallback.

`tron-nile/USDT` carries `sweep: { via: "delegate" }` in the registry — the probe
established that, and it is true of the contract. The *code* to delegate is not
written, so the policy resolves those candidates to `skipped: unimplemented`
rather than planning rows nothing will pick up. `EXECUTABLE_VIA` in
`services/sweeper.ts` is the one place to extend when this lands.

`triggerConstantContract` in `services/tron.ts` was added for the probe and is
the read half of what this phase needs.

**Accept:** Nile USDT swept without permanently spending TRX; delegation
reclaimed.

### Phase 4 — Native coins — **done, unexercised on-chain**

`balance − gas` with headroom and re-estimation on failure.

`nativeSweepAmount()` and the `native` branch of the worker are implemented and
unit-covered (including the two cases that must not go negative: a balance that
cannot cover its own fee, and an empty address). BNB and POL carry
`sweep: { via: "native" }`; neither network has an RPC credential in this
environment, so this has not run against a chain either.

**Accept:** BNB/POL/TRX swept; residue bounded by the headroom dial and not
reported as failure.

### Phase 5 — Batch relayer

Helper contract; several `sweeps` rows sharing one `txHash`.

**Accept:** measured gas per sweep below the Phase 2 baseline.

### Phase 6 — Custody + mainnet gate — **gate done, `RemoteSigner` not started**

The gate shipped early, with Phase 2 rather than after it, because that is when
the risk appeared: the moment the code can sign, the boundary has to be
enforced. `preflightSweeping()` in `src/config.ts` refuses to boot on
`SWEEP_ENABLED` + not dry-run + a served mainnet + `SWEEP_SIGNER=local`, reusing
the same mechanism as the existing public-seed check. It also refuses to boot
when a served family has no usable treasury address.

`SWEEP_SIGNER=remote` is rejected loudly rather than falling back to the local
signer — a deployment that asked for remote custody and silently got in-process
keys is the exact failure the setting exists to prevent.

`RemoteSigner` itself remains gated on **open decision 1** (custody vendor),
which §15 correctly calls a business decision rather than an engineering one.

**Accept:** no key material in the application process; boot refuses the unsafe
combination. *(Second half done; the first needs the vendor.)*

### Cross-cutting — reconciliation **done**

`src/workers/sweep-recon.ts`. Reads on-chain balances and compares them with
`Σ confirmed deposits − Σ confirmed sweeps`, classifying in-flight sweeps and
sub-floor value rather than alarming on them. It runs independently of
`SWEEP_ENABLED` (`SWEEP_RECON_ENABLED`), because auditing is useful long before
sweeping is switched on — this is the job that would have surfaced the §1.2
mainnet incident within the hour.

EVM balances batch through Multicall3, which every chain in the registry has, so
an audit of N addresses costs one `eth_call` rather than N. Coverage is capped
per tick by `SWEEP_RECON_MAX_ADDRESSES` with a rotating cursor, and each tick
logs `sweep.recon_deferred` — a bounded audit must not read as a complete one.

---

## 12. Verification

Following the repo's script convention — standalone, `./quiet` imported first,
fixed rates, injected deposits, no external calls:

- `scripts/sweep-test.ts` — policy thresholds, the exactly-once path with a
  simulated crash between persist and broadcast, and the unique-index guard
  against concurrent duplicates. Uses a mock `Signer`, so it needs no chain.
- `scripts/sweep-probe.ts` — Phase 0, the only script that touches a chain.
- Extend `scripts/smoke-test.ts` to assert S5: settlement figures identical with
  the sweeper enabled and disabled.
- Both typechecks (`bun run typecheck`, `bun run typecheck:web`).

---

## 13. Observability

Per `docs/architecture/observability.md` — facts as attributes, never interpolated.

Attributes: `sweep.id`, `sweep.via`, `sweep.amount_raw`, `sweep.asset`,
`sweep.status`, `sweep.attempts`, `sweep.authorization_nonce`,
`chain.network`, `chain.tx_hash`, `chain.gas_used`, `wallet.derivation_index`.

Metrics: `sweeps.eligible`, `sweeps.planned`, `sweeps.broadcast`,
`sweeps.confirmed`, `sweeps.failed`, `sweeps.skipped{reason}`,
`sweeps.unswept_value_raw{network,asset}`, `sweeps.gas_cost_raw`.

Levels: `info` on state transitions; `warn` on retry, drift, and degraded
fallback; `error` on domain mismatch and dead-letter; `debug` for per-candidate
policy decisions.

**Never log**: mnemonic, private key, or raw signature. Redaction happens at the
sink, but per `AGENTS.md` do not defeat it by pasting a secret into a message
body.

### 13.1 Console

Read-only, per §2.2. No mutation endpoints, and no "sweep now" button — deferred
not for want of an audit model (that now exists) but because moving funds by hand
overrides the sweeper's own policy and wants more than one operator's say-so.

Delivered at `/admin/sweeps`:

- **Unswept value** per (network, asset), as tiles. The number the subsystem
  exists to drive down.
- **Wallets** — treasury and relayer addresses with their **on-chain** balances
  (`GET /admin/api/wallets`). This is the only console route that reads a chain
  rather than the database, which is precisely what makes it worth having: the
  `sweeps` ledger asserts value reached the treasury, and only this corroborates
  it from the other side. It is also the one place an empty relayer is visible —
  that condition plans sweeps forever, broadcasts none, and appears in no table.
  Readings are cached 30s server-side and the panel states their age.

  An unreachable network reports balances as *unknown*, never as zero. The
  distinction is the whole point of the panel: a zero from a dead RPC is
  indistinguishable from an empty wallet, and that is the exact question being
  asked.

- **Sweeps list** with network/status/search filters. The load-bearing column is
  `reason`: most rows are deferrals (`below_floor`, `fee_too_high`,
  `gas_ceiling`, `unimplemented`), which are normal operation rather than a
  queue backing up, and the console says so in operator language rather than
  enum names.

---

## 14. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Wrong EIP-712 domain → signatures fail after ledger write | High | Phase 0 probe + `DOMAIN_SEPARATOR()` cross-check; disable pairing on mismatch |
| Double-spend on retry | Critical | Persist authorization nonce before signing (§6.3); chain-enforced replay rejection |
| Relayer nonce collision under load | Medium | Single-writer queue per network; measured in Phase 2 |
| Gas spike makes sweeps uneconomic | Medium | `SWEEP_GAS_CEILING_GWEI`; defer, never fail |
| Sweeping breaks settlement | **Eliminated** | §1.3 — settlement is event-sourced; asserted by S5 in `smoke-test.ts` |
| Hot key compromise drains all deposits | Critical | §10; mainnet gate enforced by preflight |
| Value arrives on an unserved chain | High | Reconciliation (§9) surfaces it; recovery stays manual |
| Tron delegation lock blocks un-delegation | Low | Tolerate deferral; do not treat as failure |

---

## 15. Open decisions

These need an explicit call before the phases they gate:

1. **Custody vendor** (gates Phase 6 and all mainnet activity). KMS vs MPC
   custody — cost and compliance, not engineering.
2. **Treasury topology.** One address per network, or one per network per asset?
   Per-asset simplifies accounting; per-network reduces key surface.
3. **Chain strategy.** With small tickets, Ethereum mainnet is not economically
   viable for sweeping at all. If real volume is expected, concentrating on L2
   (Base) and Tron is a larger lever than any gas optimisation in this document.
4. **Sweep timing vs refunds.** Sweeping immediately on confirmation is simplest
   and safest for accounting. If refunds are expected to be paid from the deposit
   address rather than the treasury, that changes the policy in §7.

---

## 16. Findings from implementation

Things the plan did not anticipate, recorded because each one changed the code.

### 16.1 The plan had no relayer key

§5 covers deposit keys and states that the treasury key is never in the
application. Both are right, and between them sits a hole: `transferWithAuthorization`
is *submitted* by someone who pays gas, and §8.2 refers to "the relayer" without
ever saying where its key comes from. The treasury cannot be it — the gateway
holds no key for the treasury by design.

Resolved by deriving the relayer from the same HD tree at **BIP-44 account 1**
(`m/44'/60'/1'/0/0`, `m/44'/195'/1'/0/0`), against account 0 for deposits. The
hardened account boundary is what makes this safe: `hd_counter` increments from 0
without bound, so any index *reserved* inside account 0 would eventually be
issued to a payer, while a separate account cannot be reached that way at all.

This adds nothing to the blast radius. A seed compromise already exposes every
deposit address; the relayer holds only gas. It does mean the relayer is not
covered by the custody upgrade in §10 — a `RemoteSigner` will need to hold it
too, or `SWEEP_SIGNER=remote` will have moved the deposit keys out and left the
relayer behind.

### 16.2 The fee currency is not the `native` asset

§4.4 and §7 assume the coin that pays for a sweep is available for pricing. It
is not: `eth-sepolia` and `base-sepolia` both declare `native: null`, because the
gateway quotes stablecoins there and does not accept ETH as payment — but ETH is
still what a sweep on those chains costs. Reading the fee currency from `native`
would have priced every Sepolia sweep against nothing.

`gasCoinFor()` in `src/config.ts` is the fix, and the distinction is now stated
where both are defined: `native` is "the coin we accept as a payment asset",
the fee currency is "the coin the chain charges". They coincide on BSC and
Polygon and differ on Sepolia and Base.

Taking the fee currency from `chain.nativeCurrency` instead is the *other* wrong
answer, and it is worse because it fails quietly. viem reports BSC testnet's coin
as **`tBNB`**, which no rate provider quotes — so pricing returned nothing, the
economic test could not run, and every BNB sweep deferred as `unpriceable`
forever. Caught only by running a real planning pass against seeded data; no
typecheck or unit test would have shown it. `gasCoinFor()` therefore prefers the
registry's own name for the coin (the mainnet name, which *is* quotable) and
falls back to viem only where the gateway has not named it.

The `sweeps` table records `fee_raw` in that currency, and the console labels it
per row rather than assuming.

### 16.3 The economic test needs a common unit

§7 compares `estimated_gas_cost` with `confirmed_value × SWEEP_MAX_COST_BPS`.
Those are amounts in two different currencies with two different decimal
scales — the comparison is not meaningful as written. Both sides are now
converted to COP through the same rate service that prices a quote, and a pairing
that cannot be priced defers as `unpriceable` rather than being swept blind.

`SWEEP_MIN_USD` needed the same treatment: it is a value, the column holds raw
units, so the floor is resolved per pairing through USD → COP → raw. That
required exposing the FX leg from `services/rates.ts` (`getUsdCopRate`), which
was already cached with a degradation ladder.

Note the testnet consequence: prices are real-world prices for valueless coins,
so the arithmetic is fictional in absolute terms while being exactly the
arithmetic mainnet will run. That is the point of exercising it there.

### 16.4 What is still needed to move real value

Everything below is an operator action, not code:

1. **A treasury address** (`TREASURY_ADDRESS_EVM`). The preflight refuses to boot
   with `SWEEP_ENABLED` and no usable address, so this cannot be forgotten.
2. **A funded relayer.** The sweeper logs its address and warns at `error` when
   it holds no gas, since an empty relayer is the likeliest reason sweeps plan
   and never move.
3. **A funded deposit address on Sepolia** to sweep from, and
   `SWEEP_DRY_RUN=0`.

Only `eth-sepolia/USDC` is presently sweepable at all. `base-sepolia` needs its
Alchemy app enabled before the probe can give it a verdict; `bsc-testnet` and
`polygon-amoy` need RPC credentials.

### 16.5 A pre-existing bug this work surfaced

Not a sweeping bug, and not fixed here — reported so the decision is explicit.

`confirmDeposit` in `src/services/payments.ts` unconditionally computes
`pendingRaw = payment.pendingRaw − dep.amountRaw`. But `registerDeposit` returns
*before* adding to `pendingRaw` when the payment is already terminal (and on the
late/wrong-asset paths). Confirming such a deposit therefore subtracts an amount
that was never added, driving `pending_raw` negative — reproducible with a
transfer arriving at an already-`paid` payment.

`confirmed_raw`, `balance_cop` and the ledger are all correct; the damage is
confined to a displayed figure that the merchant API and the console both serve.
Fixing it means touching the settlement path, which this plan deliberately does
not do, and it deserves its own change with its own verification.
