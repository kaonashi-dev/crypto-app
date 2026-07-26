import { and, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { db, schema } from "../db";
import { tokenFor, env, type NetworkId } from "../config";
import { getRateCopE6, copToRaw } from "./rates";
import { reserveDerivationIndex, deriveAddress } from "./wallet";
import { enqueueWebhook } from "./webhooks";

const nano = customAlphabet("abcdefghijkmnpqrstuvwxyz23456789", 14);

// -- Create payment ---------------------------------------------------
export async function createPayment(input: {
  clientId: string;
  amountCop: bigint;
  asset: string; // 'USDC' | 'USDT'
  network: NetworkId; // 'eth-sepolia' | 'base-sepolia' | 'tron-nile'
  metadata?: unknown;
}) {
  const token = tokenFor(input.network, input.asset);
  if (!token) throw new Error("Unsupported asset/network combination");
  if (input.amountCop < 1000n) throw new Error("Minimum amount: 1,000 COP");

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
    if (!payment) return; // transfer to an address that isn't ours: ignore

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
    if (inserted.length === 0 || terminal) return; // duplicate or terminal

    // Did the deposit arrive inside a valid window?
    const now = new Date();
    const inQuoteWindow = now <= payment.quoteExpiresAt;
    const inGraceWindow = payment.graceExpiresAt ? now <= payment.graceExpiresAt : false;
    if (!inQuoteWindow && !inGraceWindow) return; // arrived late: left for manual reconciliation

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
    if (!dep || dep.confirmed) return;

    const [payment] = await tx
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.id, dep.paymentId))
      .for("update");
    if (!payment) return;

    await tx
      .update(schema.deposits)
      .set({ confirmed: true })
      .where(eq(schema.deposits.id, dep.id));

    const confirmedRaw = payment.confirmedRaw + dep.amountRaw;
    const pendingRaw = payment.pendingRaw - dep.amountRaw;
    const threshold = requiredWithTolerance(payment.amountCryptoRaw);
    const now = new Date();

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
    } else {
      // Confirmed but incomplete -> partial payment, grace keeps running.
      const wasPartial = payment.status === "partially_paid";
      await tx
        .update(schema.payments)
        .set({ status: "partially_paid", confirmedRaw, pendingRaw, updatedAt: now })
        .where(eq(schema.payments.id, payment.id));
      if (!wasPartial) {
        await enqueueWebhook(tx, { ...payment, confirmedRaw }, "payment.partially_paid");
      }
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
  }
  for (const p of underpaid) {
    await db.transaction((tx) => enqueueWebhook(tx, p, "payment.underpaid_expired"));
  }
}
