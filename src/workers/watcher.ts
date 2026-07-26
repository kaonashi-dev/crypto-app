import { createPublicClient, webSocket, http, parseAbiItem } from "viem";
import { and, inArray, eq } from "drizzle-orm";
import { db, schema } from "../db";
import { NETWORKS, env, type NetworkId, type EvmNetworkDef } from "../config";
import { registerDeposit } from "../services/payments";
import { clearRpcError, logRpcError } from "./rpc-log";

const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)"
);

const ACTIVE = ["pending", "detecting", "partially_paid"] as const;

async function activeAddresses(network: NetworkId): Promise<`0x${string}`[]> {
  const rows = await db
    .select({ address: schema.payments.address })
    .from(schema.payments)
    .where(
      and(
        eq(schema.payments.network, network),
        inArray(schema.payments.status, [...ACTIVE])
      )
    );
  return rows.map((r) => r.address as `0x${string}`);
}

export function startWatcher(network: NetworkId) {
  const net = NETWORKS[network] as EvmNetworkDef;
  const wsClient = createPublicClient({ chain: net.chain, transport: webSocket(net.wsRpc) });
  const httpClient = createPublicClient({ chain: net.chain, transport: http(net.httpRpc) });

  let watchedKey = "";
  let unwatchers: Array<() => void> = [];

  // Re-subscribe when the set of active addresses changes.
  async function resubscribe() {
    const addrs = await activeAddresses(network);
    const key = addrs.slice().sort().join(",");
    if (key === watchedKey) return;

    // Tear down every existing subscription (one per token).
    for (const u of unwatchers) u();
    unwatchers = [];
    watchedKey = key;
    if (addrs.length === 0) return;

    for (const [symbol, token] of Object.entries(net.tokens)) {
      const unwatch = wsClient.watchContractEvent({
        address: token.address,
        abi: [transferEvent],
        eventName: "Transfer",
        args: { to: addrs }, // <- server-side filter by indexed topic
        onLogs: async (logs) => {
          for (const log of logs) {
            if (log.removed) continue; // reorg: the log was reverted
            await registerDeposit({
              network,
              address: log.args.to!,
              txHash: log.transactionHash!,
              logIndex: log.logIndex!,
              from: log.args.from!,
              amountRaw: log.args.value!,
              blockNumber: log.blockNumber!,
            });
          }
        },
        onError: (e) => logRpcError(`watcher:${network}:${symbol}`, e),
      });
      unwatchers.push(unwatch);
    }
    console.log(`[watcher:${network}] watching ${addrs.length} addresses`);
  }

  // Backfill: covers gaps from WS reconnections.
  //
  // Queried in chunks because providers cap the eth_getLogs range (Alchemy's
  // free tier allows 10 blocks); a single 500-block call fails outright there,
  // which silently kills the safety net. Both bounds are env-tunable so a paid
  // plan can widen them — see LOG_RANGE_BLOCKS / BACKFILL_BLOCKS.
  async function backfill() {
    const addrs = await activeAddresses(network);
    if (addrs.length === 0) return;
    const latest = await httpClient.getBlockNumber();
    clearRpcError(`watcher:${network}:backfill`);

    const span = env.backfillBlocks;
    const chunk = env.logRangeBlocks;
    const fromBlock = latest > span ? latest - span : 0n;

    for (const token of Object.values(net.tokens)) {
      for (let start = fromBlock; start <= latest; start += chunk) {
        const end = start + chunk - 1n > latest ? latest : start + chunk - 1n;
        const logs = await httpClient.getLogs({
          address: token.address,
          event: transferEvent,
          args: { to: addrs },
          fromBlock: start,
          toBlock: end,
        });
        for (const log of logs) {
          await registerDeposit({
            network,
            address: log.args.to!,
            txHash: log.transactionHash!,
            logIndex: log.logIndex!,
            from: log.args.from!,
            amountRaw: log.args.value!,
            blockNumber: log.blockNumber!,
          }); // idempotent: duplicates are dropped by the unique index
        }
      }
    }
  }

  const onResubscribeError = (e: unknown) => logRpcError(`watcher:${network}:resubscribe`, e);
  const onBackfillError = (e: unknown) => logRpcError(`watcher:${network}:backfill`, e);

  resubscribe().catch(onResubscribeError);
  backfill().catch(onBackfillError);
  // resubscribe only touches the DB, so its cadence is free; backfill is metered.
  setInterval(() => resubscribe().catch(onResubscribeError), 15_000);
  setInterval(() => backfill().catch(onBackfillError), env.backfillSec * 1000);
}
