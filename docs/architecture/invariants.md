# Invariants

Load-bearing rules that every change has to keep holding, gathered on one page. Each was
stated once, deliberately, in the module that owns it — this page is a pointer back to
those places, not a replacement for reading them. Most trace back to `AGENTS.md`'s
Architecture section; where the code adds detail beyond that summary, the detail is here
too.

## Money is `bigint`, never a float

Every amount in `src/` — COP or raw on-chain units — is a JavaScript `bigint` all the way
from the database column to the API response. `payments.amountCop`, `confirmedRaw`,
`pendingRaw`, `overpaidRaw`; `deposits.amountRaw`; `sweeps.amountRaw`/`feeRaw`; every rate
(`rateCopPerUnitE6`) — none of it is ever a `number`. API and admin JSON serialize a
bigint as a **string**, because a JSON number cannot carry an 18-decimal raw amount
without silently losing digits.

COP-to-token conversion (`copToRaw`, `services/rates.ts`) **always rounds up** — ceiling
division — so the merchant is never under-collected by a fraction of a raw unit. See
[Pricing](/architecture/pricing).

## Decimals are a property of the pairing, never the symbol

USDC is 6 decimals on Polygon and 18 on BSC; the native coins are 18 on EVM and 6 on Tron.
Nothing may assume 6 (or any other constant) from a symbol alone — every conversion reads
`decimals` from the `(network, asset)` entry in the `NETWORKS` registry (`src/config.ts`)
via `tokenFor`/`assetFor`. This is why `payments.amountCryptoRaw`, `deposits.amountRaw`,
and `sweeps.amountRaw` are stored as `numeric(78,0)` rather than `bigint`/`int8`: an
18-decimal asset routinely exceeds int8's ceiling at everyday COP amounts. See
[ADR 0001](/adr/0001-numeric-78-as-bigint) and
[Data model](/architecture/data-model).

## Deposit idempotency: `(network, txHash, logIndex)`

Every on-chain transfer is recorded exactly once under this triple —
`deposits_tx_log_idx`, a unique index. `logIndex = -1` is the sentinel for a native-coin
transfer, which has no log to index; it can never collide with a real log's index 0 in
the same transaction. A duplicate insert (the WebSocket and the backfill both saw the same
`Transfer`, or a scan repeated) fails the unique constraint, `ON CONFLICT DO NOTHING`
absorbs it, and `registerDeposit` treats the empty return as `deposits.ignored{reason=
duplicate}` — never a second credit. See
[Payment lifecycle](/architecture/payment-lifecycle).

## Row locks around every state transition

`registerDeposit` and `confirmDeposit` (`services/payments.ts`) each run inside a
database transaction that locks the payment row with `FOR UPDATE` before reading it.
Two deposits confirming concurrently, or a deposit registering while a confirmation is in
flight, therefore serialize on the row rather than racing on `pendingRaw`/`confirmedRaw`.

## No double-credit

A deposit that confirms **after** its payment already reached `paid` must not credit the
merchant a second time. `confirmDeposit` checks `payment.status === "paid"` before
crediting anything; if it is already paid, the confirmed/pending numbers still move and
any excess is tracked in `overpaidRaw`, but `clients.balanceCop`, `ledger_entries`, and the
`payment.paid` webhook are untouched. This is the guard for a deposit that was mid-flight
— seen and pending — at the exact moment another deposit's confirmation already crossed
the settlement threshold.

## Wrong-asset deposits are recorded, never credited

A network now serves several assets behind one address (a stablecoin, its sibling, and a
native coin can all land at the same receiving address). `deposits.asset` records what
**actually arrived**; when it differs from `payments.asset`, both `registerDeposit` and
`confirmDeposit` write the row — for audit and for
[Sweeping](/architecture/sweeping)'s candidate selection, which needs exactly this
value to find funds no watcher's settlement path would otherwise surface — but refuse to
apply it to `pendingRaw`/`confirmedRaw`. Crediting it would price the payment against a
rate nobody quoted for that asset.

