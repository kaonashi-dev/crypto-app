import {
  pgTable, uuid, text, timestamp, bigint, numeric, integer, boolean,
  pgEnum, uniqueIndex, index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * A raw on-chain amount, in the token's smallest unit.
 *
 * `numeric(78, 0)` and not `bigint`, because int8 tops out at ~9.22e18 and an
 * 18-decimal asset blows straight through that: 50,000 COP of BEP20 USDT is
 * ~1.2e19 wei, and POL passes int8 at roughly 7,700 COP. The column would not
 * round — Postgres raises `numeric field overflow` and the deposit fails to
 * record, losing a payment that is already on-chain. 78 digits is the width of
 * uint256, so no ERC-20 amount can exceed it.
 *
 * mode "bigint" keeps the TypeScript side exactly as it was: bigint in, bigint
 * out, never a float.
 */
const rawAmount = (name: string) =>
  numeric(name, { precision: 78, scale: 0, mode: "bigint" });

export const paymentStatus = pgEnum("payment_status", [
  "pending",            // created, waiting for funds
  "detecting",          // a mined Transfer was seen, not enough confirmations yet
  "partially_paid",     // confirmed sum > 0 but < required; grace window active
  "paid",               // completed and credited
  "expired",            // expired without receiving anything
  "underpaid_expired",  // grace expired with an incomplete payment -> manual resolution
]);

// -- Clients (merchants) ----------------------------------------------
export const clients = pgTable("clients", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  // For the MVP we store the SHA-256 hash of the api key; the plaintext key
  // is only shown once at creation time (scripts/seed.ts).
  apiKeyHash: text("api_key_hash").notNull(),
  webhookUrl: text("webhook_url"),
  webhookSecret: text("webhook_secret").notNull(),
  balanceCop: bigint("balance_cop", { mode: "bigint" }).notNull().default(sql`0`),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("clients_api_key_hash_idx").on(t.apiKeyHash)]);

// -- Payments ---------------------------------------------------------
export const payments = pgTable("payments", {
  id: uuid("id").primaryKey().defaultRandom(),
  publicId: text("public_id").notNull(),          // for the /pay/:publicId URL
  clientId: uuid("client_id").notNull().references(() => clients.id),
  amountCop: bigint("amount_cop", { mode: "bigint" }).notNull(),
  asset: text("asset").notNull(),                  // 'USDC' | 'USDT' | 'BNB' | 'POL' | 'TRX'
  network: text("network").notNull(),              // see NETWORKS in src/config.ts
  // Required amount in the asset's smallest unit. Decimals vary by pairing —
  // 6 for USDC on Polygon, 18 for the same symbol on BSC — so they are read
  // from the registry per payment, never assumed.
  amountCryptoRaw: rawAmount("amount_crypto_raw").notNull(),
  // Frozen rate: COP per 1 whole token unit, scaled x1e6 for precision
  rateCopPerUnitE6: bigint("rate_cop_per_unit_e6", { mode: "bigint" }).notNull(),
  address: text("address").notNull(),              // unique address for the payment
  derivationIndex: integer("derivation_index").notNull(),
  status: paymentStatus("status").notNull().default("pending"),
  confirmedRaw: rawAmount("confirmed_raw").notNull().default(sql`0`),
  pendingRaw: rawAmount("pending_raw").notNull().default(sql`0`),
  overpaidRaw: rawAmount("overpaid_raw").notNull().default(sql`0`),
  quoteExpiresAt: timestamp("quote_expires_at").notNull(),
  graceExpiresAt: timestamp("grace_expires_at"),   // set on the first deposit
  paidAt: timestamp("paid_at"),
  metadata: text("metadata"),                      // free-form merchant JSON (order_id, etc.)
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("payments_public_id_idx").on(t.publicId),
  uniqueIndex("payments_address_network_idx").on(t.address, t.network),
  index("payments_status_idx").on(t.status),
]);

// -- On-chain deposits (one per Transfer event, or per native transfer) ---
export const deposits = pgTable("deposits", {
  id: uuid("id").primaryKey().defaultRandom(),
  paymentId: uuid("payment_id").notNull().references(() => payments.id),
  network: text("network").notNull(),
  txHash: text("tx_hash").notNull(),
  // Position of the Transfer log inside the transaction, and -1 for a native
  // coin transfer, which is a field on the transaction rather than a log. The
  // sentinel is what keeps the idempotency index below total: real log indexes
  // start at 0, so a native credit can never collide with a token one in the
  // same transaction.
  logIndex: integer("log_index").notNull(),
  fromAddress: text("from_address").notNull(),
  // Which asset actually arrived. A network now carries several (USDT, USDC and
  // the native coin), and an address expecting one can receive another, so the
  // deposit records what was sent rather than inheriting the payment's asset —
  // see the mismatch guard in services/payments.ts.
  asset: text("asset").notNull(),
  amountRaw: rawAmount("amount_raw").notNull(),
  blockNumber: bigint("block_number", { mode: "bigint" }).notNull(),
  confirmed: boolean("confirmed").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  // idempotency: the same log is not processed twice (reorgs, reconnections)
  uniqueIndex("deposits_tx_log_idx").on(t.network, t.txHash, t.logIndex),
]);

