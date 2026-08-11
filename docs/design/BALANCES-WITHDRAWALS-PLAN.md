# Balances and Withdrawals Plan — per-asset merchant balances, and paying them out

Status: **design only. Nothing here is implemented.**

This document is the design and delivery plan for two things the gateway does not
have today:

1. **Multiple merchant balances** — one spendable balance per `(network, asset)`
   pairing, in the asset's smallest unit, replacing the single COP figure as the
   thing a merchant actually owns.
2. **Withdrawals** — moving one of those balances, in three flavours:
   `transfer` (on-chain payout to an external address), `swap` (convert one
   balance into another), and `internal` (book transfer to another merchant, no
   chain touched).

| Phase | Delivers | Where |
|---|---|---|
| 0 — balance ledger | `merchant_balances`, `balance_movements`, credit at settlement, backfill | `src/db/schema.ts`, `src/services/balances.ts`, `src/services/payments.ts` |
| 1 — request lifecycle | `withdrawals` table, reservations, `internal` type end-to-end | `src/services/withdrawals.ts`, `src/api/admin-write.ts` |
| 2 — swap | book swap against `rates.ts`, solvency gate | `src/services/withdrawals.ts`, `src/services/rates.ts` |
| 3 — transfer | payout wallet role, planning, dry run, execution, confirmer | `src/services/signer.ts`, `src/services/payouts.ts`, `src/workers/withdrawer.ts` |
| 4 — surfaces | merchant API, console reads + approve/reject, UI | `src/api/routes.ts`, `src/api/admin.ts`, `web/src/admin/` |
| 5 — optional | credit mismatched-asset deposits; DEX routing; bridging | — |

Off by default throughout, the way sweeping shipped: with none of the
`WITHDRAW_*` variables set, Phase 0 changes what a merchant *sees* and nothing
else moves.

---

## 1. Context

### 1.1 What exists today

A merchant has exactly one balance: `clients.balance_cop`, a `bigint` of
Colombian pesos, credited in `confirmDeposit` when a payment settles
(`src/services/payments.ts:387`) with the payment's *quoted* `amount_cop`.
`ledger_entries` is its audit trail and is COP-denominated too.

Three facts about that column are load-bearing for this design:

- **Nothing ever debits it.** The only writer is the `payment_credit` path;
  `ledger_entries.type` mentions `'adjustment'` but no route produces one. So
  `balance_cop` is already, in practice, *gross lifetime settled COP* — not a
  spendable balance. Introducing a real spendable ledger alongside it is
  therefore **not** a semantic change to the existing column, and `/api/me` can
  keep returning it unchanged.
- **It is denominated in the wrong thing.** The gateway receives USDC, USDT,
  BNB, POL and TRX. Crediting COP makes the gateway the counterparty to a
  fiat-denominated obligation it has no fiat to settle, and holds price risk
  between settlement and payout. Nothing in the codebase acknowledges that risk.
