/**
 * The sweeper — §8 of docs/SWEEPING-PLAN.md.
 *
 * One loop per network, registered in supervisor.ts beside watcher/confirmer so
 * it inherits the RPC probe gate and does not start until the network answers.
 * Each tick does two things:
 *
 *   1. **plan** — select confirmed, unswept value; decide; record `planned` or
 *      `skipped` rows with reasons.
 *   2. **execute** — advance live rows through authorize → broadcast → confirm.
 *      Skipped entirely under `SWEEP_DRY_RUN`, which is what makes Phase 1
 *      shippable without a signature ever being produced.
 *
 * Same discipline as confirmer.ts: the database (free, local) is asked before
 * the RPC (metered), so a tick with nothing to do costs nothing.
 *
 * The order of operations in `authorize` is the exactly-once guarantee (§6.3)
 * and is load-bearing — read the comment there before changing it.
 */
import { eq, sql } from "drizzle-orm";
import { randomBytes } from "crypto";
import type { Hex } from "viem";
import { db, schema } from "../db";
import { NETWORKS, assetFor, env, gasCoinFor, tokenFor, type NetworkId } from "../config";
import {
  candidates,
  decide,
  dueSweeps,
  economicsFor,
  record,
  treasuryFor,
} from "../services/sweeper";
import {
  EIP3009_GAS,
  NATIVE_GAS,
  authorizationCalldata,
  authorizationUsed,
  feeBasis,
  gasFor,
  nativeBalance,
  nativeSweepAmount,
  relayerState,
  sendFrom,
  signAuthorization,
  sweepReceipt,
  tokenBalance,
} from "../services/evm-sweep";
import { clearRpcError, logRpcError } from "./rpc-log";
import { getLogger, withContext, count, gauge } from "../observability";

type SweepRow = typeof schema.sweeps.$inferSelect;

/** Retry backoff, matching the webhook queue's shape: 1m, 2m, 4m … capped. */
const backoff = (attempts: number) =>
  new Date(Date.now() + Math.min(2 ** attempts, 60) * 60_000);

