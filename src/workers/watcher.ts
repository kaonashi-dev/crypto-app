import { createPublicClient, webSocket, http, parseAbiItem } from "viem";
import { and, inArray, eq } from "drizzle-orm";
import { db, schema } from "../db";
import { NETWORKS, type NetworkId } from "../config";
import { registerDeposit } from "../services/payments";

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
  const net = NETWORKS[network];
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
        onError: (e) => console.error(`[watcher:${network}:${symbol}]`, e.message),
      });
      unwatchers.push(unwatch);
    }
    console.log(`[watcher:${network}] watching ${addrs.length} addresses`);
  }

  // Backfill: covers gaps from WS reconnections.
  async function backfill() {
    const addrs = await activeAddresses(network);
    if (addrs.length === 0) return;
    const latest = await httpClient.getBlockNumber();
    const fromBlock = latest > 500n ? latest - 500n : 0n;
    for (const token of Object.values(net.tokens)) {
      const logs = await httpClient.getLogs({
        address: token.address,
        event: transferEvent,
        args: { to: addrs },
        fromBlock,
        toBlock: latest,
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

  resubscribe().catch((e) => console.error(`[watcher:${network}] resubscribe`, e));
  backfill().catch((e) => console.error(`[watcher:${network}] backfill`, e));
  setInterval(() => resubscribe().catch((e) => console.error(`[watcher:${network}]`, e)), 15_000);
  setInterval(() => backfill().catch((e) => console.error(`[watcher:${network}]`, e)), 60_000);
}
