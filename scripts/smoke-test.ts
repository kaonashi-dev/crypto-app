/**
 * End-to-end smoke test of the payment state machine against a real Postgres.
 * Exercises: HD derivation, COP->raw rounding, deposit registration,
 * confirmation/settlement, partial->complete, overpayment, and dust tolerance.
 *
 * Run with a live DATABASE_URL pointing at a migrated DB:
 *   bun run scripts/smoke-test.ts
 *
 * It does NOT touch CoinGecko or any chain — deposits are injected directly
 * via the same service functions the workers call.
 */
import { randomBytes } from "crypto";
import { eq } from "drizzle-orm";
import { db, schema, sql } from "../src/db";
import { copToRaw } from "../src/services/rates";
import { deriveAddress, reserveDerivationIndex } from "../src/services/wallet";
import {
  requiredWithTolerance,
  registerDeposit,
  confirmDeposit,
} from "../src/services/payments";
import type { NetworkId } from "../src/config";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`  ok  - ${msg}`);
  } else {
    failures++;
    console.error(`  FAIL- ${msg}`);
  }
}

async function makeClient() {
  const [c] = await db
    .insert(schema.clients)
    .values({
      name: "Smoke Test Merchant",
      apiKeyHash: randomBytes(16).toString("hex"),
      webhookSecret: "whsec_" + randomBytes(8).toString("hex"),
    })
    .returning();
  return c!;
}

// Insert a payment directly with a fixed rate so we avoid the CoinGecko call.
async function makePayment(clientId: string, amountCop: bigint, network: NetworkId) {
  const rate = 4_000_000_000n; // 4,000 COP per USDC, scaled x1e6
  const decimals = 6;
  const amountCryptoRaw = copToRaw(amountCop, rate, decimals);
  const idx = await reserveDerivationIndex();
  const address = deriveAddress(idx);
  const [p] = await db
    .insert(schema.payments)
    .values({
      publicId: "test_" + randomBytes(6).toString("hex"),
      clientId,
      amountCop,
      asset: "USDC",
      network,
      amountCryptoRaw,
      rateCopPerUnitE6: rate,
      address,
      derivationIndex: idx,
      quoteExpiresAt: new Date(Date.now() + 15 * 60_000),
    })
    .returning();
  return p!;
}

async function reload(id: string) {
  const [p] = await db.select().from(schema.payments).where(eq(schema.payments.id, id));
  return p!;
}
async function clientBalance(id: string) {
  const [c] = await db.select().from(schema.clients).where(eq(schema.clients.id, id));
  return c!.balanceCop;
}
async function depositRowFor(paymentId: string, txHash: string) {
  const rows = await db.select().from(schema.deposits).where(eq(schema.deposits.paymentId, paymentId));
  return rows.find((r) => r.txHash === txHash)!;
}

