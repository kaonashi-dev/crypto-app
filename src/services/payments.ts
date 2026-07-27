import { and, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { db, schema } from "../db";
import { tokenFor, env, type NetworkId } from "../config";
import { getRateCopE6, copToRaw } from "./rates";
import { reserveDerivationIndex, deriveAddress } from "./wallet";
import { enqueueWebhook } from "./webhooks";
import { getLogger, addContextAttributes, count } from "../observability";

const nano = customAlphabet("abcdefghijkmnpqrstuvwxyz23456789", 14);

/**
 * The payment state machine's log.
 *
 * Every transition and every *refusal* to transition is recorded here, with the
 * numbers the decision was made on. A deposit that arrives and changes nothing
 * — wrong address, duplicate log, terminal payment, outside the window — is the
 * case that looks like a bug from outside, so each of those paths says so
 * explicitly rather than returning in silence.
 */
const log = getLogger("payments");

// -- Create payment ---------------------------------------------------
export async function createPayment(input: {
  clientId: string;
  amountCop: bigint;
  asset: string; // 'USDC' | 'USDT'
  network: NetworkId; // 'eth-sepolia' | 'base-sepolia' | 'tron-nile'
  metadata?: unknown;
}) {
  const done = log.time("payment created");
  const token = tokenFor(input.network, input.asset);
  if (!token) {
    log.warn("payment rejected — unsupported asset/network combination", {
      "payment.asset": input.asset,
      "chain.network": input.network,
      "client.id": input.clientId,
    });
    count("payments.rejected", { reason: "unsupported_pair" });
    throw new Error("Unsupported asset/network combination");
  }
  if (input.amountCop < 1000n) {
    log.warn("payment rejected — below minimum", {
      "payment.amount_cop": input.amountCop,
      "payment.minimum_cop": 1000,
      "client.id": input.clientId,
    });
    count("payments.rejected", { reason: "below_minimum" });
    throw new Error("Minimum amount: 1,000 COP");
  }

  const rate = await getRateCopE6(input.asset);
  const amountCryptoRaw = copToRaw(input.amountCop, rate, token.decimals);
  const derivationIndex = await reserveDerivationIndex();
  const address = deriveAddress(derivationIndex, input.network);

  const [payment] = await db
    .insert(schema.payments)
    .values({
      publicId: nano(),
      clientId: input.clientId,
      amountCop: input.amountCop,
      asset: input.asset,
      network: input.network,
      amountCryptoRaw,
      rateCopPerUnitE6: rate,
      address,
      derivationIndex,
      quoteExpiresAt: new Date(Date.now() + env.quoteTtlMin * 60_000),
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
    })
    .returning();

  count("payments.created", { network: input.network, asset: input.asset });
  // The quote is frozen from here on, so the inputs that produced it are logged
  // together with it: a payer disputing the amount is answered from this line.
  done({
    "payment.id": payment.publicId,
    "payment.uuid": payment.id,
    "client.id": input.clientId,
    "payment.amount_cop": input.amountCop,
    "payment.asset": input.asset,
    "chain.network": input.network,
    "payment.amount_crypto_raw": amountCryptoRaw,
    "payment.rate_cop_per_unit_e6": rate,
    "token.decimals": token.decimals,
    "token.address": token.address,
    "payment.address": address,
    "wallet.derivation_index": derivationIndex,
    "payment.quote_expires_at": payment.quoteExpiresAt,
    "payment.has_metadata": Boolean(input.metadata),
  }, "info");

  return payment;
}

// -- "Fully paid" threshold with tolerance ----------------------------
export function requiredWithTolerance(amountCryptoRaw: bigint): bigint {
  return (amountCryptoRaw * (10_000n - env.dustBps)) / 10_000n;
}

// -- Register a deposit seen on-chain (called by the watcher) ----------
// Idempotent per (network, txHash, logIndex).
export async function registerDeposit(input: {
  network: NetworkId;
  address: string;
  txHash: string;
  logIndex: number;
  from: string;
  amountRaw: bigint;
  blockNumber: bigint;
}) {
  // Identifies every record emitted for the rest of this deposit's handling,
  // including the ones confirmDeposit writes later in the same trace.
  const deposit = {
    "chain.network": input.network,
    "chain.tx_hash": input.txHash,
    "chain.log_index": input.logIndex,
    "chain.block_number": input.blockNumber,
    "deposit.address": input.address,
    "deposit.from": input.from,
    "deposit.amount_raw": input.amountRaw,
  };
  addContextAttributes({ "chain.tx_hash": input.txHash });

  await db.transaction(async (tx) => {
    const [payment] = await tx
      .select()
      .from(schema.payments)
      .where(
        and(
          eq(schema.payments.address, input.address),
          eq(schema.payments.network, input.network)
        )
      )
      .for("update");
    if (!payment) {
      // transfer to an address that isn't ours: ignore
      count("deposits.ignored", { reason: "unknown_address" });
      log.debug("deposit ignored — address is not ours", deposit);
      return;
    }

    addContextAttributes({ "payment.id": payment.publicId });

    // Terminal states no longer accept "useful" funds; we still record the
    // deposit for audit/refund purposes.
    const terminal = ["paid", "expired", "underpaid_expired"].includes(payment.status);

    const inserted = await tx
      .insert(schema.deposits)
      .values({
        paymentId: payment.id,
        network: input.network,
        txHash: input.txHash,
        logIndex: input.logIndex,
        fromAddress: input.from,
        amountRaw: input.amountRaw,
        blockNumber: input.blockNumber,
      })
      .onConflictDoNothing()
      .returning();

    if (inserted.length === 0) {
      // duplicate: the WebSocket and the backfill both saw it, or a scan repeated
      count("deposits.ignored", { reason: "duplicate" });
      log.debug("deposit ignored — already recorded", {
        ...deposit,
        "payment.id": payment.publicId,
        "payment.status": payment.status,
      });
      return;
    }

    count("deposits.registered", { network: input.network });
    log.info("deposit recorded", {
      ...deposit,
      "deposit.id": inserted[0].id,
      "payment.id": payment.publicId,
      "payment.status": payment.status,
      "payment.amount_crypto_raw": payment.amountCryptoRaw,
    });

    if (terminal) {
      // Recorded for reconciliation, but it can no longer move the payment.
      count("deposits.ignored", { reason: "terminal_payment" });
      log.warn("deposit does not settle — payment is already terminal", {
        ...deposit,
        "payment.id": payment.publicId,
        "payment.status": payment.status,
      });
      return;
    }

    // Did the deposit arrive inside a valid window?
    const now = new Date();
    const inQuoteWindow = now <= payment.quoteExpiresAt;
    const inGraceWindow = payment.graceExpiresAt ? now <= payment.graceExpiresAt : false;
    if (!inQuoteWindow && !inGraceWindow) {
      // arrived late: left for manual reconciliation
      count("deposits.ignored", { reason: "late" });
      log.warn("deposit does not settle — arrived after every window closed", {
        ...deposit,
        "payment.id": payment.publicId,
        "payment.status": payment.status,
        "payment.quote_expires_at": payment.quoteExpiresAt,
        "payment.grace_expires_at": payment.graceExpiresAt,
        "deposit.late_by_s": Math.round(
          (now.getTime() -
            (payment.graceExpiresAt ?? payment.quoteExpiresAt).getTime()) /
            1000
        ),
      });
      return;
    }

    const patch: Partial<typeof schema.payments.$inferInsert> = {
      pendingRaw: payment.pendingRaw + input.amountRaw,
      updatedAt: now,
    };
    // First deposit -> move to 'detecting' and open the grace window.
    if (payment.status === "pending") {
      patch.status = "detecting";
      patch.graceExpiresAt = new Date(now.getTime() + env.graceTtlMin * 60_000);
    }

    await tx.update(schema.payments).set(patch).where(eq(schema.payments.id, payment.id));

    log.info("payment pending balance updated", {
      "payment.id": payment.publicId,
      "payment.status_before": payment.status,
      "payment.status": patch.status ?? payment.status,
      "payment.pending_raw_before": payment.pendingRaw,
      "payment.pending_raw": patch.pendingRaw,
      "payment.confirmed_raw": payment.confirmedRaw,
      "payment.amount_crypto_raw": payment.amountCryptoRaw,
      "payment.window": inQuoteWindow ? "quote" : "grace",
      ...(patch.graceExpiresAt ? { "payment.grace_expires_at": patch.graceExpiresAt } : {}),
    });
    if (patch.status === "detecting") {
      count("payments.status", { to: "detecting" });
    }
  });
}

// -- Confirm deposits and settle (called by the confirmer) ------------
export async function confirmDeposit(depositId: string) {
  await db.transaction(async (tx) => {
    const [dep] = await tx
      .select()
      .from(schema.deposits)
      .where(eq(schema.deposits.id, depositId))
      .for("update");
    if (!dep) {
      log.warn("confirmation skipped — deposit no longer exists", { "deposit.id": depositId });
      return;
    }
    if (dep.confirmed) {
      log.debug("confirmation skipped — already confirmed", {
        "deposit.id": depositId,
        "chain.tx_hash": dep.txHash,
      });
      return;
    }

    const [payment] = await tx
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.id, dep.paymentId))
      .for("update");
    if (!payment) {
      log.error("confirmation skipped — deposit points at a missing payment", {
        "deposit.id": depositId,
        "payment.uuid": dep.paymentId,
      });
      return;
    }

    addContextAttributes({ "payment.id": payment.publicId, "chain.tx_hash": dep.txHash });

    await tx
      .update(schema.deposits)
      .set({ confirmed: true })
      .where(eq(schema.deposits.id, dep.id));

    const confirmedRaw = payment.confirmedRaw + dep.amountRaw;
    const pendingRaw = payment.pendingRaw - dep.amountRaw;
    const threshold = requiredWithTolerance(payment.amountCryptoRaw);
    const now = new Date();

    count("deposits.confirmed", { network: dep.network });
    // The arithmetic behind the settle/partial decision, stated before the
    // decision is taken — a payment that settles "one unit short" or refuses to
    // settle at all is explained by these five numbers plus DUST_TOLERANCE_BPS.
    log.info("deposit confirmed", {
      "deposit.id": dep.id,
      "chain.tx_hash": dep.txHash,
      "deposit.amount_raw": dep.amountRaw,
      "payment.id": payment.publicId,
      "payment.status": payment.status,
      "payment.confirmed_raw_before": payment.confirmedRaw,
      "payment.confirmed_raw": confirmedRaw,
      "payment.pending_raw": pendingRaw,
      "payment.amount_crypto_raw": payment.amountCryptoRaw,
      "payment.threshold_raw": threshold,
      "payment.shortfall_raw": confirmedRaw >= threshold ? 0n : threshold - confirmedRaw,
      "config.dust_bps": Number(env.dustBps),
    });

    // Already settled: a deposit registered while active but confirming after
    // settlement must NOT re-credit the merchant. Keep the accounting
    // consistent (move pending -> confirmed, track the extra as overpaid) and stop.
    if (payment.status === "paid") {
      const overpaid =
        confirmedRaw > payment.amountCryptoRaw ? confirmedRaw - payment.amountCryptoRaw : 0n;
      await tx
        .update(schema.payments)
        .set({ confirmedRaw, pendingRaw, overpaidRaw: overpaid, updatedAt: now })
        .where(eq(schema.payments.id, payment.id));
      count("deposits.late_confirmation");
      log.warn("payment already settled — merchant not credited again", {
        "payment.id": payment.publicId,
        "payment.confirmed_raw": confirmedRaw,
        "payment.overpaid_raw": overpaid,
        "payment.paid_at": payment.paidAt,
      });
      return;
    }

    if (confirmedRaw >= threshold) {
      // PAID: credit COP balance + ledger + webhook
      const overpaid =
        confirmedRaw > payment.amountCryptoRaw ? confirmedRaw - payment.amountCryptoRaw : 0n;
      await tx
        .update(schema.payments)
        .set({
          status: "paid",
          confirmedRaw,
          pendingRaw,
          overpaidRaw: overpaid,
          paidAt: now,
          updatedAt: now,
        })
        .where(eq(schema.payments.id, payment.id));
      await tx
        .update(schema.clients)
        .set({ balanceCop: sql`${schema.clients.balanceCop} + ${payment.amountCop}` })
        .where(eq(schema.clients.id, payment.clientId));
      await tx.insert(schema.ledgerEntries).values({
        clientId: payment.clientId,
        paymentId: payment.id,
        amountCop: payment.amountCop,
        type: "payment_credit",
      });
      await enqueueWebhook(tx, { ...payment, confirmedRaw, overpaidRaw: overpaid, paidAt: now }, "payment.paid");

      count("payments.status", { to: "paid" });
      count("payments.settled_cop", { network: payment.network }, Number(payment.amountCop));
      // The settlement line: what the merchant was credited and how long the
      // payer took from quote to settled.
      log.info("payment PAID — merchant credited", {
        "payment.id": payment.publicId,
        "client.id": payment.clientId,
        "payment.status_before": payment.status,
        "payment.amount_cop": payment.amountCop,
        "payment.asset": payment.asset,
        "chain.network": payment.network,
        "payment.confirmed_raw": confirmedRaw,
        "payment.amount_crypto_raw": payment.amountCryptoRaw,
        "payment.overpaid_raw": overpaid,
        "payment.time_to_pay_s": Math.round((now.getTime() - payment.createdAt.getTime()) / 1000),
        "ledger.type": "payment_credit",
      });
      if (overpaid > 0n) {
        log.warn("payment overpaid — excess is recorded, not refunded", {
          "payment.id": payment.publicId,
          "payment.overpaid_raw": overpaid,
        });
      }
    } else {
      // Confirmed but incomplete -> partial payment, grace keeps running.
      const wasPartial = payment.status === "partially_paid";
      await tx
        .update(schema.payments)
        .set({ status: "partially_paid", confirmedRaw, pendingRaw, updatedAt: now })
        .where(eq(schema.payments.id, payment.id));
      if (!wasPartial) {
        await enqueueWebhook(tx, { ...payment, confirmedRaw }, "payment.partially_paid");
        count("payments.status", { to: "partially_paid" });
      }
      log.warn("payment partially paid — still short", {
        "payment.id": payment.publicId,
        "payment.status_before": payment.status,
        "payment.confirmed_raw": confirmedRaw,
        "payment.threshold_raw": threshold,
        "payment.shortfall_raw": threshold - confirmedRaw,
        "payment.grace_expires_at": payment.graceExpiresAt,
        "webhook.enqueued": !wasPartial,
      });
    }
  });
}