## Late and terminal deposits are recorded for reconciliation

A deposit against a `paid`/`expired`/`underpaid_expired` payment, or one that arrives
after both the quote window and the grace window have closed, is inserted into
`deposits` and then left alone — no state change, an explicit `warn`-level log naming the
reason (`terminal_payment`, `late`). The transfer is real and on-chain regardless of
whether anything can still settle from it; a row that vanished from view for either
reason is a worse outcome than a row a human has to look at.

## Settlement is event-sourced, never balance-based

`registerDeposit`/`confirmDeposit` build `confirmed_raw`/`pending_raw` entirely from
`Transfer` log data and block bodies. There is no `balanceOf`, `eth_getBalance`, or
`readContract` anywhere in the payment path. The one legitimate exception is
[Sweeping](/architecture/sweeping)'s reconciliation worker
(`workers/sweep-recon.ts`), which reads balances purely to **audit** against the ledger
and never feeds a payment column. This is what lets sweeping run as an independent
subsystem: emptying a deposit address at any moment cannot change what a payment settles
at.

## Console mutations need an operator and an audit row

`requireOperator` (`src/api/admin-auth.ts`) refuses a write from an open console — no
`ADMIN_PASSWORD` means no identity to attribute a change to — and rejects a non-JSON body
on a mutating method, which together with the session cookie's `SameSite=Lax` is what
keeps the write surface from being CSRF-able. `recordAudit` (`services/audit.ts`) then
writes `admin_audit_log` **inside the mutation's own transaction**, so a committed change
cannot exist without its record; `recordDetachedAudit` is the one documented exception,
used only where the mutation is owned by a core service (`createPayment`) that cannot be
made to share a transaction handle with the console. `detail` is hand-built per route from
an explicit field list, never a spread of a database row — a `clients` row carries
`apiKeyHash` and `webhookSecret`. See [Console](/architecture/console).

## The signer boundary

Every signature the gateway produces goes through the `Signer` interface
(`services/signer.ts`), and key material never crosses it. No module outside that file
may import `services/derivation.ts` for key purposes — `deriveEvmAccount` and
`deriveTronKey` are imported there alone; `deriveAddress` is the address-only escape
hatch every other caller uses. `getSigner()` throws rather than silently substituting the
in-process `LocalSigner` when `SWEEP_SIGNER` names an implementation that does not exist,
and `preflight()` refuses to boot `SWEEP_SIGNER=local` live sweeping against a served
mainnet. See [Wallets & keys](/architecture/wallets-and-keys).

## One mnemonic, one database

`hd_counter.seed_fingerprint` binds the derivation counter to the BIP-32 fingerprint of
one mnemonic. `reserveDerivationIndex` will not issue an index to any other tree — a
swapped `HD_MNEMONIC` fails at boot (`assertSeedIdentity`) and at the next payment
(`reserveDerivationIndex`) rather than quietly continuing the sequence into addresses the
previous seed owns. See [Wallets & keys](/architecture/wallets-and-keys).

## `numeric(78,0)` for every raw on-chain column

Not `bigint`: int8 tops out at ~9.22 × 10¹⁸, and an 18-decimal asset passes that at
everyday amounts (50,000 COP of BEP20 USDT is already ~1.2 × 10¹⁹ raw units), where
Postgres raises `numeric field overflow` rather than rounding — losing a deposit that is
already on-chain. 78 digits is `uint256`'s decimal width, so no ERC-20 amount can exceed
it. `mode: "bigint"` keeps the TypeScript boundary unchanged. See
[ADR 0001](/adr/0001-numeric-78-as-bigint) and
[Data model](/architecture/data-model).

## Nothing calls `console` directly

Every log line goes through `getLogger()` (`src/observability/`), with facts in
attributes rather than interpolated into the message body. That single rule is what
makes level control, secret redaction, trace correlation, `/admin/api/logs`, and OTLP
export possible at all for every call site at once, rather than per line. See
[Observability](/architecture/observability).
