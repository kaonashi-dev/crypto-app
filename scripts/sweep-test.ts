/**
 * Verification for the sweeper — §12 of docs/design/SWEEPING-PLAN.md.
 *
 * Covers the four things that would be expensive to learn from a chain:
 *
 *   - the policy thresholds (§7), driven with fixed numbers and no rate service;
 *   - the exactly-once path (§6.3), including a simulated crash between
 *     persisting the authorization nonce and broadcasting;
 *   - the unique-index guard against two ticks planning the same pairing;
 *   - S5 — that settlement figures are identical whether or not a sweep ran.
 *
 * Follows the repo's script convention: `./quiet` first, a real Postgres, no
 * external calls. The signer is a mock, so nothing here signs with a real key
 * and nothing touches a chain.
 *
 *   bun run scripts/sweep-test.ts
 */
import "./quiet"; // must precede every ../src import
import { randomBytes } from "crypto";
import { and, eq } from "drizzle-orm";
import { db, schema, sql } from "../src/db";
import { copToRaw } from "../src/services/rates";
import { deriveAddress, reserveDerivationIndex } from "../src/services/wallet";
import { registerDeposit, confirmDeposit } from "../src/services/payments";
import {
  candidates,
  decide,
  record,
  treasuryFor,
  type Candidate,
  type Economics,
} from "../src/services/sweeper";
import { LocalSigner, setSigner, type KeyRef, type Signer } from "../src/services/signer";
import { nativeSweepAmount } from "../src/services/evm-sweep";
import { env, type NetworkId } from "../src/config";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ok  - ${msg}`);
  else {
    failures++;
    console.error(`  FAIL- ${msg}`);
  }
}

const NET: NetworkId = "eth-sepolia";
const TREASURY = "0x000000000000000000000000000000000000dEaD";

async function makeClient() {
  const [c] = await db
    .insert(schema.clients)
    .values({
      name: "Sweep Test Merchant",
      apiKeyHash: randomBytes(16).toString("hex"),
      webhookSecret: "whsec_" + randomBytes(8).toString("hex"),
    })
    .returning();
  return c!;
}

/** A payment with a frozen rate, so nothing calls CoinGecko. */
async function makePayment(
  clientId: string,
  amountCop: bigint,
  asset = "USDC",
  decimals = 6,
  network: NetworkId = NET
) {
  const rate = 4_000_000_000n;
  const idx = await reserveDerivationIndex();
  const address = deriveAddress(idx, network);
  const [p] = await db
    .insert(schema.payments)
    .values({
      publicId: "sweep_" + randomBytes(6).toString("hex"),
      clientId,
      amountCop,
      asset,
      network,
      amountCryptoRaw: copToRaw(amountCop, rate, decimals),
      rateCopPerUnitE6: rate,
      address,
      derivationIndex: idx,
      quoteExpiresAt: new Date(Date.now() + 15 * 60_000),
    })
    .returning();
  return p!;
}

async function depositAndConfirm(
  payment: typeof schema.payments.$inferSelect,
  amountRaw: bigint,
  asset = "USDC",
  logIndex = 0
) {
  const txHash = "0x" + randomBytes(32).toString("hex");
  await registerDeposit({
    network: payment.network as NetworkId,
    address: payment.address,
    txHash,
    logIndex,
    from: "0xpayer",
    asset,
    amountRaw,
    blockNumber: 1_000n,
  });
  const [dep] = await db
    .select()
    .from(schema.deposits)
    .where(and(eq(schema.deposits.paymentId, payment.id), eq(schema.deposits.txHash, txHash)));
  await confirmDeposit(dep!.id);
  return dep!;
}

/** Every figure S5 says a sweep may not move. */
async function settlementSnapshot(paymentId: string, clientId: string) {
  const [p] = await db.select().from(schema.payments).where(eq(schema.payments.id, paymentId));
  const [c] = await db.select().from(schema.clients).where(eq(schema.clients.id, clientId));
  const ledger = await db
    .select()
    .from(schema.ledgerEntries)
    .where(eq(schema.ledgerEntries.clientId, clientId));
  return JSON.stringify(
    {
      status: p!.status,
      confirmedRaw: p!.confirmedRaw,
      pendingRaw: p!.pendingRaw,
      overpaidRaw: p!.overpaidRaw,
      amountCryptoRaw: p!.amountCryptoRaw,
      paidAt: p!.paidAt,
      balanceCop: c!.balanceCop,
      ledger: ledger.length,
    },
    (_k, v) => (typeof v === "bigint" ? v.toString() : v)
  );
}

/** Baseline economics: everything permissive, so each test moves one dial. */
function economics(over: Partial<Economics> = {}): Economics {
  return {
    minRaw: 5_000_000n, // 5 USDC
    // A realistic sweep: 120k gas at 1 gwei. ~1,440 COP against 400,000 COP of
    // value, comfortably inside the 2% ceiling.
    feeRaw: 120_000_000_000_000n,
    assetRateE6: 4_000_000_000n, // 4,000 COP per USDC
    feeRateE6: 12_000_000_000_000n, // 12,000,000 COP per ETH
    feeDecimals: 18,
    gasPriceGwei: 10,
    gasCeilingGwei: 50,
    treasury: TREASURY,
    ...over,
  };
}

function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    network: NET,
    address: "0x" + randomBytes(20).toString("hex"),
    derivationIndex: 0,
    asset: "USDC",
    decimals: 6,
    amountRaw: 100_000_000n, // 100 USDC
    via: "eip3009",
    ...over,
  };
}

/**
 * A signer that records what it was asked to sign and returns a deterministic
 * value, so "the same stored nonce produces the same authorization" is checkable
 * without a key or a chain.
 */
class MockSigner implements Signer {
  calls: string[] = [];
  async addressFor(ref: KeyRef) {
    return ref.role === "relayer" ? "0xrelayer" : `0xdeposit${ref.index}`;
  }
  async signTypedData(_ref: KeyRef, payload: Record<string, unknown>) {
    const message = JSON.stringify(payload, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    this.calls.push(message);
    return `0x${Buffer.from(message).toString("hex").slice(0, 130)}` as `0x${string}`;
  }
  async signTransaction() {
    return "0x00" as `0x${string}`;
  }
  async signDigest() {
    return "0x00" as `0x${string}`;
  }
  async fingerprint() {
    return "mock";
  }
}

async function main() {
  // --- policy ------------------------------------------------------
  console.log("\n[policy] thresholds");
  assert(decide(candidate(), economics()).sweep, "a well-funded candidate is swept");

  const below = decide(candidate({ amountRaw: 1_000_000n }), economics());
  assert(!below.sweep && below.reason === "below_floor", "under SWEEP_MIN_USD -> below_floor");

  // 100 USDC = 400,000 COP; 2% of that is 8,000 COP. A gas spike costing
  // 0.001 ETH at 12,000,000 COP/ETH is 12,000 COP — over the ceiling.
  const spike = { feeRaw: 1_000_000_000_000_000n };
  const pricey = decide(candidate(), economics(spike));
  assert(!pricey.sweep && pricey.reason === "fee_too_high", "fee above SWEEP_MAX_COST_BPS -> fee_too_high");

  // The very same fee against 10x the value is comfortably inside 2% — which is
  // why a deferral is never a failure: the address keeps accumulating.
  assert(decide(candidate({ amountRaw: 1_000_000_000n }), economics(spike)).sweep,
    "the same fee is acceptable once enough value has accumulated");

  const spiking = decide(candidate(), economics({ gasPriceGwei: 500 }));
  assert(!spiking.sweep && spiking.reason === "gas_ceiling", "gas above the ceiling -> gas_ceiling");

  const homeless = decide(candidate(), economics({ treasury: null }));
  assert(!homeless.sweep && homeless.reason === "no_treasury", "no treasury -> no_treasury");

  const blind = decide(candidate(), economics({ assetRateE6: 0n }));
  assert(!blind.sweep && blind.reason === "unpriceable", "an unpriceable asset -> unpriceable, never swept blind");

  const later = decide(candidate({ via: "delegate" }), economics());
  assert(!later.sweep && later.reason === "unimplemented",
    "a mechanism this build cannot execute -> unimplemented, not a dead planned row");

  console.log("\n[policy] deferral is not failure");
  // A negligible fee, so this isolates the floor: at exactly SWEEP_MIN_USD the
  // realistic fee test would reject the sweep for its own, separate reason.
  const cheap = economics({ feeRaw: 1n });
  assert(
    decide(candidate({ amountRaw: 4_999_999n }), cheap).sweep === false &&
      decide(candidate({ amountRaw: 5_000_000n }), cheap).sweep === true,
    "the floor is inclusive: value accumulating across it becomes eligible"
  );

  // --- native headroom ---------------------------------------------
  console.log("\n[native] balance − fee − headroom");
  const fee = 21_000n * 1_000_000_000n; // 21k gas at 1 gwei
  const headroomed = (fee * (10_000n + env.sweepNativeHeadroomBps)) / 10_000n;
  assert(
    nativeSweepAmount(1_000_000_000_000_000_000n, fee) === 1_000_000_000_000_000_000n - headroomed,
    "a native sweep leaves fee plus headroom behind"
  );
  assert(nativeSweepAmount(fee, fee) === 0n, "a balance that cannot cover its own fee sweeps nothing");
  assert(nativeSweepAmount(0n, fee) === 0n, "an empty address sweeps nothing rather than going negative");

  // --- candidate selection -----------------------------------------
  console.log("\n[candidates] confirmed, unswept value");
  const client = await makeClient();
  const p1 = await makePayment(client.id, 400_000n); // 100 USDC
  await depositAndConfirm(p1, 100_000_000n);

  const found = await candidates(NET);
  const mine = found.find((c) => c.address === p1.address);
  assert(mine !== undefined, "a confirmed deposit becomes a sweep candidate");
  assert(mine?.amountRaw === 100_000_000n, "the candidate carries the confirmed amount");
  assert(mine?.via === "eip3009", "the mechanism comes from the registry, not from the sweeper");
  assert(mine?.derivationIndex === p1.derivationIndex, "the candidate carries the derivation index");

  console.log("\n[candidates] unconfirmed value is never swept");
  const p2 = await makePayment(client.id, 400_000n);
  await registerDeposit({
    network: NET, address: p2.address, txHash: "0x" + randomBytes(32).toString("hex"),
    logIndex: 0, from: "0xpayer", asset: "USDC", amountRaw: 100_000_000n, blockNumber: 1_000n,
  });
  const afterPending = await candidates(NET);
  assert(
    afterPending.find((c) => c.address === p2.address) === undefined,
    "a registered but unconfirmed deposit is not a candidate"
  );

  // The case the plan cares most about. A payer who picks the chain's own coin
  // instead of the quoted token sends real value to a real address of ours; it
  // is recorded, refused for settlement, and therefore contributes *nothing* to
  // payments.confirmed_raw. Summing `deposits` rather than that column is the
  // one thing that keeps it recoverable.
  console.log("\n[candidates] value the payment could not credit");
  const BSC: NetworkId = "bsc-testnet";
  const p3 = await makePayment(client.id, 400_000n, "USDC", 18, BSC);
  await depositAndConfirm(p3, 3_000_000_000_000_000_000n, "BNB", -1);
  const p3row = (await db.select().from(schema.payments).where(eq(schema.payments.id, p3.id)))[0]!;
  assert(p3row.confirmedRaw === 0n, "a wrong-asset deposit credits nothing to the payment");

  const wrongAsset = (await candidates(BSC)).find(
    (c) => c.address === p3.address && c.asset === "BNB"
  );
  assert(
    wrongAsset !== undefined,
    "…and is still a sweep candidate — summing deposits, not payments.confirmed_raw, is what recovers it"
  );
  assert(wrongAsset?.amountRaw === 3_000_000_000_000_000_000n, "…for the full amount that arrived");
  assert(wrongAsset?.via === "native", "…via the mechanism the arriving asset declares");

  // The registry gate, from the other side: value in an asset the pairing does
  // not define at all can never be planned. That is not an oversight — it is
  // §2.2's boundary, and reconciliation is what surfaces such funds instead.
  console.log("\n[candidates] the registry gate");
  const p3b = await makePayment(client.id, 400_000n, "USDC", 18, BSC);
  await depositAndConfirm(p3b, 5_000_000_000_000_000_000n, "USDT", 1);
  assert(
    (await candidates(BSC)).find((c) => c.address === p3b.address && c.asset === "USDT") ===
      undefined,
    "an asset with no `sweep` in the registry is never planned, however much of it arrived"
  );

  // --- exactly-once -------------------------------------------------
  console.log("\n[exactly-once] one live sweep per (network, address, asset)");
  const treasury = treasuryFor(NET) ?? TREASURY;
  const first = await record({ sweep: true, candidate: mine! }, treasury);
  assert(first !== undefined, "the first plan writes a row");

  const second = await record({ sweep: true, candidate: mine! }, treasury);
  assert(second === undefined, "a concurrent second plan for the same pairing writes nothing");

  const live = await db
    .select()
    .from(schema.sweeps)
    .where(and(eq(schema.sweeps.address, mine!.address), eq(schema.sweeps.asset, "USDC")));
  assert(live.length === 1, "exactly one sweep row exists for the pairing");
  assert(live[0]!.status === "planned", "it starts as planned");
  assert(live[0]!.toAddress === treasury, "the treasury is snapshotted at plan time");

  console.log("\n[exactly-once] a planned pairing is no longer a candidate");
  const afterPlan = await candidates(NET);
  assert(
    afterPlan.find((c) => c.address === mine!.address && c.asset === "USDC") === undefined,
    "a live sweep row removes the value from the candidate pool — no double-planning"
  );

  console.log("\n[exactly-once] crash between persisting the nonce and broadcasting");
  const mock = new MockSigner();
  setSigner(mock);

  // The nonce is persisted BEFORE anything is signed, which is the whole
  // guarantee: recovery re-signs the stored value and reproduces a
  // byte-identical authorization.
  const nonce = `0x${randomBytes(32).toString("hex")}`;
  const validBefore = new Date(Date.now() + env.sweepAuthTtlSec * 1000);
  await db
    .update(schema.sweeps)
    .set({ status: "authorized", authorizationNonce: nonce, validBefore })
    .where(eq(schema.sweeps.id, first!.id));

  const payload = (row: typeof schema.sweeps.$inferSelect) => ({
    domain: { name: "USDC", version: "2", chainId: 11155111, verifyingContract: "0xtoken" },
    types: {},
    primaryType: "TransferWithAuthorization",
    message: {
      from: row.address,
      to: row.toAddress,
      value: row.amountRaw,
      validAfter: 0n,
      validBefore: BigInt(Math.floor(row.validBefore!.getTime() / 1000)),
      nonce: row.authorizationNonce,
    },
  });

  const beforeCrash = (await db.select().from(schema.sweeps).where(eq(schema.sweeps.id, first!.id)))[0]!;
  const sigA = await mock.signTypedData({ role: "deposit", family: "evm", index: 0 }, payload(beforeCrash) as never);

  // …process dies here, having broadcast or not — we cannot know. It restarts
  // and reads the row back from the database.
  const afterCrash = (await db.select().from(schema.sweeps).where(eq(schema.sweeps.id, first!.id)))[0]!;
  const sigB = await mock.signTypedData({ role: "deposit", family: "evm", index: 0 }, payload(afterCrash) as never);

  assert(afterCrash.authorizationNonce === nonce, "the authorization nonce survived the crash");
  assert(sigA === sigB, "re-signing the stored nonce reproduces a byte-identical authorization");
  assert(
    mock.calls[0] === mock.calls[1],
    "…because every field of the signed message is read back from the row, not regenerated"
  );

  console.log("\n[exactly-once] a confirmed sweep stays out of the candidate pool");
  await db
    .update(schema.sweeps)
    .set({ status: "confirmed", txHash: "0x" + randomBytes(32).toString("hex") })
    .where(eq(schema.sweeps.id, first!.id));
  const afterConfirm = await candidates(NET);
  assert(
    afterConfirm.find((c) => c.address === mine!.address && c.asset === "USDC") === undefined,
    "confirmed sweeps are subtracted from the confirmed deposits at the address"
  );

  console.log("\n[exactly-once] the same address is sweepable again after receiving again");
  await depositAndConfirm(p1, 20_000_000n);
  const reused = (await candidates(NET)).find(
    (c) => c.address === p1.address && c.asset === "USDC"
  );
  assert(reused !== undefined, "a new deposit at a swept address is a new candidate");
  assert(
    reused?.amountRaw === 20_000_000n,
    "…for the new amount only — the partial index lets history accumulate without blocking"
  );

  // --- S5: settlement is unchanged ---------------------------------
  // The criterion the whole plan rests on, checked the way it is stated:
  // settlement figures must be bit-identical whether or not the sweeper ran. A
  // dedicated payment is settled first, snapshotted, then swept end to end —
  // and every figure re-read afterwards.
  console.log("\n[S5] settlement figures are untouched by sweeping");
  const s5client = await makeClient();
  const p4 = await makePayment(s5client.id, 400_000n);
  await depositAndConfirm(p4, 100_000_000n);

  const before = await settlementSnapshot(p4.id, s5client.id);
  assert(
    JSON.parse(before).status === "paid" && JSON.parse(before).balanceCop === "400000",
    "the payment settled and credited before any sweep existed"
  );

  const s5candidate = (await candidates(NET)).find((c) => c.address === p4.address)!;
  const planned = await record({ sweep: true, candidate: s5candidate }, treasury);
  await db
    .update(schema.sweeps)
    .set({
      status: "confirmed",
      txHash: "0x" + randomBytes(32).toString("hex"),
      blockNumber: 2_000n,
      feeRaw: 900_000_000_000_000n,
    })
    .where(eq(schema.sweeps.id, planned!.id));

  const after = await settlementSnapshot(p4.id, s5client.id);
  assert(before === after, "every settlement figure is bit-identical after a confirmed sweep");

  const ledger = await db
    .select()
    .from(schema.ledgerEntries)
    .where(eq(schema.ledgerEntries.clientId, s5client.id));
  assert(
    ledger.length === 1 && ledger[0]!.type === "payment_credit",
    "no sweep wrote a ledger entry — the two ledgers are separate by construction"
  );

  console.log("\n[S5] a swept address keeps settling");
  // The property that makes sweeping safe mid-flight: the address is emptied,
  // but nothing about it stops working. A later transfer is still detected and
  // still recorded against the same payment.
  await depositAndConfirm(p4, 10_000_000n);
  const topped = (await db.select().from(schema.payments).where(eq(schema.payments.id, p4.id)))[0]!;
  assert(
    topped.confirmedRaw === 110_000_000n,
    "a deposit arriving after the sweep is still credited to confirmed_raw"
  );

  // --- signer boundary ----------------------------------------------
  console.log("\n[signer] key boundary");
  setSigner(null);
  const local = new LocalSigner();
  const a = await local.addressFor({ role: "deposit", family: "evm", index: 7 });
  const b = await local.addressFor({ role: "relayer", family: "evm" });
  assert(a !== b, "the relayer is a different key from every deposit address");
  assert(
    a === (await local.addressFor({ role: "deposit", family: "evm", index: 7 })),
    "derivation is deterministic"
  );
  assert(
    b === (await local.addressFor({ role: "relayer", family: "evm" })),
    "the relayer key is stable across calls"
  );
  const tron = await local.addressFor({ role: "relayer", family: "tron" });
  assert(tron.startsWith("T"), "the Tron relayer derives a Tron address");
  assert((await local.fingerprint()).length === 8, "the signer reports the tree it derives from");

  // A deposit index equal to the relayer's index must not collide with it —
  // they live in different hardened BIP-44 accounts precisely so the global,
  // ever-incrementing hd_counter can never reach the relayer's key.
  assert(
    (await local.addressFor({ role: "deposit", family: "evm", index: 0 })) !== b,
    "deposit index 0 is not the relayer, despite both being index 0 of their account"
  );

  console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " CHECK(S) FAILED"}`);
  await sql.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await sql.end();
  process.exit(1);
});
