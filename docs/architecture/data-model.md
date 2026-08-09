# Data model

Everything below is `src/db/schema.ts`, which is the source of truth — schema changes
start there, then `bun run db:generate` writes the migration under `drizzle/` and
`bun run db:migrate` (locally) or `bun run db:deploy` (deployed, via
`scripts/migrate.ts`) applies it.

## Money and raw amounts

Two different column shapes hold money, and the difference is deliberate:

- **COP amounts** (`amount_cop`, `balance_cop`, ledger `amount_cop`) are `bigint` columns.
  COP has no minor unit, and the largest realistic balance never approaches int8's
  ~9.22 × 10¹⁸ ceiling.
- **Raw on-chain amounts** — `amount_crypto_raw`, `confirmed_raw`, `pending_raw`,
  `overpaid_raw` on `payments`; `amount_raw` on `deposits` and `sweeps`; `fee_raw` on
  `sweeps` — are `numeric(78, 0)`, via the repository's `rawAmount()` helper:

```ts
const rawAmount = (name: string) =>
  numeric(name, { precision: 78, scale: 0, mode: "bigint" });
```

`numeric(78, 0)` and not `bigint`, because int8 tops out at ~9.22 × 10¹⁸ and an
18-decimal asset blows straight through that — 50,000 COP of BEP20 USDT is roughly
1.2 × 10¹⁹ wei, and POL passes int8 at around 7,700 COP. A `bigint` column would not
round the excess; Postgres would raise `numeric field overflow` and the deposit would
fail to record — losing a payment that is already on-chain. 78 digits is exactly the
width of `uint256`, so no ERC-20 amount can exceed it. `mode: "bigint"` keeps the
TypeScript side unchanged either way: `bigint` in, `bigint` out, never a float. See
[ADR 0001](/adr/0001-numeric-78-as-bigint) for the record of this decision, and
[Invariants](/architecture/invariants) for the rule it backs (money is never a float).

## Enums

```ts
export const paymentStatus = pgEnum("payment_status", [
  "pending", "detecting", "partially_paid", "paid", "expired", "underpaid_expired",
]);

export const sweepStatus = pgEnum("sweep_status", [
  "planned", "authorized", "broadcast", "confirmed", "failed", "skipped",
]);
```

`payment_status` is the settlement state machine — see
[Payment lifecycle](/architecture/payment-lifecycle) for every transition. `sweep_status`
is the independent treasury-consolidation state machine — see
[Sweeping](/architecture/sweeping).

## Tables

### `clients`

A merchant. `apiKeyHash` is a SHA-256 digest — right for a random API key, wrong for a
password (see `admin_users` below for the contrast). `webhookSecret` signs outbound
webhooks. `balanceCop` is the credited COP balance, moved only by `confirmDeposit()`
settling a payment.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid, PK | |
| `name` | text | |
| `api_key_hash` | text, unique | SHA-256 of the plaintext key, shown once at creation/rotation |
| `webhook_url` | text, nullable | |
| `webhook_secret` | text | HMAC-SHA256 key for `X-Gateway-Signature` |
| `balance_cop` | bigint, default 0 | credited by `confirmDeposit`, never a float |
| `is_active` | boolean, default true | |
| `created_at` | timestamp | |

Index: `clients_api_key_hash_idx` (unique) — the lookup `apiKeyAuth` runs on every
merchant request.

### `payments`

One row per charge. `asset` and `network` together select a `(network, asset)` pairing
from the registry (`src/config.ts`); `amountCryptoRaw` and `rateCopPerUnitE6` are the
frozen quote. `address` + `derivationIndex` are the unique receiving address for this
payment and the HD index that produced it.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid, PK | |
| `public_id` | text, unique | the `/pay/:publicId` and webhook-facing id |
| `client_id` | uuid, FK → `clients.id` | |
| `amount_cop` | bigint | the merchant's charge |
| `asset` | text | `'USDC' \| 'USDT' \| 'BNB' \| 'POL' \| 'TRX'` |
| `network` | text | a key of `NETWORKS` in `src/config.ts` |
| `amount_crypto_raw` | numeric(78,0) | required amount, in the asset's smallest unit at this pairing |
| `rate_cop_per_unit_e6` | bigint | frozen COP per one whole token unit, ×1e6 |
| `address` | text | unique per-payment receiving address |
| `derivation_index` | integer | the `hd_counter` index this address came from |
| `status` | `payment_status`, default `pending` | |
| `confirmed_raw` | numeric(78,0), default 0 | matured deposits in the quoted asset |
| `pending_raw` | numeric(78,0), default 0 | deposits seen but not yet confirmed |
| `overpaid_raw` | numeric(78,0), default 0 | confirmed value above `amount_crypto_raw` |
| `quote_expires_at` | timestamp | |
| `grace_expires_at` | timestamp, nullable | set on the first deposit |
| `paid_at` | timestamp, nullable | |
| `metadata` | text, nullable | merchant-supplied JSON (e.g. `order_id`) |
| `created_at` / `updated_at` | timestamp | |

