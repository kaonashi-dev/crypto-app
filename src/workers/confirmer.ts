import { createPublicClient, http } from "viem";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db";
import { NETWORKS, type NetworkId } from "../config";
import { confirmDeposit } from "../services/payments";

export function startConfirmer(network: NetworkId) {
  const net = NETWORKS[network];
  const client = createPublicClient({ chain: net.chain, transport: http(net.httpRpc) });

  setInterval(async () => {
    try {
      const latest = await client.getBlockNumber();
      const rows = await db
        .select()
        .from(schema.deposits)
        .where(
          and(eq(schema.deposits.network, network), eq(schema.deposits.confirmed, false))
        );

      for (const dep of rows) {
        if (dep.blockNumber + net.confirmations > latest) continue; // not mature yet

        // Anti-reorg check: is the tx still mined and successful?
        const receipt = await client
          .getTransactionReceipt({ hash: dep.txHash as `0x${string}` })
          .catch(() => null);
        if (!receipt || receipt.status !== "success") {
          // The tx vanished or failed after a reorg -> clean up the deposit.
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
            }
          });
          continue;
        }

        await confirmDeposit(dep.id);
      }
    } catch (e: any) {
      console.error(`[confirmer:${network}]`, e.message);
    }
  }, 10_000);
}
