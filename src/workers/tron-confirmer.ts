import { and, eq } from "drizzle-orm";
import { db, schema } from "../db";
import { NETWORKS, env, type NetworkId, type TronNetworkDef } from "../config";
import { confirmDeposit } from "../services/payments";
import { getNowBlock, getTransactionInfo } from "../services/tron";
import { clearRpcError, logRpcError } from "./rpc-log";
import { getLogger, withContext, count, gauge } from "../observability";

/**
 * Advances Tron deposits to confirmed once they are deep enough, re-checking
 * the transaction first so a dropped one is unwound — same contract as the EVM
 * confirmer, over TronGrid's HTTP API instead of viem.
 */
export function startTronConfirmer(network: NetworkId) {
  const net = NETWORKS[network] as TronNetworkDef;
  const scope = `tron-confirmer:${network}`;
  const log = getLogger(scope, { "chain.network": network });

  log.info("tron confirmer started", {
    "worker.interval_s": env.confirmerSec,
    "chain.confirmations_required": net.confirmations,
  });

  setInterval(async () => {
    await withContext(
      { attributes: { "chain.network": network, "worker.name": "tron-confirmer" } },
      async () => {
        const tick = log.time("tron confirmer tick");
        try {
          // Ask the DB (free, local) before TronGrid (rate-limited): with nothing
          // pending there is no reason to learn the block height at all.
          const rows = await db
            .select()
            .from(schema.deposits)
            .where(
              and(eq(schema.deposits.network, network), eq(schema.deposits.confirmed, false))
            );
          gauge("deposits.unconfirmed", rows.length, { network });
          if (rows.length === 0) {
            log.trace("nothing unconfirmed — skipping TronGrid");
            return;
          }

          const latest = await getNowBlock(net);
          clearRpcError(scope);
          gauge("chain.height", Number(latest), { network });

          let matured = 0;
          let waiting = 0;
          for (const dep of rows) {
            const confirmations = latest > dep.blockNumber ? latest - dep.blockNumber : 0n;
            if (dep.blockNumber + net.confirmations > latest) {
              // not mature yet
              waiting++;
              log.debug("deposit maturing", {
                "deposit.id": dep.id,
                "chain.tx_hash": dep.txHash,
                "chain.block_number": dep.blockNumber,
                "chain.height": latest,
                "chain.confirmations": confirmations,
                "chain.confirmations_required": net.confirmations,
                "chain.blocks_remaining": dep.blockNumber + net.confirmations - latest,
              });
              continue;
            }

            // Anti-reorg check: is the tx still mined and successful?
            const info = await getTransactionInfo(net, dep.txHash).catch((e) => {
              log.debug("transaction lookup failed", { "chain.tx_hash": dep.txHash, err: e });
              return null;
            });
            const ok = info && (!info.receipt?.result || info.receipt.result === "SUCCESS");
            if (!ok) {
              // The tx vanished or failed -> unwind the deposit.
              count("deposits.unwound", { network });
              log.warn("deposit unwound — transaction gone or failed", {
                "deposit.id": dep.id,
                "payment.uuid": dep.paymentId,
                "chain.tx_hash": dep.txHash,
                "chain.block_number": dep.blockNumber,
                "deposit.amount_raw": dep.amountRaw,
                "chain.receipt_status": info?.receipt?.result ?? "missing",
              });
              await db.transaction(async (tx) => {
                await tx.delete(schema.deposits).where(eq(schema.deposits.id, dep.id));
                const [p] = await tx
                  .select()
                  .from(schema.payments)
                  .where(eq(schema.payments.id, dep.paymentId))
                  .for("update");
                if (p) {
                  await tx
                    .update(schema.payments)
                    .set({ pendingRaw: p.pendingRaw - dep.amountRaw })
                    .where(eq(schema.payments.id, p.id));
                  log.debug("pending balance reverted", {
                    "payment.id": p.publicId,
                    "payment.pending_raw_before": p.pendingRaw,
                    "payment.pending_raw_after": p.pendingRaw - dep.amountRaw,
                  });
                }
              });
              continue;
            }

            matured++;
            log.info("deposit mature — confirming", {
              "deposit.id": dep.id,
              "chain.tx_hash": dep.txHash,
              "chain.block_number": dep.blockNumber,
              "chain.confirmations": confirmations,
              "deposit.amount_raw": dep.amountRaw,
            });
            await confirmDeposit(dep.id);
          }

          tick({
            "deposits.unconfirmed": rows.length,
            "deposits.matured": matured,
            "deposits.waiting": waiting,
            "chain.height": latest,
          });
        } catch (e) {
          logRpcError(scope, e);
        }
      }
    );
  }, env.confirmerSec * 1000);
}