async function main() {
  const net: NetworkId = "base-sepolia";

  // --- pure conversion checks --------------------------------------
  console.log("\n[copToRaw] rounding");
  // 40,000 COP at 4,000 COP/USDC -> 10 USDC = 10_000000 raw
  assert(copToRaw(40_000n, 4_000_000_000n, 6) === 10_000000n, "40k COP -> 10.000000 USDC");
  // ceil rounding: 1 COP at 3 COP/unit -> ceil(1/3 * 1e6) = 333334
  assert(copToRaw(1n, 3_000_000n, 6) === 333_334n, "ceil rounding never under-charges");

  console.log("\n[requiredWithTolerance] dust 0.5%");
  assert(requiredWithTolerance(10_000000n) === 9_950000n, "10 USDC threshold = 9.95 USDC");

  // --- full payment in one confirmed deposit -----------------------
  console.log("\n[flow] exact full payment");
  const client = await makeClient();
  const p1 = await makePayment(client.id, 40_000n, net); // 10 USDC
  const tx1 = "0x" + randomBytes(32).toString("hex");
  await registerDeposit({
    network: net, address: p1.address, txHash: tx1, logIndex: 0,
    from: "0xpayer", amountRaw: p1.amountCryptoRaw, blockNumber: 100n,
  });
  let p1r = await reload(p1.id);
  assert(p1r.status === "detecting", "after first deposit -> detecting");
  assert(p1r.pendingRaw === p1.amountCryptoRaw, "pendingRaw holds the unconfirmed amount");
  assert(p1r.graceExpiresAt !== null, "grace window opened");

  const balBefore = await clientBalance(client.id);
  await confirmDeposit((await depositRowFor(p1.id, tx1)).id);
  p1r = await reload(p1.id);
  assert(p1r.status === "paid", "after confirmation -> paid");
  assert(p1r.confirmedRaw === p1.amountCryptoRaw, "confirmedRaw = required");
  assert(p1r.pendingRaw === 0n, "pendingRaw drained to 0");
  assert((await clientBalance(client.id)) === balBefore + 40_000n, "merchant credited 40,000 COP");

  console.log("\n[flow] idempotent + no double-credit on re-confirm");
  const balAfterPaid = await clientBalance(client.id);
  // re-registering the same log is a no-op (unique index)
  await registerDeposit({
    network: net, address: p1.address, txHash: tx1, logIndex: 0,
    from: "0xpayer", amountRaw: p1.amountCryptoRaw, blockNumber: 100n,
  });
  await confirmDeposit((await depositRowFor(p1.id, tx1)).id); // already confirmed -> no-op
  assert((await clientBalance(client.id)) === balAfterPaid, "no double credit on replay");

  // --- partial then complete ---------------------------------------
  console.log("\n[flow] partial -> complete");
  const p2 = await makePayment(client.id, 40_000n, net); // 10 USDC
  const balB2 = await clientBalance(client.id);
  const txA = "0x" + randomBytes(32).toString("hex");
  await registerDeposit({
    network: net, address: p2.address, txHash: txA, logIndex: 0,
    from: "0xpayer", amountRaw: 4_000000n, blockNumber: 200n, // 4 USDC
  });
  await confirmDeposit((await depositRowFor(p2.id, txA)).id);
  let p2r = await reload(p2.id);
  assert(p2r.status === "partially_paid", "partial deposit confirmed -> partially_paid");
  assert(p2r.confirmedRaw === 4_000000n, "confirmedRaw = 4 USDC");
  assert((await clientBalance(client.id)) === balB2, "no credit while partial");

  const txB = "0x" + randomBytes(32).toString("hex");
  await registerDeposit({
    network: net, address: p2.address, txHash: txB, logIndex: 0,
    from: "0xpayer", amountRaw: 6_000000n, blockNumber: 210n, // 6 USDC -> total 10
  });
  await confirmDeposit((await depositRowFor(p2.id, txB)).id);
  p2r = await reload(p2.id);
  assert(p2r.status === "paid", "completing deposit -> paid");
  assert(p2r.confirmedRaw === 10_000000n, "confirmedRaw = 10 USDC total");
  assert((await clientBalance(client.id)) === balB2 + 40_000n, "credited full 40,000 COP once");

  // --- overpayment --------------------------------------------------
  console.log("\n[flow] overpayment");
  const p3 = await makePayment(client.id, 40_000n, net); // 10 USDC required
  const balB3 = await clientBalance(client.id);
  const txO = "0x" + randomBytes(32).toString("hex");
  await registerDeposit({
    network: net, address: p3.address, txHash: txO, logIndex: 0,
    from: "0xpayer", amountRaw: 12_000000n, blockNumber: 300n, // 12 USDC
  });
  await confirmDeposit((await depositRowFor(p3.id, txO)).id);
  const p3r = await reload(p3.id);
  assert(p3r.status === "paid", "overpayment -> paid");
  assert(p3r.overpaidRaw === 2_000000n, "overpaidRaw = 2 USDC");
  assert((await clientBalance(client.id)) === balB3 + 40_000n, "credited original 40,000 COP (not more)");

  // --- dust tolerance (99.5%) --------------------------------------
  console.log("\n[flow] dust tolerance");
  const p4 = await makePayment(client.id, 40_000n, net); // 10 USDC, threshold 9.95
  const balB4 = await clientBalance(client.id);
  const txD = "0x" + randomBytes(32).toString("hex");
  await registerDeposit({
    network: net, address: p4.address, txHash: txD, logIndex: 0,
    from: "0xpayer", amountRaw: 9_960000n, blockNumber: 400n, // 9.96 USDC >= 9.95
  });
  await confirmDeposit((await depositRowFor(p4.id, txD)).id);
  const p4r = await reload(p4.id);
  assert(p4r.status === "paid", "99.6% within dust tolerance -> paid");
  assert((await clientBalance(client.id)) === balB4 + 40_000n, "credited despite tiny shortfall");

  // --- webhook jobs enqueued ---------------------------------------
  console.log("\n[webhooks] jobs enqueued");
  const jobs = await db.select().from(schema.webhookJobs).where(eq(schema.webhookJobs.clientId, client.id));
  const events = jobs.map((j) => j.event).sort();
  assert(events.filter((e) => e === "payment.paid").length === 4, "4 payment.paid jobs enqueued");
  assert(events.includes("payment.partially_paid"), "partially_paid job enqueued");

  console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " CHECK(S) FAILED"}`);
  await sql.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await sql.end();
  process.exit(1);
});
