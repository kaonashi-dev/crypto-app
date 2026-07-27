import { and, inArray, eq } from "drizzle-orm";
import { db, schema } from "../db";
import { NETWORKS, env, type NetworkId, type TronNetworkDef } from "../config";
import { registerDeposit } from "../services/payments";
import {
  base58ToHexAddress,
  findTransferLog,
  getNativeTransfers,
  getTransactionInfo,
  getTrc20Transfers,
  parseNativeTransfer,
} from "../services/tron";
import { clearRpcError, logRpcError } from "./rpc-log";
import { getLogger, withContext, count, gauge } from "../observability";

const ACTIVE = ["pending", "detecting", "partially_paid"] as const;

type OpenPayment = { address: string; createdAt: Date; asset: string };

/** Open payments on this network, with the moment each started accepting funds. */
async function activePayments(network: NetworkId): Promise<OpenPayment[]> {
  return db
    .select({
      address: schema.payments.address,
      createdAt: schema.payments.createdAt,
      asset: schema.payments.asset,
    })
    .from(schema.payments)
    .where(
      and(
        eq(schema.payments.network, network),
        inArray(schema.payments.status, [...ACTIVE])
      )
    );
}

/**
 * Scans TronGrid for TRC-20 transfers into the given open payments.
 *
 * Tron exposes no WebSocket log subscription, so there is no push equivalent to
 * the EVM watcher — scanning *is* the primary path here, not just a backfill.
 * The transfers listing carries neither block height nor log index, so each
 * candidate is resolved against the transaction's own logs, which also re-reads
 * the amount from the log rather than trusting the listing.
 *
 * Cost note: one TronGrid call per (address, token), plus one per candidate
 * transfer. Keep the caller's set of addresses as small as possible — that, and
 * how often this runs, is the whole cost of Tron detection. Every skip below is
 * logged at debug with its reason, because "the transfer is on the explorer but
 * the gateway ignored it" is the hardest Tron question to answer otherwise.
 */
