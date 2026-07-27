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
import "./quiet"; // must precede every ../src import
import { randomBytes } from "crypto";
import { eq } from "drizzle-orm";
import { db, schema, sql } from "../src/db";
import { copToRaw } from "../src/services/rates";
import { deriveAddress, deriveTronAddress, reserveDerivationIndex } from "../src/services/wallet";
import {
  base58ToHexAddress,
  findTransferLog,
  hexToBase58Address,
  isTronAddress,
  topicToBase58Address,
} from "../src/services/tron";
import {
  requiredWithTolerance,
  registerDeposit,
  confirmDeposit,
  expireStalePayments,
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
// Pass quoteExpiresAt to backdate the quote and exercise the expiry paths.
async function makePayment(
  clientId: string,
  amountCop: bigint,
  network: NetworkId,
  quoteExpiresAt = new Date(Date.now() + 15 * 60_000)
) {
  const rate = 4_000_000_000n; // 4,000 COP per USDC, scaled x1e6
  const decimals = 6;
  const amountCryptoRaw = copToRaw(amountCop, rate, decimals);
  const idx = await reserveDerivationIndex();
  const address = deriveAddress(idx, network);
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
      quoteExpiresAt,
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

  // --- Tron: address codec, derivation, log decoding ---------------
  // Fixtures below are real Nile chain data (tx 4c9b1ea5…, USDT contract), so a
  // regression in the Base58Check codec or the log decoder surfaces here rather
  // than as a silently uncredited — or wrongly credited — deposit.
  console.log("\n[tron] address codec");
  const USDT_NILE_B58 = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";
  const USDT_NILE_HEX = "41eca9bc828a3005b9a3b909f2cc5c2a54794de05f";
  assert(base58ToHexAddress(USDT_NILE_B58) === USDT_NILE_HEX, "base58 -> 0x41 hex");
  assert(hexToBase58Address(USDT_NILE_HEX) === USDT_NILE_B58, "0x41 hex -> base58");
  assert(isTronAddress(USDT_NILE_B58), "valid Tron address accepted");
  assert(!isTronAddress("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"), "EVM address rejected");
  assert(!isTronAddress("TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBg"), "bad checksum rejected");

  console.log("\n[tron] HD derivation m/44'/195'");
  const tron0 = deriveAddress(0, "tron-nile");
  assert(tron0 === deriveTronAddress(0), "deriveAddress routes tron-nile to coin type 195");
  assert(isTronAddress(tron0), "derived address is a valid Tron address");
  assert(deriveAddress(0, "base-sepolia").startsWith("0x"), "EVM derivation unchanged");
  assert(tron0 !== deriveAddress(0, "base-sepolia"), "tron and evm addresses differ");
  assert(deriveTronAddress(0) !== deriveTronAddress(1), "each index is a distinct address");

  console.log("\n[tron] Transfer log decoding");
  const FROM_TOPIC = "00000000000000000000000065fa68800fff5a10346d1a3aa1fb2ce92f2e2971";
  const TO_TOPIC = "0000000000000000000000006977bb1d2fe1a21572472c6ca48dd83c1872813b";
  const CHAIN_FROM = "TKGRE6oiU3rEzasue4MsB6sCXXSTx9BAe3";
  const CHAIN_TO = "TKasPFWSikdomMj8afg2gkT9mmbqcAaCNu";
  assert(topicToBase58Address(FROM_TOPIC) === CHAIN_FROM, "topic -> sender matches chain");
  assert(topicToBase58Address(TO_TOPIC) === CHAIN_TO, "topic -> recipient matches chain");

  const txInfo = {
    id: "4c9b1ea5e77c8508c8b57e9e51283650ecfa5ec36931b9e67324eb4bdaa80916",
    blockNumber: 69258010,
    receipt: { result: "SUCCESS" },
    log: [
      {
        address: "eca9bc828a3005b9a3b909f2cc5c2a54794de05f", // USDT, no 0x41 prefix
        topics: [
          "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
          FROM_TOPIC,
          TO_TOPIC,
        ],
        data: "000000000000000000000000000000000000000000000000000000174876e800",
      },
    ],
  };
  const contractHex = base58ToHexAddress(USDT_NILE_B58);
  const hit = findTransferLog(txInfo, contractHex, CHAIN_TO);
  assert(hit !== null, "Transfer log located");
  assert(hit?.amountRaw === 100_000_000_000n, "amount decoded from log data");
  assert(hit?.from === CHAIN_FROM, "sender decoded from topic");
  assert(hit?.logIndex === 0, "logIndex is the log's position (idempotency key)");
  assert(
    findTransferLog(txInfo, contractHex, tron0) === null,
    "transfer to another address is not credited"
  );
  assert(
    findTransferLog(txInfo, base58ToHexAddress("TWer2Ygk5TEheHp3TPuYeqxmB6SsGZmaL6"), CHAIN_TO) ===
      null,
    "transfer of another token is not credited"
  );

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

  // --- expiry windows ----------------------------------------------
  // Regression guard: these comparisons used to be raw `sql` templates with a
  // bound Date, which the pg driver rejected — the worker threw every tick and
  // nothing ever expired.
  console.log("\n[flow] expiry");

  // quote lapsed with no funds -> expired
  const p5 = await makePayment(client.id, 40_000n, net, new Date(Date.now() - 60_000));

  // partial funds with the grace window lapsed -> underpaid_expired
  const p6 = await makePayment(client.id, 40_000n, net); // 10 USDC
  const txU = "0x" + randomBytes(32).toString("hex");
  await registerDeposit({
    network: net, address: p6.address, txHash: txU, logIndex: 0,
    from: "0xpayer", amountRaw: 4_000000n, blockNumber: 500n, // 4 of 10 USDC
  });
  await confirmDeposit((await depositRowFor(p6.id, txU)).id);
  assert((await reload(p6.id)).status === "partially_paid", "partial deposit -> partially_paid");
  await db
    .update(schema.payments)
    .set({ graceExpiresAt: new Date(Date.now() - 60_000) })
    .where(eq(schema.payments.id, p6.id));

  const balB5 = await clientBalance(client.id);
  await expireStalePayments(); // must not throw

  assert((await reload(p5.id)).status === "expired", "lapsed quote, no funds -> expired");
  assert(
    (await reload(p6.id)).status === "underpaid_expired",
    "lapsed grace while partial -> underpaid_expired"
  );
  assert((await clientBalance(client.id)) === balB5, "expiry credits no COP");

  // --- webhook jobs enqueued ---------------------------------------
  console.log("\n[webhooks] jobs enqueued");
  const jobs = await db.select().from(schema.webhookJobs).where(eq(schema.webhookJobs.clientId, client.id));
  const events = jobs.map((j) => j.event).sort();
  assert(events.filter((e) => e === "payment.paid").length === 4, "4 payment.paid jobs enqueued");
  assert(events.includes("payment.partially_paid"), "partially_paid job enqueued");
  assert(events.includes("payment.expired"), "expired job enqueued");
  assert(events.includes("payment.underpaid_expired"), "underpaid_expired job enqueued");

  console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " CHECK(S) FAILED"}`);
  await sql.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await sql.end();
  process.exit(1);
});