- **It loses information the chain already gave us.** Overpayment is recorded in
  `payments.overpaid_raw` and explicitly *not* credited ("excess is recorded, not
  refunded", `payments.ts:417`). A deposit whose asset differs from the quoted
  one is recorded and refused. Both are real value that arrived at an address the
  gateway controls, and both are currently owed to nobody.

### 1.2 What "multiple balances" has to respect

ADR-0003: **decimals are a property of the `(network, asset)` pairing, never of
the symbol.** USDC is 6 decimals on Polygon and 18 on BSC; the native coins are
18 on EVM and 6 on Tron. A balance keyed by symbol alone has no unit and cannot
be added up. So the key is `(client_id, network, asset)` and the amount is
`numeric(78, 0)`, exactly as `payments.amount_crypto_raw` is.

ADR-0001 applies for the same reason: `int8` tops out at ~9.22e18 and an
18-decimal asset passes that at everyday amounts.

### 1.3 The blocker Phase 3 walks into

`AGENTS.md` and ADR-0007 are explicit: `TREASURY_ADDRESS_EVM` /
`TREASURY_ADDRESS_TRON` "are destinations only — the gateway never holds a key
for them." That is the property that makes sweeping safe: compromise the signer
and you reach deposit keys and a gas-only relayer, never the consolidated funds.

**You cannot pay a merchant out of an address you hold no key for.** Every
on-chain withdrawal design has to answer this, and there are only three answers:

| Answer | Cost |
|---|---|
| Give the gateway the treasury key | Destroys the property sweeping was built around. Rejected. |
| Pay out from deposit addresses | The gateway *does* hold these keys. But balances are not aligned to specific addresses, gas at the leaf is the problem §4.1 of the sweeping plan exists to solve, and it links every merchant payout to a payer's address on-chain. Rejected. |
| **A separate payout wallet** | A new key role, funded *from* treasury by a human, holding only working capital. Treasury stays key-free and cold. **Chosen — §7.1.** |

This is the single most consequential decision in the document and it needs an
ADR of its own (§10).

---

## 2. Objective

A merchant can see what it holds, per network and asset, and can move it.

### 2.1 Success criteria

- **B1** — Settling a payment credits `(payment.network, deposits.asset)` with
  the raw amount that actually confirmed, and the sum of `balance_movements` for
  a `(client, network, asset)` always equals `merchant_balances.available_raw +
  reserved_raw`. Checkable in SQL, and checked by the test script.
- **B2** — Crediting is exactly-once under retry, crash, and duplicate
  confirmation, by the same mechanism deposits already use: a unique
  idempotency key, not application locking.
- **W1** — A withdrawal never debits more than was reserved, and a failed or
  rejected one releases the reservation in full. No path leaves value in
  `reserved_raw` with no live withdrawal pointing at it.
- **W2** — `available_raw` can never go negative. Enforced by a check constraint,
  not by the service.
- **W3** — An on-chain withdrawal is exactly-once against the chain: a crash
  between signing and broadcast re-signs a byte-identical transaction, exactly as
  `sweeps.account_nonce` / `authorization_nonce` achieve for sweeps.
- **W4** — Every withdrawal state change has an operator or an authenticated
  merchant attached to it, and every operator one writes an audit row in its own
  transaction (ADR-0006).
- **W5** — With `WITHDRAW_ENABLED` unset, no worker starts, no signature is
  produced, and the merchant API rejects withdrawal creation.

### 2.2 Non-objectives

- **On-chain DEX routing.** Phase 2's swap is a *book* swap: the gateway is the
  counterparty and prices it from `rates.ts`. No router address, no slippage
  model, no MEV surface. Chain-executed swaps are Phase 5 and a separate design.
- **Bridging.** `USDC on eth-sepolia → USDC on polygon-amoy` is not a swap; it is
  a bridge, with a different trust model and a different failure mode. Rejected
  at validation with a distinct error, not silently treated as a swap.
- **Fiat off-ramp.** Withdrawing COP to a Colombian bank account needs a PSP
  relationship, KYC, and a regulatory posture none of which exist here.
  `balance_cop` stays exactly what it is.
- **Merchant-facing UI.** `web/src/admin/` is the operator console and
  `web/src/checkout/` is payer-facing; there is no merchant portal to add a
  withdrawal screen to. Merchants use the API; operators use the console.
- **Changing what `/api/me` already returns.** `balance_cop` keeps its value and
  its name; the response *gains* a field.

---

## 3. Constraints this design is shaped by

Carried from `AGENTS.md`, and each one changes a specific decision below:

- Money is `bigint` in smallest units; raw amounts live in `numeric(78, 0)`;
  API/admin JSON serializes bigints as strings. → every new amount column and
  every new response field.
- Decimals come from the registry per pairing (ADR-0003). → the balance key, and
  the refusal to pool by symbol.
- `/admin` reads and writes are two routers; mutations live in `admin-write.ts`
  behind `requireOperator`, with `recordAudit` inside the mutation's transaction
  (ADR-0005, ADR-0006). → §8.2.
- Every signature goes through `Signer`; no module outside `signer.ts` imports
  `derivation.ts` for key purposes (ADR-0007). → §7.1's new role goes *in*
  `signer.ts`.
- Nothing in `src/` calls `console`; facts are logger attributes, not
  interpolated text. → §9.
- Frontend data goes through TanStack Query with `refreshInterval()`; console
  filters live in the URL via `validateSearch`. → §8.4.
- No test-runner suite. Verification is `typecheck`, `typecheck:web`, and
  standalone scripts with fixed rates and injected deposits. → §11.

---

## 4. Data model

### 4.1 `merchant_balances` — the spendable balance

```ts
export const merchantBalances = pgTable("merchant_balances", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: uuid("client_id").notNull().references(() => clients.id),
  network: text("network").notNull(),      // see NETWORKS in src/config.ts
  asset: text("asset").notNull(),          // symbol within that network
  /** Free to spend. Never negative — enforced by the check constraint below. */
  availableRaw: rawAmount("available_raw").notNull().default(sql`0`),
  /** Held against live withdrawals. Released on failure, debited on success. */
  reservedRaw: rawAmount("reserved_raw").notNull().default(sql`0`),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("merchant_balances_key_idx").on(t.clientId, t.network, t.asset),
  check("merchant_balances_non_negative",
    sql`${t.availableRaw} >= 0 and ${t.reservedRaw} >= 0`),
]);
```

A row is created lazily on first credit (`onConflictDoUpdate` against the unique
index), so a merchant with no USDT on BSC has no row rather than a zero row, and
the balances list is what the merchant actually holds.

**The `(network, asset)` pair is validated against the registry on the way in**,
resolved through `NETWORKS` rather than `NETWORK_IDS` — a withheld mainnet
definition has to keep resolving so historical balances still render, exactly as
payments do.

### 4.2 `balance_movements` — the append-only trail

```ts
export const balanceMovements = pgTable("balance_movements", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: uuid("client_id").notNull().references(() => clients.id),
  network: text("network").notNull(),
  asset: text("asset").notNull(),
  /** Signed: + credit, − debit. Sums to available + reserved, always (B1). */
  deltaRaw: rawAmount("delta_raw").notNull(),
  /** 'payment_credit' | 'withdrawal_debit' | 'withdrawal_release'
   *  | 'swap_out' | 'swap_in' | 'internal_out' | 'internal_in'
   *  | 'fee' | 'adjustment' | 'backfill' */
  kind: text("kind").notNull(),
  refType: text("ref_type"),               // 'payment' | 'withdrawal' | null
  refId: uuid("ref_id"),
  /**
   * Exactly-once (B2). Deterministic per event — `payment:<id>:credit`,
   * `withdrawal:<id>:debit` — so a retried confirmation, a replayed worker tick
   * and a duplicate approval all collapse to the row that already exists. The
   * uniqueness is the guarantee; no application lock is trusted for it.
   */
  idempotencyKey: text("idempotency_key").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("balance_movements_idem_idx").on(t.idempotencyKey),
  index("balance_movements_client_idx").on(t.clientId, t.network, t.asset, t.createdAt),
  index("balance_movements_ref_idx").on(t.refType, t.refId),
]);
```

Append-only, for the same reason `admin_audit_log` is: a trail you can edit
answers a different question than the one it is kept for. `merchant_balances` is
a cache of this table's running sum — recomputable, and recomputed by the
reconciliation check in §11.3.

`ledger_entries` is **kept unchanged**. It is the COP trail for the COP column,
it is read by `admin.ts` and `admin-write.ts`, and conflating the two would put
two units in one table.

### 4.3 `withdrawals`

```ts
export const withdrawalType = pgEnum("withdrawal_type", [
  "transfer",  // on-chain, to an external address
  "swap",      // one balance of this merchant into another
  "internal",  // book transfer to another merchant; no chain
]);

export const withdrawalStatus = pgEnum("withdrawal_status", [
  "requested",   // created; funds reserved; awaiting approval
  "approved",    // cleared to execute
  "authorized",  // signed (transfer only) — safe to re-sign, see W3
  "broadcast",   // submitted, awaiting confirmations (transfer only)
  "confirmed",   // final, reservation debited
  "settled",     // final for swap/internal, which never touch a chain
  "rejected",    // operator refused; reservation released
  "cancelled",   // merchant withdrew the request; reservation released
  "failed",      // terminal after max attempts; reservation released
]);
```

Columns, grouped by what they are for:

| Group | Columns |
|---|---|
| identity | `id`, `client_id`, `type`, `status`, `idempotency_key` (unique per client) |
| source | `network`, `asset`, `amount_raw` |
| fee | `fee_raw`, `fee_asset` — the gateway fee, reserved with the amount |
| `transfer` | `to_address`, `tx_hash`, `block_number`, `account_nonce`, `network_fee_raw` |
| `swap` | `dest_network`, `dest_asset`, `dest_amount_raw`, `quote_rate_e6`, `quote_expires_at` |
| `internal` | `to_client_id` |
| control | `requested_via` (`'api'` \| `'console'`), `operator_id`, `approved_by`, `approved_at`, `attempts`, `next_attempt_at`, `last_error`, `reason` |
| time | `created_at`, `updated_at` |

Indexes: `(client_id, created_at)` for the merchant list, `(status,
next_attempt_at)` for the worker's due query — the same shape as
`sweeps_due_idx` — and a unique `(client_id, idempotency_key)`.

`account_nonce` is persisted **before** broadcast and re-used on retry, which is
what makes W3 hold; the reasoning is identical to `sweeps.account_nonce` and is
written out in §6.3 of the sweeping plan rather than repeated here.

### 4.4 `merchant_payout_addresses` — the allow-list

```
id, client_id, network, address, label, created_by (operator), created_at,
disabled_at
```

Unique on `(client_id, network, address)`. When
`WITHDRAW_REQUIRE_ALLOWLIST` is on (default), a `transfer` to an address with no
active row here is rejected at validation. §8.3 explains why this is not
optional in spirit.

### 4.5 Migration and backfill

`bun run db:generate`, one migration, committed under `drizzle/`. Two parts:

- **Schema** — four tables, two enums, one check constraint. Purely additive; no
  existing column is altered or dropped.
- **Backfill** — for every `payments` row with `status = 'paid'`, one
  `balance_movements` row of `kind = 'backfill'`, `delta_raw = confirmed_raw`,
  keyed `payment:<id>:credit` — the *same* key the live path will use, so a
  historical payment cannot be credited twice by a later replay.

The backfill is a judgement call and should be run deliberately, not silently
inside the schema migration: it decides that historical settlements are owed to
merchants in crypto as well as recorded in COP. Ship it as
`scripts/backfill-balances.ts` with a `--dry-run` default that prints the totals
per merchant and pairing first. On this deployment the amounts are testnet
amounts, but the decision it encodes is not a testnet decision.

---

## 5. Crediting — where balances come from

One new call site, inside the transaction that already settles the payment
(`confirmDeposit`, `src/services/payments.ts`). Nothing else credits.

```ts
// after the existing status/ledger/webhook writes, same tx
await credit(tx, {
  clientId: payment.clientId,
  network: payment.network,
  asset: dep.asset,               // what ARRIVED, not what was quoted
  amountRaw: confirmedRaw,        // what CONFIRMED, not what was quoted
  kind: "payment_credit",
  ref: { type: "payment", id: payment.id },
  idempotencyKey: `payment:${payment.id}:credit`,
});
```

Three deliberate choices in five lines:

- **`confirmedRaw`, not `amount_crypto_raw`.** The merchant is credited what the
  chain delivered. Under dust tolerance a payment settles slightly short and the
  merchant is credited slightly short — correct. Overpayment is credited rather
  than stranded, which closes the gap `payments.ts:417` currently logs as a
  warning. `overpaid_raw` keeps its meaning for reconciliation.
- **Same transaction.** ADR-0002's event-sourced settlement means a committed
  `paid` payment without its credit must be impossible, for the same reason a
  committed audit-less mutation is.
- **No balance is ever read by settlement.** The credit is a write. Settlement
  still never calls `balanceOf`, so this changes nothing about ADR-0009 or about
  sweeping being free to empty an address mid-grace.

**Late deposits on an already-`paid` payment.** Today they update
`overpaid_raw` and stop, and the guard exists so a payment is not *settled*
twice. Crediting the incremental delta is a different act and is safe: the key
`payment:<id>:deposit:<deposit_id>` is per deposit, so each confirmed deposit
credits once and only once. Phase 0 does this; it is the direct reason the
"already settled — merchant not credited again" warning stops being an
unresolved loss.

**Mismatched-asset deposits** stay refused in Phase 0. Settling the payment
against an unquoted rate remains wrong (AGENTS.md), but *crediting the asset that
actually arrived* needs no rate at all, so the refusal is worth revisiting —
deliberately, in Phase 5, with the payment left unsettled.

---

## 6. Balance service (`src/services/balances.ts`)

The only module that writes `merchant_balances` or `balance_movements`. Four
functions, each taking a `Tx` so it composes into a caller's transaction:

| Function | Effect |
|---|---|
| `credit(tx, m)` | `+available`, one movement. Idempotent by key: an existing key is a no-op returning the prior movement. |
| `reserve(tx, m)` | `available → reserved`. Fails if `available < amount`; the check constraint is the backstop (W2). |
| `release(tx, m)` | `reserved → available`. |
| `settle(tx, m)` | `−reserved`, one negative movement. The debit only ever consumes a reservation. |

Every one takes the balance row's lock first (`select … for update` on
`(client_id, network, asset)`), the same discipline `confirmDeposit` uses on
`payments`. Read helpers — `balancesFor(clientId)`, `balanceSheet()` for the
cross-merchant console view — do not lock.