// -- Expire windows (called by the expirer) ---------------------------
export async function expireStalePayments() {
  const now = new Date();
  // Comparisons go through drizzle's operators, not a raw `sql` template: a
  // template binds the Date as-is and the pg driver rejects it, which used to
  // make this whole worker throw on every tick (nothing ever expired).
  //
  // No funds and quote expired -> expired
  const expired = await db
    .update(schema.payments)
    .set({ status: "expired", updatedAt: now })
    .where(
      and(
        eq(schema.payments.status, "pending"),
        lt(schema.payments.quoteExpiresAt, now)
      )
    )
    .returning();

  // Partial funds and grace expired -> underpaid_expired
  const underpaid = await db
    .update(schema.payments)
    .set({ status: "underpaid_expired", updatedAt: now })
    .where(
      and(
        inArray(schema.payments.status, ["detecting", "partially_paid"]),
        isNotNull(schema.payments.graceExpiresAt),
        lt(schema.payments.graceExpiresAt, now)
      )
    )
    .returning();

  for (const p of expired) {
    await db.transaction((tx) => enqueueWebhook(tx, p, "payment.expired"));
    count("payments.status", { to: "expired" });
    log.info("payment expired — quote window closed with no funds", {
      "payment.id": p.publicId,
      "client.id": p.clientId,
      "payment.amount_cop": p.amountCop,
      "chain.network": p.network,
      "payment.address": p.address,
      "payment.quote_expires_at": p.quoteExpiresAt,
      "payment.age_s": Math.round((now.getTime() - p.createdAt.getTime()) / 1000),
    });
  }
  for (const p of underpaid) {
    await db.transaction((tx) => enqueueWebhook(tx, p, "payment.underpaid_expired"));
    count("payments.status", { to: "underpaid_expired" });
    // Needs a human: funds are on-chain at an address whose payment will never
    // settle, so this is louder than a plain expiry.
    log.warn("payment underpaid and expired — funds need reconciliation", {
      "payment.id": p.publicId,
      "client.id": p.clientId,
      "chain.network": p.network,
      "payment.address": p.address,
      "payment.confirmed_raw": p.confirmedRaw,
      "payment.pending_raw": p.pendingRaw,
      "payment.amount_crypto_raw": p.amountCryptoRaw,
      "payment.threshold_raw": requiredWithTolerance(p.amountCryptoRaw),
      "payment.grace_expires_at": p.graceExpiresAt,
    });
  }

  if (expired.length || underpaid.length) {
    log.info("expiry sweep", {
      "payments.expired": expired.length,
      "payments.underpaid_expired": underpaid.length,
    });
  } else {
    log.trace("expiry sweep — nothing to expire");
  }
}