export async function scanTronPayments(
  network: NetworkId,
  open: OpenPayment[]
): Promise<void> {
  const log = getLogger(`tron-watcher:${network}`, { "chain.network": network });
  if (open.length === 0) {
    log.trace("scan skipped — no open payments");
    return;
  }
  const net = NETWORKS[network] as TronNetworkDef;

  let candidates = 0;
  let registered = 0;
  const started = performance.now();

  for (const [symbol, token] of Object.entries(net.tokens)) {
    const contractHex = base58ToHexAddress(token.address);

    for (const { address, createdAt } of open) {
      const transfers = await getTrc20Transfers(net, address, token.address, createdAt);
      log.debug("transfer listing", {
        "chain.address": address,
        "token.address": token.address,
        "transfer.listed": transfers.length,
        "payment.created_at": createdAt,
      });

      for (const transfer of transfers) {
        // The listing is bidirectional; only credit incoming value.
        if (transfer.type !== "Transfer" || transfer.to !== address) {
          log.trace("transfer skipped — not an incoming Transfer", {
            "chain.tx_hash": transfer.transaction_id,
            "transfer.type": transfer.type,
            "transfer.to": transfer.to,
          });
          continue;
        }
        // Re-check the bound locally: the address may carry unrelated history
        // (HD addresses can be reused, and testnet mnemonics are shared), and
        // funds that predate the payment must never settle it.
        if (transfer.block_timestamp < createdAt.getTime()) {
          log.debug("transfer skipped — predates the payment", {
            "chain.tx_hash": transfer.transaction_id,
            "transfer.block_timestamp": new Date(transfer.block_timestamp),
            "payment.created_at": createdAt,
          });
          continue;
        }

        candidates++;
        const info = await getTransactionInfo(net, transfer.transaction_id);
        if (!info) {
          // not mined yet — picked up on a later scan
          log.debug("transfer skipped — not mined yet", {
            "chain.tx_hash": transfer.transaction_id,
          });
          continue;
        }
        if (info.receipt?.result && info.receipt.result !== "SUCCESS") {
          log.warn("transfer skipped — transaction failed on chain", {
            "chain.tx_hash": transfer.transaction_id,
            "chain.receipt_status": info.receipt.result,
          });
          continue;
        }

        const log_entry = findTransferLog(info, contractHex, address);
        if (!log_entry) {
          log.warn("transfer skipped — no matching Transfer log in the transaction", {
            "chain.tx_hash": transfer.transaction_id,
            "chain.address": address,
            "token.address": token.address,
            "chain.log_count": info.log?.length ?? 0,
          });
          continue;
        }

        registered++;
        count("chain.transfers.seen", { network, source: "trongrid" });
        log.info("transfer seen", {
          "transfer.source": "trongrid",
          "token.symbol": symbol,
          "transfer.to": address,
          "transfer.from": log_entry.from,
          "transfer.amount_raw": log_entry.amountRaw,
          "chain.tx_hash": transfer.transaction_id,
          "chain.log_index": log_entry.logIndex,
          "chain.block_number": info.blockNumber,
        });

        await registerDeposit({
          network,
          address,
          txHash: transfer.transaction_id,
          logIndex: log_entry.logIndex,
          from: log_entry.from,
          asset: symbol,
          amountRaw: log_entry.amountRaw,
          blockNumber: BigInt(info.blockNumber),
        }); // idempotent: duplicates are dropped by the unique index
      }
    }
  }

  // -- Native TRX ------------------------------------------------------
  // Only for payments actually quoted in TRX, unlike the TRC-20 sweep above.
  // Both cost one call per address, but a TRC-20 call covers a token the payer
  // might plausibly have sent by mistake, whereas scanning a USDT payment's
  // address for stray TRX would double this worker's TronGrid usage to record
  // something that can never settle it.
  if (net.native) {
    const nativePayments = open.filter((p) => p.asset === net.native!.symbol);
    for (const { address, createdAt } of nativePayments) {
      const txs = await getNativeTransfers(net, address, createdAt);
      log.debug("native transaction listing", {
        "chain.address": address,
        "transfer.listed": txs.length,
        "payment.created_at": createdAt,
      });

      for (const tx of txs) {
        const transfer = parseNativeTransfer(tx, address);
        if (!transfer) continue; // outgoing, a contract call, failed, or unmined

        // Same bound as the TRC-20 path: an address can carry history older than
        // the payment, and those funds must never settle it.
        if ((tx.block_timestamp ?? 0) < createdAt.getTime()) {
          log.debug("native transfer skipped — predates the payment", {
            "chain.tx_hash": tx.txID,
            "transfer.block_timestamp": new Date(tx.block_timestamp ?? 0),
            "payment.created_at": createdAt,
          });
          continue;
        }

        candidates++;
        registered++;
        count("chain.transfers.seen", { network, source: "trongrid_native" });
        log.info("transfer seen", {
          "transfer.source": "trongrid_native",
          "token.symbol": net.native.symbol,
          "transfer.to": address,
          "transfer.from": transfer.from,
          "transfer.amount_raw": transfer.amountRaw,
          "chain.tx_hash": tx.txID,
          "chain.block_number": transfer.blockNumber,
        });

        await registerDeposit({
          network,
          address,
          txHash: tx.txID,
          // No log to index: a TRX transfer is the transaction itself.
          logIndex: -1,
          from: transfer.from,
          asset: net.native.symbol,
          amountRaw: transfer.amountRaw,
          blockNumber: transfer.blockNumber,
        }); // idempotent: duplicates are dropped by the unique index
      }
    }
  }

  log.debug("scan complete", {
    "chain.scanned_addresses": open.length,
    "transfer.candidates": candidates,
    "transfer.registered": registered,
    duration_ms: Math.round(performance.now() - started),
  });
}

/** Scans a single payment on demand (see the /check endpoint). */
export async function scanTronPayment(
  network: NetworkId,
  payment: OpenPayment
): Promise<void> {
  return scanTronPayments(network, [payment]);
}

/**
 * Background sweep. This is the safety net that catches a payer who paid and
 * closed the tab; the checkout's "check now" button is the fast path, so this
 * can run on a slow cadence (TRON_POLL_INTERVAL_SEC) without hurting UX.
 */
export function startTronWatcher(network: NetworkId) {
  const scope = `tron-watcher:${network}`;
  const log = getLogger(scope, { "chain.network": network });

  async function tick() {
    await withContext(
      { attributes: { "chain.network": network, "worker.name": "tron-watcher" } },
      async () => {
        try {
          const open = await activePayments(network);
          gauge("chain.watched_addresses", open.length, { network });
          await scanTronPayments(network, open);
          clearRpcError(scope);
        } catch (e) {
          logRpcError(scope, e);
        }
      }
    );
  }

  log.info("tron watcher started", {
    "worker.interval_s": env.tronPollSec,
    "chain.api_base": (NETWORKS[network] as TronNetworkDef).apiBase,
  });
  void tick();
  setInterval(tick, env.tronPollSec * 1000);
}