Amounts round nowhere. There is no rounding in this module because there is no
unit conversion in it; conversion is the swap's problem and is §7.2's.

---

## 7. Execution

### 7.1 The payout wallet (`transfer`)

A fourth key role, added to `KeyRef` in `src/services/signer.ts` — inside the
boundary, which is what ADR-0007 requires:

```ts
export type KeyRef =
  | { role: "deposit"; family: Family; index: number }
  | { role: "relayer"; family: Family }
  | { role: "payout"; family: Family };   // new
```

Derived from `HD_MNEMONIC` at a **distinct BIP-32 account index**, alongside
`DEPOSIT_ACCOUNT` and `RELAYER_ACCOUNT`, so its addresses can never collide with
a deposit address the payment path issues. `LocalSigner` gains nothing but a
branch; `RemoteSigner` (Phase 6 of the sweeping plan) gains one more key id.

What this buys, stated plainly:

- **Treasury stays key-free.** It remains a destination. The sweeper's guarantee
  is untouched.
- **The blast radius is the working float.** An operator moves value from
  treasury to the payout address deliberately, in the amount they are willing to
  have online. Nothing automates treasury → payout; that is the whole point.
- **It is checkable.** `walletOverview()` in `services/treasury.ts` already
  reports balances per family; the payout address joins that view, and a
  withdrawal that would exceed it is refused before anything is signed
  (`insufficient_float`), not after.

