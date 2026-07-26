import { and, inArray, eq } from "drizzle-orm";
import { db, schema } from "../db";
import { NETWORKS, env, type NetworkId, type TronNetworkDef } from "../config";
import { registerDeposit } from "../services/payments";
import {
  base58ToHexAddress,
  findTransferLog,
  getTransactionInfo,
  getTrc20Transfers,
} from "../services/tron";
import { clearRpcError, logRpcError } from "./rpc-log";

const ACTIVE = ["pending", "detecting", "partially_paid"] as const;

type OpenPayment = { address: string; createdAt: Date };

/** Open payments on this network, with the moment each started accepting funds. */
async function activePayments(network: NetworkId): Promise<OpenPayment[]> {
  return db
    .select({ address: schema.payments.address, createdAt: schema.payments.createdAt })
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
 * how often this runs, is the whole cost of Tron detection.
 */
export async function scanTronPayments(
  network: NetworkId,
  open: OpenPayment[]
): Promise<void> {
  if (open.length === 0) return;
  const net = NETWORKS[network] as TronNetworkDef;

  for (const token of Object.values(net.tokens)) {
    const contractHex = base58ToHexAddress(token.address);

    for (const { address, createdAt } of open) {
      const transfers = await getTrc20Transfers(net, address, token.address, createdAt);

      for (const transfer of transfers) {
        // The listing is bidirectional; only credit incoming value.
        if (transfer.type !== "Transfer" || transfer.to !== address) continue;
        // Re-check the bound locally: the address may carry unrelated history
        // (HD addresses can be reused, and testnet mnemonics are shared), and
        // funds that predate the payment must never settle it.
        if (transfer.block_timestamp < createdAt.getTime()) continue;

        const info = await getTransactionInfo(net, transfer.transaction_id);
        if (!info) continue; // not mined yet — picked up on a later scan
        if (info.receipt?.result && info.receipt.result !== "SUCCESS") continue;

        const log = findTransferLog(info, contractHex, address);
        if (!log) continue;

        await registerDeposit({
          network,
          address,
          txHash: transfer.transaction_id,
          logIndex: log.logIndex,
          from: log.from,
          amountRaw: log.amountRaw,
          blockNumber: BigInt(info.blockNumber),
        }); // idempotent: duplicates are dropped by the unique index
      }
    }
  }
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

  async function tick() {
    try {
      await scanTronPayments(network, await activePayments(network));
      clearRpcError(scope);
    } catch (e) {
      logRpcError(scope, e);
    }
  }

  console.log(`[${scope}] sweeping every ${env.tronPollSec}s`);
  void tick();
  setInterval(tick, env.tronPollSec * 1000);
}
