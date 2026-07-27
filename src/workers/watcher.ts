import { createPublicClient, webSocket, http, parseAbiItem } from "viem";
import { and, inArray, eq } from "drizzle-orm";
import { db, schema } from "../db";
import { NETWORKS, env, type NetworkId, type EvmNetworkDef } from "../config";
import { registerDeposit } from "../services/payments";
import { clearRpcError, logRpcError } from "./rpc-log";
import { getLogger, withContext, count, gauge, observe } from "../observability";

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
  const log = getLogger(`watcher:${network}`, { "chain.network": network });

  let watchedKey = "";
  let unwatchers: Array<() => void> = [];

  // Re-subscribe when the set of active addresses changes.
  async function resubscribe() {
    const addrs = await activeAddresses(network);
    const key = addrs.slice().sort().join(",");
    if (key === watchedKey) {
      log.trace("subscription unchanged", { "chain.watched_addresses": addrs.length });
      return;
    }

    const previous = watchedKey ? watchedKey.split(",").length : 0;
    // Tear down every existing subscription (one per token).
    for (const u of unwatchers) u();
    unwatchers = [];
    watchedKey = key;
    gauge("chain.watched_addresses", addrs.length, { network });

    if (addrs.length === 0) {
      log.info("no open payments — subscriptions torn down", {
        "chain.watched_addresses_before": previous,
      });
      return;
    }

    for (const [symbol, token] of Object.entries(net.tokens)) {
      const unwatch = wsClient.watchContractEvent({
        address: token.address,
        abi: [transferEvent],
        eventName: "Transfer",
        args: { to: addrs }, // <- server-side filter by indexed topic
        onLogs: async (logs) => {
          // Each delivery is its own trace: everything registerDeposit logs
          // downstream carries these ids.
          await withContext(
            { attributes: { "chain.network": network, "worker.name": "watcher" } },
            async () => {
              log.debug("websocket delivered logs", {
                "chain.log_count": logs.length,
                "token.symbol": symbol,
              });
              for (const entry of logs) {
                if (entry.removed) {
                  // reorg: the log was reverted
                  count("chain.logs.removed", { network });
                  log.warn("log removed by reorg — ignoring", {
                    "chain.tx_hash": entry.transactionHash,
                    "chain.log_index": entry.logIndex,
                    "chain.block_number": entry.blockNumber,
                  });
                  continue;
                }
                count("chain.transfers.seen", { network, source: "websocket" });
                log.info("transfer seen", {
                  "transfer.source": "websocket",
                  "token.symbol": symbol,
                  "transfer.to": entry.args.to,
                  "transfer.from": entry.args.from,
                  "transfer.amount_raw": entry.args.value,
                  "chain.tx_hash": entry.transactionHash,
                  "chain.log_index": entry.logIndex,
                  "chain.block_number": entry.blockNumber,
                });
                await registerDeposit({
                  network,
                  address: entry.args.to!,
                  txHash: entry.transactionHash!,
                  logIndex: entry.logIndex!,
                  from: entry.args.from!,
                  amountRaw: entry.args.value!,
                  blockNumber: entry.blockNumber!,
                });
              }
            }
          );
        },
        onError: (e) => logRpcError(`watcher:${network}:${symbol}`, e),
      });
      unwatchers.push(unwatch);
    }

    log.info("subscriptions updated", {
      "chain.watched_addresses": addrs.length,
      "chain.watched_addresses_before": previous,
      "token.symbols": Object.keys(net.tokens),
      // The addresses themselves only at debug: useful when a transfer was not
      // detected, noise otherwise.
      ...(log.enabled("debug") ? { "chain.addresses": addrs } : {}),
    });
  }

  // Backfill: covers gaps from WS reconnections.
  //
  // Queried in chunks because providers cap the eth_getLogs range (Alchemy's
  // free tier allows 10 blocks); a single 500-block call fails outright there,
  // which silently kills the safety net. Both bounds are env-tunable so a paid
  // plan can widen them — see LOG_RANGE_BLOCKS / BACKFILL_BLOCKS.
  async function backfill() {
    await withContext(
      { attributes: { "chain.network": network, "worker.name": "backfill" } },
      async () => {
        const addrs = await activeAddresses(network);
        if (addrs.length === 0) {
          log.debug("backfill skipped — no open payments");
          return;
        }

        const started = performance.now();
        const latest = await httpClient.getBlockNumber();
        count("rpc.calls", { network, method: "eth_blockNumber" });
        clearRpcError(`watcher:${network}:backfill`);

        const span = env.backfillBlocks;
        const chunk = env.logRangeBlocks;
        const fromBlock = latest > span ? latest - span : 0n;

        let calls = 0;
        let found = 0;
        for (const [symbol, token] of Object.entries(net.tokens)) {
          for (let start = fromBlock; start <= latest; start += chunk) {
            const end = start + chunk - 1n > latest ? latest : start + chunk - 1n;
            const logs = await httpClient.getLogs({
              address: token.address,
              event: transferEvent,
              args: { to: addrs },
              fromBlock: start,
              toBlock: end,
            });
            calls++;
            count("rpc.calls", { network, method: "eth_getLogs" });
            log.trace("backfill chunk", {
              "token.symbol": symbol,
              "chain.from_block": start,
              "chain.to_block": end,
              "chain.log_count": logs.length,
            });

            for (const entry of logs) {
              found++;
              count("chain.transfers.seen", { network, source: "backfill" });
              log.info("transfer seen", {
                "transfer.source": "backfill",
                "token.symbol": symbol,
                "transfer.to": entry.args.to,
                "transfer.from": entry.args.from,
                "transfer.amount_raw": entry.args.value,
                "chain.tx_hash": entry.transactionHash,
                "chain.log_index": entry.logIndex,
                "chain.block_number": entry.blockNumber,
              });
              await registerDeposit({
                network,
                address: entry.args.to!,
                txHash: entry.transactionHash!,
                logIndex: entry.logIndex!,
                from: entry.args.from!,
                amountRaw: entry.args.value!,
                blockNumber: entry.blockNumber!,
              }); // idempotent: duplicates are dropped by the unique index
            }
          }
        }

        const ms = performance.now() - started;
        observe("chain.backfill.duration", ms, { network });
        gauge("chain.height", Number(latest), { network });
        // The call count is the cost of this sweep — the dial BACKFILL_BLOCKS /
        // LOG_RANGE_BLOCKS controls — so it is stated rather than inferred.
        log.debug("backfill complete", {
          "chain.watched_addresses": addrs.length,
          "chain.from_block": fromBlock,
          "chain.to_block": latest,
          "rpc.calls": calls + 1,
          "chain.transfers_found": found,
          duration_ms: Math.round(ms),
        });
      }
    );
  }

  const onResubscribeError = (e: unknown) => logRpcError(`watcher:${network}:resubscribe`, e);
  const onBackfillError = (e: unknown) => logRpcError(`watcher:${network}:backfill`, e);

  log.info("watcher started", {
    "chain.ws_endpoint": new URL(net.wsRpc).host,
    "worker.resubscribe_interval_s": 15,
    "worker.backfill_interval_s": env.backfillSec,
    "config.backfill_blocks": env.backfillBlocks,
    "config.log_range_blocks": env.logRangeBlocks,
  });

  resubscribe().catch(onResubscribeError);
  backfill().catch(onBackfillError);
  // resubscribe only touches the DB, so its cadence is free; backfill is metered.
  setInterval(() => resubscribe().catch(onResubscribeError), 15_000);
  setInterval(() => backfill().catch(onBackfillError), env.backfillSec * 1000);
}