EVM transfers use `signTransaction` and go out as ordinary ERC-20 `transfer` or
native value sends — `evm-sweep.ts` already has the gas-estimation and
broadcast machinery to borrow from. **Tron is deliberately last**: it needs
energy/bandwidth on the payout account, which is the same unsolved problem as
Phase 3 of the sweeping plan, and until that lands a Tron `transfer` is rejected
with `unsupported_pairing` rather than half-implemented.

### 7.2 Swap

A **book swap**. The gateway debits one balance and credits another at a rate it
quotes; no chain is touched and the withdrawal goes `requested → approved →
settled` in one transaction.

The rate is a cross-rate through COP, which is what `rates.ts` already produces:

```
dest_amount = amount × rate_cop_e6(src) ÷ rate_cop_e6(dest)
```

with the decimals of each pairing read from the registry, and **rounding against
the merchant** (down on what they receive), the mirror of `copToRaw` rounding up
on what a payer owes. `quote_rate_e6` and `quote_expires_at` freeze it exactly as
a payment freezes its rate, so an approval that lands ten minutes later executes
at the quoted price or is rejected as `quote_expired` — never silently repriced.

**The solvency gate is the part that must not be skipped.** A book swap makes the
gateway the counterparty: after it, the merchant is owed an asset the gateway may
not hold. Before settling, the service checks the treasury and payout float for
the destination pairing and refuses with `insufficient_liquidity` if the platform
is short. `WITHDRAW_SWAP_ENABLED` is separate from `WITHDRAW_ENABLED` and off by
default, because this is the one withdrawal type that creates an obligation
rather than discharging one.

