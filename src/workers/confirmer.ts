import { createPublicClient, http } from "viem";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db";
import { NETWORKS, env, type NetworkId, type EvmNetworkDef } from "../config";
import { confirmDeposit } from "../services/payments";
import { clearRpcError, logRpcError } from "./rpc-log";
import { getLogger, withContext, count, gauge } from "../observability";

export function startConfirmer(network: NetworkId) {
  const net = NETWORKS[network] as EvmNetworkDef;
  const client = createPublicClient({ chain: net.chain, transport: http(net.httpRpc) });
  const log = getLogger(`confirmer:${network}`, { "chain.network": network });

  log.info("confirmer started", {
    "worker.interval_s": env.confirmerSec,
    "chain.confirmations_required": net.confirmations,
  });

  setInterval(async () => {
    await withContext(
      { attributes: { "chain.network": network, "worker.name": "confirmer" } },
      async () => {
        const tick = log.time("confirmer tick");
        try {
          // Ask the DB (free, local) before the RPC (metered): with nothing pending
          // there is no reason to learn the block height at all.
          const rows = await db
            .select()
            .from(schema.deposits)
            .where(
              and(eq(schema.deposits.network, network), eq(schema.deposits.confirmed, false))
            );
          gauge("deposits.unconfirmed", rows.length, { network });
          if (rows.length === 0) {
            log.trace("nothing unconfirmed — skipping RPC");
            return;
          }

          const latest = await client.getBlockNumber();
          count("rpc.calls", { network, method: "eth_blockNumber" });
          clearRpcError(`confirmer:${network}`);
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
            const receipt = await client
              .getTransactionReceipt({ hash: dep.txHash as `0x${string}` })
              .catch((e) => {
                log.debug("receipt lookup failed", { "chain.tx_hash": dep.txHash, err: e });
                return null;
              });
            count("rpc.calls", { network, method: "eth_getTransactionReceipt" });

            if (!receipt || receipt.status !== "success") {
              // The tx vanished or failed after a reorg -> clean up the deposit.
              count("deposits.unwound", { network });
              log.warn("deposit unwound — transaction gone or reverted", {
                "deposit.id": dep.id,
                "payment.uuid": dep.paymentId,
                "chain.tx_hash": dep.txHash,
                "chain.block_number": dep.blockNumber,
                "deposit.amount_raw": dep.amountRaw,
                "chain.receipt_status": receipt?.status ?? "missing",
              });
              await db.transaction(async (tx) => {
                await tx.delete(schema.deposits).where(eq(schema.deposits.id, dep.id));
                // return the amount to the payment's pendingRaw
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
              "chain.gas_used": receipt.gasUsed,
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
          logRpcError(`confirmer:${network}`, e);
        }
      }
    );
  }, env.confirmerSec * 1000);
}
