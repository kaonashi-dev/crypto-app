import { and, eq } from "drizzle-orm";
import { db, schema } from "../db";
import { NETWORKS, env, type NetworkId, type TronNetworkDef } from "../config";
import { confirmDeposit } from "../services/payments";
import { getNowBlock, getTransactionInfo } from "../services/tron";
import { clearRpcError, logRpcError } from "./rpc-log";


/**
 * Advances Tron deposits to confirmed once they are deep enough, re-checking
 * the transaction first so a dropped one is unwound — same contract as the EVM
 * confirmer, over TronGrid's HTTP API instead of viem.
 */
export function startTronConfirmer(network: NetworkId) {
  const net = NETWORKS[network] as TronNetworkDef;
  const scope = `tron-confirmer:${network}`;

  setInterval(async () => {
    try {
      // Ask the DB (free, local) before TronGrid (rate-limited): with nothing
      // pending there is no reason to learn the block height at all.
      const rows = await db
        .select()
        .from(schema.deposits)
        .where(
          and(eq(schema.deposits.network, network), eq(schema.deposits.confirmed, false))
        );
      if (rows.length === 0) return;

      const latest = await getNowBlock(net);
      clearRpcError(scope);

      for (const dep of rows) {
        if (dep.blockNumber + net.confirmations > latest) continue; // not mature yet

        // Anti-reorg check: is the tx still mined and successful?
        const info = await getTransactionInfo(net, dep.txHash).catch(() => null);
        const ok = info && (!info.receipt?.result || info.receipt.result === "SUCCESS");
        if (!ok) {
          // The tx vanished or failed -> unwind the deposit.
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
            }
          });
          continue;
        }

        await confirmDeposit(dep.id);
      }
    } catch (e) {
      logRpcError(scope, e);
    }
  }, env.confirmerSec * 1000);
}