Same-asset cross-network is rejected as `bridge_not_supported` (§2.2).

### 7.3 Internal

Debit one merchant, credit another, one transaction, two movements
(`internal_out` / `internal_in`), keys `withdrawal:<id>:out` and
`withdrawal:<id>:in`. Both merchants must be active; the destination is
identified by client id, never by API key. No chain, no fee by default, and no
approval requirement worth arguing about — it is a book entry within one
platform, so `WITHDRAW_REQUIRE_APPROVAL` still gates it but the operator has
nothing external to verify.

### 7.4 Worker (`src/workers/withdrawer.ts`)

Only `transfer` needs one. It mirrors `workers/sweeper.ts` closely enough that
the shape should be lifted rather than reinvented: an interval loop per family,
a due query on `(status, next_attempt_at)`, exponential backoff on
`attempts`/`next_attempt_at`, `WITHDRAW_MAX_ATTEMPTS` to terminal `failed`, and
a confirmation pass that watches `tx_hash` to the network's configured
confirmation depth before `confirmed`.

Started from `src/index.ts` alongside the existing supervisors, and only when
`WITHDRAW_ENABLED` is set (W5).

---

## 8. Surfaces

### 8.1 Merchant API (`src/api/routes.ts`, behind `apiKeyAuth`)

| Route | Notes |
|---|---|
| `GET /api/me` | Gains `balances: [{ network, asset, decimals, available_raw, reserved_raw, available, cop_value }]`. `balance_cop` unchanged. |
| `GET /api/balances` | The same list, standalone. |
| `POST /api/withdrawals` | Body discriminated on `type`. Requires an `Idempotency-Key` header; a repeat returns the original withdrawal rather than creating a second. |
| `GET /api/withdrawals` | Paged, filterable by status and type. |
| `GET /api/withdrawals/:id` | Single. |