Indexes:

- `payments_public_id_idx` (unique) — the checkout and status routes.
- `payments_address_network_idx` (unique on `(address, network)`) — a receiving address
  is unique per network, and this is what the watchers join against.
- `payments_status_idx` — every "open payments" query (`ACTIVE = pending | detecting |
  partially_paid`) filters on this.

### `deposits`

One row per on-chain transfer the gateway recorded — one per `Transfer` log, or per
native-coin transaction. Idempotency and asset bookkeeping both live here; see
[Payment lifecycle](/architecture/payment-lifecycle) for how `registerDeposit` and
`confirmDeposit` use it.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid, PK | |
| `payment_id` | uuid, FK → `payments.id` | |
| `network` | text | |
| `tx_hash` | text | |
| `log_index` | integer | position of the `Transfer` log; **-1** for a native-coin transfer, which has no log |
| `from_address` | text | |
| `asset` | text | the symbol that **actually arrived** — not necessarily the payment's quoted asset |
| `amount_raw` | numeric(78,0) | |
| `block_number` | bigint | |
| `confirmed` | boolean, default false | set by the confirmer once confirmation depth is met |
| `created_at` | timestamp | |

Index: `deposits_tx_log_idx` (unique on `(network, tx_hash, log_index)`) — this is the
idempotency guarantee itself. The `-1` sentinel for native transfers is what keeps a
native credit from ever colliding with a real log index 0 in the same transaction.

`asset` records what arrived, not what was quoted, because a network now serves several
assets behind one address (USDT, USDC, and a native coin can all land at the same
receiving address). When `deposits.asset !== payments.asset`, both `registerDeposit` and
`confirmDeposit` record the row but refuse to credit it — see
[Invariants](/architecture/invariants).

### `ledger_entries`

An append-only audit trail of every balance change. `type` is `'payment_credit'` today
(a future manual adjustment would add `'adjustment'`); `amount_cop` is signed
(`+` credit, `-` debit).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid, PK | |
| `client_id` | uuid, FK → `clients.id` | |
| `payment_id` | uuid, FK → `payments.id`, nullable | |
| `amount_cop` | bigint | |
| `type` | text | |
| `created_at` | timestamp | |

No index beyond the primary key — it is read by client and by payment in the console,
both low-cardinality joins in this MVP's data volume.

### `webhook_jobs`

The outbound webhook queue. `event` is one of `payment.paid`, `payment.partially_paid`,
`payment.expired`, `payment.underpaid_expired`; `payload` is the serialized JSON body
(signed at delivery time, not at enqueue time, from `clients.webhookSecret`).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid, PK | |
| `client_id` | uuid, FK → `clients.id` | |
| `payment_id` | uuid, FK → `payments.id` | |
| `event` | text | |
| `payload` | text | serialized JSON |
| `attempts` | integer, default 0 | capped at 8 — see `MAX_ATTEMPTS` in `services/webhooks.ts` |
| `next_attempt_at` | timestamp, default now | exponential backoff, 10s up to 30min |
| `delivered_at` | timestamp, nullable | |
| `created_at` | timestamp | |

Index: `webhook_jobs_pending_idx` on `(delivered_at, next_attempt_at)` — the query
`deliverPendingWebhooks` runs every 5 seconds.

### `admin_users`

Console operators — people with a password, not merchants with an API key. Deliberately
a separate table from `clients`: the console is cross-merchant, and conflating the two
would make every merchant an operator.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid, PK | |
| `username` | text, unique | stored and compared lower-cased |
| `password_hash` | text | **argon2id**, never a bare digest — see [Console](/architecture/console) |
| `is_active` | boolean, default true | |
| `last_login_at` | timestamp, nullable | |
| `created_at` | timestamp | |

Index: `admin_users_username_idx` (unique).

### `admin_sessions`

Server-side sessions, one row per signed-in browser. The cookie carries a random token;
the row stores its SHA-256, so a database dump cannot be replayed as a login.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid, PK | |
| `user_id` | uuid, FK → `admin_users.id`, `onDelete: cascade` | |
| `token_hash` | text, unique | SHA-256 of the cookie token |
| `expires_at` | timestamp | |
| `last_seen_at` | timestamp, default now | |
| `ip_address` | text, nullable | |
| `user_agent` | text, nullable | |
| `created_at` | timestamp | |

Indexes: `admin_sessions_token_hash_idx` (unique — the lookup on every `/admin/api/*`
request), `admin_sessions_user_idx`, `admin_sessions_expires_idx`.

### `admin_audit_log`

Every mutation an operator makes through `/admin`, append-only. See
[Console](/architecture/console) for the write path this table backs; the shape here is
deliberate on four points documented directly on the table in `schema.ts`:

- **Append-only.** No route updates or deletes a row; a trail you can edit answers a
  different question than the one it exists for.
- **Written inside the mutation's own transaction**, wherever the mutation is a single
  transaction — so a committed change can never be missing its record.
- **The operator is snapshotted, not only referenced.** `operator_username` survives a
  rename; the foreign key is `set null`, not `cascade` — deleting an account must not
  delete the evidence of what it did.
- **No secret is ever stored here.** `detail` is hand-built per route from an explicit
  field list and scrubbed again on the way in (`services/audit.ts`).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid, PK | |
| `operator_id` | uuid, FK → `admin_users.id`, `onDelete: set null` | |
| `operator_username` | text | snapshotted at write time |
| `action` | text | e.g. `merchant.create`, `payment.create` — see `AUDIT_ACTIONS` |
| `target_type` | text | `'client' \| 'payment' \| 'operator'` |
| `target_id` | text, nullable | uuid or public id, depending on the target |
| `detail` | text, nullable | serialized JSON, secret-scrubbed |
| `outcome` | text | `'ok' \| 'denied' \| 'error'` |
| `ip_address` | text, nullable | |
| `user_agent` | text, nullable | |
| `trace_id` | text, nullable | joins a row to the request's own log lines |
| `created_at` | timestamp | |

Indexes: `admin_audit_created_idx`, `admin_audit_target_idx` on `(target_type,
target_id)`, `admin_audit_operator_idx`.

### `sweeps`

One attempt to move one asset out of one deposit address to the treasury. See
[Sweeping](/architecture/sweeping) for the mechanism and phases; the schema-level
guarantee worth calling out here is the **exactly-once** design:

> The EIP-3009 replay key — 32 random bytes — is persisted **before anything is
> signed**. The token contract records a used authorization nonce and rejects a replay,
> so recovery after a crash re-signs the *stored* value and produces a byte-identical
> authorization: if the first broadcast landed, the chain refuses the second; if it did
> not, the second succeeds.

Deliberately **no foreign key to `payments` or `deposits`** — a sweep is about an
*address and an asset*, not a payment. Settlement is event-sourced from `Transfer` logs
and never reads a balance, so sweeping a deposit address at any moment — including
mid-grace on a `partially_paid` payment — cannot change what that payment settles at.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid, PK | |
| `network` | text | |
| `address` | text | the deposit address (source) |
| `derivation_index` | integer | |
| `asset` | text | |
| `amount_raw` | numeric(78,0) | |
| `to_address` | text | treasury, snapshotted at plan time |
| `via` | text | `'eip3009' \| 'prefund' \| 'delegate' \| 'native'` |
| `authorization_nonce` | text, nullable | the EIP-3009 replay key; null on paths with no authorization |
| `valid_before` | timestamp, nullable | |
| `account_nonce` | integer, nullable | relayer account nonce, persisted before broadcast for the same crash-safety reason |
| `tx_hash` | text, nullable | |
| `block_number` | bigint, nullable | |
| `fee_raw` | numeric(78,0), nullable | in the network's **fee** currency, not necessarily `asset` |
| `status` | `sweep_status`, default `planned` | |
| `reason` | text, nullable | why `skipped`/`failed`: `below_floor`, `fee_too_high`, ... |
| `attempts` | integer, default 0 | |
| `next_attempt_at` | timestamp, default now | |
| `last_error` | text, nullable | |
| `created_at` / `updated_at` | timestamp | |

Indexes:

- `sweeps_live_idx` — **partial** unique index on `(network, address, asset)` where
  `status in ('planned','authorized','broadcast')`. At most one *live* sweep per pairing;
  historical `confirmed`/`failed`/`skipped` rows never block a later sweep of the same
  address, because an address is reusable and will receive again.
- `sweeps_auth_nonce_idx` (unique on `(network, authorization_nonce)`) — two rows may
  never share an authorization nonce on one network; Postgres permits many `NULL`s, so
  paths without one are unaffected.
- `sweeps_due_idx` on `(status, next_attempt_at)` — what `dueSweeps()` polls.
- `sweeps_address_idx` on `(network, address)`.

### `hd_counter`

A single-row global counter: the next unused BIP-44 index for deposit addresses, and the
BIP-32 master fingerprint of the mnemonic that issued them.

| Column | Type | Notes |
|---|---|---|
| `id` | integer, PK, default 1 | always the single row |
| `next_index` | integer, default 0 | atomically incremented by `reserveDerivationIndex` |
| `seed_fingerprint` | text, nullable | binds the counter to one mnemonic; nullable only for rows that predate this column |

See [Wallets & keys](/architecture/wallets-and-keys) for why a mismatched fingerprint
fails boot and every subsequent issue, rather than silently continuing the sequence into
addresses a different seed owns.