export function startSweeper(network: NetworkId) {
  const net = NETWORKS[network];
  const log = getLogger(`sweeper:${network}`, { "chain.network": network });

  if (!env.sweepEnabled) return;
  if (net.family !== "evm") {
    // Tron's mechanism is delegated energy, not an authorization, and it is
    // Phase 3. Its pairings are still *planned* by the shared policy — they just
    // resolve to `skipped: unimplemented` until that lands, which is visible in
    // the console rather than silent.
    log.info("sweeper not started — this family has no execution path yet", {
      "chain.family": net.family,
    });
    return;
  }

  log.info("sweeper started", {
    "worker.interval_s": env.sweepIntervalSec,
    "sweep.dry_run": env.sweepDryRun,
    "sweep.min_usd": env.sweepMinUsd,
    "sweep.max_cost_bps": Number(env.sweepMaxCostBps),
    "chain.confirmations_required": net.confirmations,
  });

  // -- Planning --------------------------------------------------------

  async function plan(): Promise<number> {
    const found = await candidates(network);
    gauge("sweeps.eligible", found.length, { network });
    if (found.length === 0) {
      log.trace("nothing eligible");
      return 0;
    }

    // One gas price for the whole tick — see `feeBasis`.
    const fees = await feeBasis(network);
    clearRpcError(`sweeper:${network}`);
    gauge("sweeps.gas_price_gwei", fees.gasPriceGwei, { network });

    let planned = 0;
    for (const candidate of found) {
      const feeRaw = gasFor(candidate.via) * fees.maxFeePerGas;
      const economics = await economicsFor(
        network,
        candidate.asset,
        candidate.decimals,
        feeRaw,
        fees.gasPriceGwei
      );
      const decision = decide(candidate, economics);
      const treasury = economics.treasury ?? "";

      // A candidate with nowhere to go is not recorded at all: the row's
      // `to_address` is NOT NULL by design, because a sweep that does not know
      // its destination is not a plan.
      if (!treasury) {
        log.repeat("no-treasury", "warn", "sweep deferred — no treasury address for this family", {
          "chain.family": net.family,
        });
        count("sweeps.skipped", { network, reason: "no_treasury" });
        continue;
      }

      const row = await record(decision, treasury);
      if (decision.sweep) {
        planned++;
        log.info("sweep planned", {
          "sweep.id": row?.id,
          "sweep.address": candidate.address,
          "wallet.derivation_index": candidate.derivationIndex,
          "sweep.asset": candidate.asset,
          "sweep.amount_raw": candidate.amountRaw,
          "sweep.via": candidate.via,
          "sweep.to": treasury,
          "sweep.fee_raw": feeRaw,
          "sweep.dry_run": env.sweepDryRun,
        });
      } else {
        log.debug("sweep deferred", {
          "sweep.address": candidate.address,
          "sweep.asset": candidate.asset,
          "sweep.amount_raw": candidate.amountRaw,
          "sweep.via": candidate.via,
          "sweep.skip_reason": decision.reason,
          "sweep.min_raw": economics.minRaw,
          "sweep.fee_raw": feeRaw,
          "sweep.gas_price_gwei": fees.gasPriceGwei,
        });
      }
    }
    return planned;
  }

  // -- Execution -------------------------------------------------------

  const set = (id: string, patch: Partial<typeof schema.sweeps.$inferInsert>) =>
    db.update(schema.sweeps).set({ ...patch, updatedAt: new Date() }).where(eq(schema.sweeps.id, id));

  async function fail(row: SweepRow, error: unknown, retryable = true) {
    const attempts = row.attempts + 1;
    const dead = !retryable || attempts >= env.sweepMaxAttempts;
    const message = error instanceof Error ? error.message.split("\n")[0]! : String(error);

    await set(row.id, {
      attempts,
      lastError: message,
      status: dead ? "failed" : row.status,
      nextAttemptAt: backoff(attempts),
    });

    count(dead ? "sweeps.failed" : "sweeps.retried", { network, via: row.via });
    log[dead ? "error" : "warn"](
      dead ? "sweep dead-lettered — needs an operator" : "sweep failed — will retry",
      {
        "sweep.id": row.id,
        "sweep.address": row.address,
        "sweep.asset": row.asset,
        "sweep.via": row.via,
        "sweep.amount_raw": row.amountRaw,
        "sweep.attempts": attempts,
        "sweep.max_attempts": env.sweepMaxAttempts,
        "error.message": message,
      }
    );
  }

  /**
   * `planned` → `authorized`.
   *
   * The ordering here is the exactly-once guarantee, and it only works one way
   * round: the authorization nonce is generated and **committed before anything
   * is signed**. A crash at any point after this commit recovers by re-signing
   * the *stored* nonce, which reproduces a byte-identical authorization — so if
   * the first broadcast landed, the token contract rejects the replay, and if it
   * did not, the rebroadcast succeeds. Generating the nonce at signing time
   * would produce a different authorization on every attempt and lose the
   * guarantee entirely.
   *
   * The native path has no authorization; there the deposit address's own
   * account nonce plays exactly the same role and is persisted the same way.
   */
  async function authorize(row: SweepRow) {
    if (row.via === "native") {
      const balance = await nativeBalance(network, row.address as Hex);
      const fees = await feeBasis(network);
      const amount = nativeSweepAmount(balance, NATIVE_GAS * fees.maxFeePerGas);
      if (amount <= 0n) {
        await set(row.id, { status: "skipped", reason: "fee_too_high", amountRaw: 0n });
        count("sweeps.skipped", { network, reason: "fee_too_high" });
        return;
      }
      await set(row.id, { status: "authorized", amountRaw: amount });
      log.info("native sweep authorized", {
        "sweep.id": row.id,
        "sweep.address": row.address,
        "sweep.balance_raw": balance,
        "sweep.amount_raw": amount,
      });
      return;
    }

    const nonce = `0x${randomBytes(32).toString("hex")}` as Hex;
    const validBefore = new Date(Date.now() + env.sweepAuthTtlSec * 1000);
    await set(row.id, { status: "authorized", authorizationNonce: nonce, validBefore });

    log.info("sweep authorized", {
      "sweep.id": row.id,
      "sweep.address": row.address,
      "sweep.asset": row.asset,
      "sweep.amount_raw": row.amountRaw,
      "sweep.authorization_nonce": nonce,
      "sweep.valid_before": validBefore,
    });
  }

  /** `authorized` → `broadcast`. */
  async function broadcast(row: SweepRow) {
    const token = tokenFor(network, row.asset);

    if (row.via === "native") {
      const sent = await sendFrom(
        network,
        { role: "deposit", family: "evm", index: row.derivationIndex },
        {
          to: row.toAddress as Hex,
          value: row.amountRaw,
          gas: NATIVE_GAS,
          nonce: row.accountNonce ?? undefined,
        }
      );
      await set(row.id, {
        status: "broadcast",
        txHash: sent.txHash,
        accountNonce: sent.accountNonce,
      });
      count("sweeps.broadcast", { network, via: row.via });
      log.info("native sweep broadcast", {
        "sweep.id": row.id,
        "chain.tx_hash": sent.txHash,
        "sweep.amount_raw": row.amountRaw,
        "sweep.account_nonce": sent.accountNonce,
      });
      return;
    }

    if (!token || !row.authorizationNonce) {
      await fail(row, new Error("authorized row is missing its token or nonce"), false);
      return;
    }

    // The exactly-once oracle. After a crash between broadcast and the ledger
    // write we may not have the transaction hash, but the token itself records
    // whether the authorization was consumed — so this answers "did the previous
    // attempt land?" without one, and turns a rebroadcast into a no-op instead
    // of a second transfer.
    const used = await authorizationUsed(
      network,
      token.address as Hex,
      row.address as Hex,
      row.authorizationNonce as Hex
    );
    if (used) {
      await set(row.id, { status: "confirmed", reason: "authorization_already_used" });
      count("sweeps.confirmed", { network, via: row.via });
      log.warn("sweep already settled on-chain — reconciled without rebroadcasting", {
        "sweep.id": row.id,
        "sweep.address": row.address,
        "sweep.authorization_nonce": row.authorizationNonce,
        "sweep.amount_raw": row.amountRaw,
        hint: "a previous attempt broadcast successfully before its result was recorded",
      });
      return;
    }

    const auth = await signAuthorization({
      network,
      asset: row.asset,
      token: token.address as Hex,
      derivationIndex: row.derivationIndex,
      from: row.address as Hex,
      to: row.toAddress as Hex,
      value: row.amountRaw,
      nonce: row.authorizationNonce as Hex,
      validBefore: row.validBefore ?? new Date(Date.now() + env.sweepAuthTtlSec * 1000),
    });
    if (!auth) {
      // The domain failed to verify; evm-sweep.ts has already logged at error and
      // disabled the pairing. Do not retry into it.
      await fail(row, new Error("EIP-712 domain unverified for this pairing"), false);
      return;
    }

    const sent = await sendFrom(
      network,
      { role: "relayer", family: "evm" },
      {
        to: token.address as Hex,
        data: authorizationCalldata(auth),
        gas: EIP3009_GAS,
        nonce: row.accountNonce ?? undefined,
      }
    );

    await set(row.id, {
      status: "broadcast",
      txHash: sent.txHash,
      accountNonce: sent.accountNonce,
    });
    count("sweeps.broadcast", { network, via: row.via });
    log.info("sweep broadcast", {
      "sweep.id": row.id,
      "chain.tx_hash": sent.txHash,
      "sweep.address": row.address,
      "sweep.asset": row.asset,
      "sweep.amount_raw": row.amountRaw,
      "sweep.to": row.toAddress,
      "sweep.account_nonce": sent.accountNonce,
      "sweep.authorization_nonce": row.authorizationNonce,
    });
  }

  /** `broadcast` → `confirmed`, or back to `authorized` for another attempt. */
  async function confirm(row: SweepRow) {
    if (!row.txHash) return fail(row, new Error("broadcast row has no transaction hash"), false);

    const receipt = await sweepReceipt(network, row.txHash as Hex);
    if (receipt.state === "pending" || receipt.state === "maturing") {
      log.debug("sweep maturing", {
        "sweep.id": row.id,
        "chain.tx_hash": row.txHash,
        "sweep.receipt_state": receipt.state,
        "chain.confirmations_required": net.confirmations,
      });
      return;
    }

    if (receipt.state === "reverted") {
      // A revert on the 3009 path is usually the authorization having been
      // consumed by an earlier attempt, which is success, not failure.
      const token = tokenFor(network, row.asset);
      if (token && row.authorizationNonce) {
        const used = await authorizationUsed(
          network,
          token.address as Hex,
          row.address as Hex,
          row.authorizationNonce as Hex
        );
        if (used) {
          await set(row.id, {
            status: "confirmed",
            reason: "authorization_already_used",
            feeRaw: receipt.feeRaw,
            blockNumber: receipt.blockNumber,
          });
          count("sweeps.confirmed", { network, via: row.via });
          log.warn("sweep reverted but the authorization was already consumed — funds moved once", {
            "sweep.id": row.id,
            "chain.tx_hash": row.txHash,
            "sweep.authorization_nonce": row.authorizationNonce,
          });
          return;
        }
      }
      // Genuinely failed. Retry from `authorized` with the same authorization
      // nonce — a fresh account nonce is correct here, because the previous
      // transaction is mined and cannot be replaced.
      await set(row.id, { status: "authorized", txHash: null, accountNonce: null });
      await fail(row, new Error("sweep transaction reverted"));
      return;
    }

    await set(row.id, {
      status: "confirmed",
      blockNumber: receipt.blockNumber,
      feeRaw: receipt.feeRaw,
    });
    count("sweeps.confirmed", { network, via: row.via });
    count("sweeps.fee_raw", { network }, Number(receipt.feeRaw));
    log.info("sweep confirmed", {
      "sweep.id": row.id,
      "chain.tx_hash": row.txHash,
      "chain.block_number": receipt.blockNumber,
      "sweep.address": row.address,
      "sweep.asset": row.asset,
      "sweep.amount_raw": row.amountRaw,
      "sweep.to": row.toAddress,
      "sweep.fee_raw": receipt.feeRaw,
      "sweep.fee_asset": gasCoinFor(network).symbol,
      "sweep.attempts": row.attempts,
    });
  }

  async function execute(): Promise<void> {
    const due = await dueSweeps(network);
    gauge("sweeps.live", due.length, { network });
    if (due.length === 0) return;

    // An empty relayer is the likeliest reason sweeps plan and never move, and
    // it cannot be seen from the ledger — so it is reported before the attempts
    // that would each fail the same way.
    const relayer = await relayerState(network).catch(() => null);
    if (relayer) {
      gauge("sweeps.relayer_balance_raw", Number(relayer.balance), { network });
      if (relayer.balance === 0n && due.some((r) => r.via !== "native")) {
        log.repeat("relayer-empty", "error", "relayer holds no gas — sweeps cannot be broadcast", {
          "sweep.relayer": relayer.address,
          "sweep.fee_asset": relayer.symbol,
          hint: "fund the relayer address above on this network",
        });
      }
    }

    for (const row of due) {
      try {
        if (row.status === "planned") await authorize(row);
        else if (row.status === "authorized") await broadcast(row);
        else if (row.status === "broadcast") await confirm(row);
      } catch (e) {
        await fail(row, e);
      }
    }
  }

  // -- Tick ------------------------------------------------------------

  setInterval(async () => {
    await withContext(
      { attributes: { "chain.network": network, "worker.name": "sweeper" } },
      async () => {
        const tick = log.time("sweeper tick");
        try {
          const planned = await plan();
          if (env.sweepDryRun) {
            tick({ "sweeps.planned": planned, "sweep.dry_run": true });
            return;
          }
          await execute();
          tick({ "sweeps.planned": planned });
        } catch (e) {
          logRpcError(`sweeper:${network}`, e);
        }
      }
    );
  }, env.sweepIntervalSec * 1000);
}

/** Totals for the console header — unswept value per (network, asset). */
export async function unsweptTotals() {
  const rows = await db.execute(sql`
    SELECT d.network                          AS network,
           d.asset                            AS asset,
           SUM(d.amount_raw)::numeric(78,0)   AS confirmed_raw,
           COALESCE((
             SELECT SUM(s.amount_raw) FROM ${schema.sweeps} s
              WHERE s.network = d.network AND s.asset = d.asset AND s.status = 'confirmed'
           ), 0)::numeric(78,0)               AS swept_raw
      FROM ${schema.deposits} d
     WHERE d.confirmed = true
     GROUP BY d.network, d.asset
  `);

  return (rows as unknown as Array<{
    network: string;
    asset: string;
    confirmed_raw: string;
    swept_raw: string;
  }>).map((r) => ({
    network: r.network,
    asset: r.asset,
    decimals: assetFor(r.network as NetworkId, r.asset)?.decimals ?? 6,
    confirmed_raw: r.confirmed_raw,
    swept_raw: r.swept_raw,
    unswept_raw: (BigInt(r.confirmed_raw) - BigInt(r.swept_raw)).toString(),
  }));
}

/** Re-exported so the console and scripts do not reach into services/. */
export { treasuryFor, tokenBalance };