All raw amounts serialize as strings. `available` is a display-formatted decimal
computed from the pairing's decimals; `cop_value` is indicative, marked as such
in the docs, and computed at read time from `rates.ts` — it is not a balance.

### 8.2 Console (`src/api/admin.ts` reads, `src/api/admin-write.ts` writes)

The split is ADR-0005 and is not negotiable per-route:

| Router | Route |
|---|---|
| `admin.ts` | `GET /admin/api/withdrawals` (cross-merchant, filterable), `GET /admin/api/withdrawals/:id`, `GET /admin/api/balances` (the platform balance sheet), and `merchant_balances` folded into the existing merchant detail response |
| `admin-write.ts` | `POST /admin/api/withdrawals` (operator-issued), `POST /admin/api/withdrawals/:id/approve`, `POST /admin/api/withdrawals/:id/reject`, `POST /admin/api/balances/adjust`, `POST /admin/api/clients/:id/payout-addresses`, `DELETE …/:addressId` |

Every write goes behind `requireOperator` and writes `recordAudit` **inside its
own transaction** (ADR-0006). New entries in `AUDIT_ACTIONS`:
`withdrawal.create`, `withdrawal.approve`, `withdrawal.reject`,
`withdrawal.cancel`, `balance.adjust`, `merchant.payout_address.add`,
`merchant.payout_address.remove`.

`detail` is hand-built from an explicit field list per route — never a spread of
a row. A `withdrawals` row carries a destination address and a client id; a
`clients` row carries `api_key_hash` and `webhook_secret`.

`balance.adjust` is the manual correction path, and it is the one route here that
can conjure value. It takes a mandatory free-text reason, writes an `adjustment`
movement, and is the reason `balance_movements` is append-only.

### 8.3 The new attack surface, stated before it is built

Today a leaked merchant API key mints payments — an annoyance. After Phase 4 it
**moves money**. That is a genuine escalation and the mitigations are part of the
feature, not hardening to add later:

- `WITHDRAW_REQUIRE_APPROVAL` **on by default**: an API-created withdrawal sits
  in `requested` until a named operator approves it in the console.
- `WITHDRAW_REQUIRE_ALLOWLIST` **on by default**: destinations come from
  `merchant_payout_addresses`, which only an operator can add (§4.4). A stolen key
  can then only send funds where the merchant already said to send them.
- Per-request and per-day caps (`WITHDRAW_MAX_PER_REQUEST_USD`,
  `WITHDRAW_MAX_PER_DAY_USD`), evaluated against `rates.ts`.
- Withdrawal creation is `application/json`-only and idempotency-keyed, matching
  the console's existing CSRF posture.

None of these is sufficient alone; together they mean the worst case of a key
leak is a payout to an address the merchant nominated, under a cap, that a human
approved.

### 8.4 Console UI (`web/src/admin/`)

- **`/admin/withdrawals`** — a new route beside `SweepsRoute.tsx`, which is the
  closest existing analogue (status enum, retry counts, terminal states) and
  should be the visual model. Filters in the URL via `validateSearch`; polling
  from `refreshInterval()`; status rendered through `web/src/lib/status.ts` so no
  state is carried by hue alone.