// -- Client ledger (balance audit trail) ------------------------------
export const ledgerEntries = pgTable("ledger_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: uuid("client_id").notNull().references(() => clients.id),
  paymentId: uuid("payment_id").references(() => payments.id),
  amountCop: bigint("amount_cop", { mode: "bigint" }).notNull(), // + credit / - debit
  type: text("type").notNull(),                    // 'payment_credit', 'adjustment'
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// -- Outbound webhook queue -------------------------------------------
export const webhookJobs = pgTable("webhook_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: uuid("client_id").notNull().references(() => clients.id),
  paymentId: uuid("payment_id").notNull().references(() => payments.id),
  event: text("event").notNull(),                  // 'payment.paid', 'payment.partially_paid', ...
  payload: text("payload").notNull(),              // serialized JSON
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at").notNull().defaultNow(),
  deliveredAt: timestamp("delivered_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("webhook_jobs_pending_idx").on(t.deliveredAt, t.nextAttemptAt)]);

// -- Console operators -------------------------------------------------
// Who may open /admin. Separate from `clients`: a merchant is an API caller with
// a key, an operator is a person with a password, and the console is
// cross-merchant — conflating the two would make every merchant an operator.
export const adminUsers = pgTable("admin_users", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Stored lower-cased and compared as stored, so "Admin" and "admin" are one
  // account rather than two the unique index would happily keep apart.
  username: text("username").notNull(),
  // Argon2id PHC string (see services/admin-auth.ts). Never a plaintext password
  // and never a bare digest: an unsalted hash of an operator password is a
  // lookup away from the password itself.
  passwordHash: text("password_hash").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  lastLoginAt: timestamp("last_login_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("admin_users_username_idx").on(t.username)]);

// -- Console sessions --------------------------------------------------
// Server-side sessions rather than a signed stateless token: the point of
// replacing the shared Basic credential is being able to say who is in and to
// cut them off, and only a row you can delete does the second part. The cookie
// carries an opaque random token; what is stored is its SHA-256, so a leaked
// database dump cannot be replayed as a login.
export const adminSessions = pgTable("admin_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => adminUsers.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
  // Enough to recognise your own session in the list, and to notice one you do
  // not recognise. Not a substitute for an access log.
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("admin_sessions_token_hash_idx").on(t.tokenHash),
  index("admin_sessions_user_idx").on(t.userId),
  index("admin_sessions_expires_idx").on(t.expiresAt),
]);

// -- Console audit trail -----------------------------------------------
/**
 * Every mutation an operator makes through /admin, append-only.
 *
 * This table is the precondition the rest of the console's write surface was
 * waiting on: `AGENTS.md` holds `/admin` to no console-driven mutation without an
 * audit model, and a cross-merchant tool that can mint API keys is exactly the
 * one whose actions have to be attributable afterwards.
 *
 * Four properties it is shaped by:
 *
 *  - **Append-only.** No route updates or deletes a row here, and none should be
 *    added: a trail you can edit answers a different question than the one it is
 *    kept for.
 *  - **Written in the mutation's own transaction** wherever the mutation is a
 *    single transaction, so a committed change can never be missing its record.
 *  - **The operator is snapshotted, not only referenced.** `operator_username`
 *    survives a rename, and the foreign key is `set null` rather than `cascade` —
 *    deleting an account must not delete the evidence of what it did.
 *  - **No secret is ever stored here.** `detail` is built per route from an
 *    explicit field list and scrubbed again on the way in (services/audit.ts);
 *    an API key exists in exactly one HTTP response and nowhere else.
 */
export const adminAuditLog = pgTable("admin_audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  operatorId: uuid("operator_id").references(() => adminUsers.id, { onDelete: "set null" }),
  operatorUsername: text("operator_username").notNull(),
  /** 'merchant.create' | 'merchant.update' | 'payment.create' | … */
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),  // 'client' | 'payment' | 'operator'
  targetId: text("target_id"),                // uuid or public id, depending on the target
  detail: text("detail"),                     // serialized JSON, secret-scrubbed
  outcome: text("outcome").notNull(),         // 'ok' | 'denied' | 'error'
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  /**
   * The request's trace id, which is what makes a row here expandable into the
   * full story: the same id is on every record the mutation emitted, and the
   * console's own log tail (/admin/api/logs) searches by it.
   */
  traceId: text("trace_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("admin_audit_created_idx").on(t.createdAt),
  index("admin_audit_target_idx").on(t.targetType, t.targetId),
  index("admin_audit_operator_idx").on(t.operatorId),
]);

// -- Treasury sweeps ---------------------------------------------------
// Consolidating per-payment deposit addresses into one treasury per family.
// See docs/design/SWEEPING-PLAN.md; this table is §6.
export const sweepStatus = pgEnum("sweep_status", [
  "planned",     // policy selected it; nothing signed yet
  "authorized",  // signed, and safe to re-sign or re-broadcast — see below
  "broadcast",   // submitted, awaiting confirmations
  "confirmed",   // final
  "failed",      // terminal after max attempts; needs an operator
  "skipped",     // deliberately not swept (below the floor, fee too high)
]);

/**
 * One attempt to move one asset out of one deposit address.
 *
 * Deliberately **no foreign key to `payments` or `deposits`**. A sweep is about
 * an *address and an asset*, not a payment: an address may hold value from
 * several deposits, from a deposit in an asset its payment never quoted, or from
 * a transfer that matched no payment at all. Coupling the two would make the
 * sweeper unable to recover exactly the funds most likely to be stranded, which
 * are the ones no payment claims.
 *
 * Nothing here is read by the payment state machine, and nothing here writes to
 * it. Settlement is event-sourced from Transfer logs and never reads a balance,
 * so emptying an address — at any moment, including mid-grace on a partially
 * paid payment — cannot change what a payment settles at. The address stays
 * usable and a later top-up is still detected and still credited.
 */
export const sweeps = pgTable("sweeps", {
  id: uuid("id").primaryKey().defaultRandom(),
  network: text("network").notNull(),          // see NETWORKS in src/config.ts
  address: text("address").notNull(),          // the deposit address (source)
  derivationIndex: integer("derivation_index").notNull(),
  asset: text("asset").notNull(),              // the symbol being moved
  amountRaw: rawAmount("amount_raw").notNull(),
  toAddress: text("to_address").notNull(),     // treasury, snapshotted at plan time
  via: text("via").notNull(),                  // 'eip3009' | 'prefund' | 'delegate' | 'native'

  /**
   * The EIP-3009 replay key: 32 random bytes, persisted BEFORE anything is
   * signed. This column is what makes a retry exactly-once.
   *
   * The token contract records a used authorization nonce and rejects a replay,
   * so recovery after a crash re-signs *this stored value* and produces a
   * byte-identical authorization: if the first broadcast landed the chain
   * refuses the second, and if it did not the second succeeds. The guarantee is
   * enforced on-chain rather than by our locking. Null on the paths that have no
   * authorization — there the account nonce below plays the same role.
   */
  authorizationNonce: text("authorization_nonce"),
  validBefore: timestamp("valid_before"),
  /** Relayer account nonce, persisted before broadcast for the same reason. */
  accountNonce: integer("account_nonce"),

  txHash: text("tx_hash"),
  blockNumber: bigint("block_number", { mode: "bigint" }),
  /** Fee actually paid, in the network's *fee* currency — not in `asset`. */
  feeRaw: rawAmount("fee_raw"),
  status: sweepStatus("status").notNull().default("planned"),
  /** Why a row is `skipped` or `failed`: 'below_floor', 'fee_too_high', … */
  reason: text("reason"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at").notNull().defaultNow(),
  lastError: text("last_error"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  // At most one *live* sweep per (network, address, asset). Partial, so
  // historical confirmed/failed/skipped rows never block a later sweep of the
  // same address — an address is reusable and will receive again.
  uniqueIndex("sweeps_live_idx")
    .on(t.network, t.address, t.asset)
    .where(sql`status in ('planned','authorized','broadcast')`),
  // Two rows may never share an authorization nonce on one network. Postgres
  // permits many NULLs in a unique index, so the paths without one are unaffected.
  uniqueIndex("sweeps_auth_nonce_idx").on(t.network, t.authorizationNonce),
  index("sweeps_due_idx").on(t.status, t.nextAttemptAt),
  index("sweeps_address_idx").on(t.network, t.address),
]);

// -- Global HD derivation counter -------------------------------------
export const hdCounter = pgTable("hd_counter", {
  id: integer("id").primaryKey().default(1),
  nextIndex: integer("next_index").notNull().default(0),
  // BIP-32 master fingerprint of the mnemonic these indexes were issued from.
  // Binds the counter to one tree so a swapped HD_MNEMONIC fails loudly instead
  // of continuing the sequence into addresses the previous seed owns. Nullable
  // for counters that predate it; adopted on the next boot (services/wallet.ts).
  seedFingerprint: text("seed_fingerprint"),
});
