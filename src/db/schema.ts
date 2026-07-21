import {
  pgTable, uuid, text, timestamp, bigint, integer, boolean,
  pgEnum, uniqueIndex, index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

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
  asset: text("asset").notNull(),                  // 'USDC'
  network: text("network").notNull(),              // 'eth-sepolia' | 'base-sepolia'
  // Required amount in raw token units (USDC -> 6 decimals)
  amountCryptoRaw: bigint("amount_crypto_raw", { mode: "bigint" }).notNull(),
  // Frozen rate: COP per 1 whole token unit, scaled x1e6 for precision
  rateCopPerUnitE6: bigint("rate_cop_per_unit_e6", { mode: "bigint" }).notNull(),
  address: text("address").notNull(),              // unique address for the payment
  derivationIndex: integer("derivation_index").notNull(),
  status: paymentStatus("status").notNull().default("pending"),
  confirmedRaw: bigint("confirmed_raw", { mode: "bigint" }).notNull().default(sql`0`),
  pendingRaw: bigint("pending_raw", { mode: "bigint" }).notNull().default(sql`0`),
  overpaidRaw: bigint("overpaid_raw", { mode: "bigint" }).notNull().default(sql`0`),
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

// -- On-chain deposits (one per Transfer event) -----------------------
export const deposits = pgTable("deposits", {
  id: uuid("id").primaryKey().defaultRandom(),
  paymentId: uuid("payment_id").notNull().references(() => payments.id),
  network: text("network").notNull(),
  txHash: text("tx_hash").notNull(),
  logIndex: integer("log_index").notNull(),
  fromAddress: text("from_address").notNull(),
  amountRaw: bigint("amount_raw", { mode: "bigint" }).notNull(),
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

// -- Global HD derivation counter -------------------------------------
export const hdCounter = pgTable("hd_counter", {
  id: integer("id").primaryKey().default(1),
  nextIndex: integer("next_index").notNull().default(0),
});