- **Approve / reject** — a confirm dialog showing merchant, pairing, amount, fee
  and destination, in the pattern `MerchantsRoute.tsx` already uses for
  destructive actions.
- **Merchant detail** — a balances table per pairing, and the payout-address
  list.
- **`WalletsPanel.tsx`** — gains the payout wallet beside treasury and relayer,
  so the float backing withdrawals is visible where the other wallets are.

English, dark, operator-facing. Checkout is untouched.

---

## 9. Observability

A scoped `getLogger("withdrawals")` and `getLogger("balances")`; facts as
attributes, never interpolated. Attribute names extend the existing namespaces
(`docs/architecture/observability.md`):

`withdrawal.id`, `withdrawal.type`, `withdrawal.status`,
`withdrawal.status_before`, `withdrawal.amount_raw`, `withdrawal.fee_raw`,
`withdrawal.dest_asset`, `withdrawal.quote_rate_e6`, `withdrawal.reason`,
`withdrawal.attempts`, `balance.available_raw`, `balance.reserved_raw`,
`balance.delta_raw`, `balance.kind`, `client.id`, plus the existing `chain.*` and
`wallet.*` for the on-chain path.

Destination addresses are logged; they are public chain data. The float address
is logged. Nothing that could carry a key or a secret goes near a log line —
redaction happens at the sink, but a call site should not lean on it.

Counters: `withdrawals.created`, `withdrawals.status{to}`,
`withdrawals.failed{reason}`, `balances.credited{network,asset}`.

One line per state transition, at the level the observability doc assigns:
`info` for a transition that went as intended, `warn` for a release, a rejection
or a quote expiry, `error` for a terminal failure.

---

## 10. Decisions that need an ADR

- **ADR-0010 — the payout wallet is not the treasury.** Why an on-chain
  withdrawal spends from a separate, human-funded float, and why the alternatives
  (treasury key, deposit-address payouts) were rejected. §1.3 and §7.1 are the
  argument; the ADR is where it becomes load-bearing.
- **ADR-0011 — merchant balances are crypto-denominated.** That `balance_cop` is
  a gross settled record and `merchant_balances` is the obligation; that the
  credit is what confirmed rather than what was quoted; and that a book swap
  makes the platform a counterparty, which is why it has its own gate.

---

## 11. Verification

No test-runner suite exists, so verification is scripts and typechecks
(`docs/contributing/verification.md`).

### 11.1 Typechecks

`bun run typecheck` (src + scripts) and `bun run typecheck:web` (which also
rejects unused symbols). Both must pass; the second is the one that catches a
half-wired route.

### 11.2 New script — `scripts/withdraw-test.ts`

Modelled on `scripts/sweep-test.ts`: `./quiet` first, a mock `Signer` via
`setSigner`, fixed rates via `primeRateCache`, injected deposits, no network
access. Cases:

1. Settlement credits the arrived asset with the confirmed amount; movement sum
   equals the balance (B1).
2. Replaying the same confirmation credits once (B2).
3. A late deposit on a `paid` payment credits the delta, once.
4. Overpayment lands in the balance and in `overpaid_raw`.
5. `reserve` beyond `available` is refused, and the check constraint rejects a
   forced negative (W2).
6. Reject and fail both release the reservation in full (W1).
7. A `transfer` interrupted between `authorized` and `broadcast` re-signs an
   identical transaction and reuses `account_nonce` (W3).
8. Swap rounds against the merchant, and an expired quote is refused.
9. `internal` moves value between two merchants with both movements or neither.
10. With `WITHDRAW_ENABLED` unset, creation is refused and no worker starts (W5).

### 11.3 Extended scripts

- `scripts/admin-test.ts` — approve/reject write an audit row in the mutation's
  transaction; a failed mutation writes none.
- `scripts/api-test.ts` — `/api/me` shape, idempotent creation, allow-list
  rejection, cap rejection. Run `bun run build:web` first, as both scripts assert
  the SPA is served.
- `scripts/smoke-test.ts` — assert the crypto credit beside the existing COP
  assertion.

### 11.4 Reconciliation check

A `--verify` mode on the backfill script that recomputes every balance from
`balance_movements` and reports drift. Cheap, and it is the only thing that
proves B1 on real data rather than on fixtures.

---

## 12. Documentation that must move with the code

Stale docs here are worse than absent ones, because `AGENTS.md` promises they are
authoritative:

| File | Change |
|---|---|
| `AGENTS.md` | The balance model, the payout-wallet boundary, the merchant API's new write surface |
| `docs/architecture/data-model.md` | Four tables, two enums, the movement/balance relationship |
| `docs/architecture/overview.md` | Withdrawals as a subsystem; the new worker |
| `docs/architecture/payment-lifecycle.md` | The credit at settlement; late-deposit crediting |
| `docs/architecture/wallets-and-keys.md` | The `payout` role and the account index |
| `docs/api/merchant.md` | Five routes, the `Idempotency-Key` contract, error codes |
| `docs/api/console.md` | Read and write routes, split by router |
| `docs/api/errors.md` | `insufficient_balance`, `insufficient_float`, `insufficient_liquidity`, `quote_expired`, `address_not_allowlisted`, `cap_exceeded`, `bridge_not_supported`, `unsupported_pairing` |
| `docs/operations/configuration.md` + `.env.example` | Every `WITHDRAW_*` dial, defaults, and what each refuses |
| `docs/operations/` | A `withdrawal-runbook.md`, beside `sweeping-runbook.md` |
| `docs/adr/` | 0010, 0011, and `index.md` |
| `docs/.vitepress/config.ts` | Sidebar entries for the runbook, the ADRs, this plan |
| `README.md` | One line in the feature list |

---

## 13. Configuration

All off by default. `preflightWithdrawals()` in `src/config.ts` mirrors
`preflightSweeping()` — called only from `src/index.ts`, keeping `config.ts`
import-time side-effect free — and **refuses to boot** on the combination that
matters: `WITHDRAW_ENABLED`, not dry-run, an in-process signer, and a served
mainnet.

| Variable | Default | Effect |
|---|---|---|
| `WITHDRAW_ENABLED` | unset | Nothing starts; creation is refused (W5) |
| `WITHDRAW_DRY_RUN` | `true` | Plans and records; never signs |
| `WITHDRAW_REQUIRE_APPROVAL` | `true` | API requests wait for an operator |
| `WITHDRAW_REQUIRE_ALLOWLIST` | `true` | Destinations must be pre-registered |
| `WITHDRAW_SWAP_ENABLED` | unset | Book swaps, separately gated (§7.2) |
| `WITHDRAW_MIN_USD` | `5` | Floor, as `SWEEP_MIN_USD` |
| `WITHDRAW_MAX_PER_REQUEST_USD` / `_PER_DAY_USD` | `500` / `2000` | Caps |
| `WITHDRAW_FEE_BPS` | `0` | Gateway fee, reserved with the amount |
| `WITHDRAW_INTERVAL_SEC` | `60` | Worker tick |
| `WITHDRAW_MAX_ATTEMPTS` | `8` | Terminal `failed` |

The signer is the existing `SWEEP_SIGNER` — there is one signer per process and a
second variable would let a deployment ask for remote custody on one path and get
in-process keys on the other.

---

## 14. Order of work

Each step leaves the tree typechecking and the gateway bootable with the feature
off.

1. **Phase 0** — schema + migration; `services/balances.ts`; the credit in
   `confirmDeposit`; `scripts/backfill-balances.ts` (dry-run default);
   `GET /api/balances` and the `/api/me` field; balances in the console's
   merchant detail. **Ship and verify before anything can be withdrawn** — a
   balance ledger that is wrong is much cheaper to find with nothing spending
   from it.
2. **Phase 1** — `withdrawals` table; `services/withdrawals.ts` with the request
   lifecycle and reservations; `internal` end-to-end; console approve/reject and
   the audit actions.
3. **Phase 2** — swap: quote, freeze, solvency gate, `WITHDRAW_SWAP_ENABLED`.
4. **Phase 3** — transfer: the `payout` role in `signer.ts`;
   `services/payouts.ts`; `workers/withdrawer.ts`; dry run first, EVM first, Tron
   explicitly refused until the sweeping plan's Phase 3 lands.
5. **Phase 4** — merchant API writes; the allow-list; caps; `/admin/withdrawals`
   and the wallets panel.
6. **Docs and ADRs move with each phase**, not after all of them.

Phase 5 items — crediting mismatched-asset deposits, DEX-executed swaps,
bridging, fiat off-ramp — are each a separate design and are named here only so
the boundary of this one is unambiguous.
