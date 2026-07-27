import { createPublicClient, webSocket, http, type Block, type Transaction } from "viem";
import { and, inArray, eq } from "drizzle-orm";
import { db, schema } from "../db";
import { NETWORKS, env, type NetworkId, type EvmNetworkDef } from "../config";
import { registerDeposit } from "../services/payments";
import { clearRpcError, logRpcError } from "./rpc-log";
import { getLogger, withContext, count, gauge, observe } from "../observability";

/**
 * Detection for the chain's own coin (BNB, POL) — the asset with no contract.
 *
 * The token watcher beside this one has it easy: an ERC-20 transfer is an event,
 * so the node indexes it, filters it by recipient server-side and pushes only
 * the matching ones. A native transfer is a *field on the transaction*. Nothing
 * indexes it, no subscription filters it, and `eth_getLogs` cannot see it. The
 * only way to find one is to read the block and look at every transaction in it.
 *
 * That inverts the cost model, so the whole worker is built around not reading
 * blocks it does not need:
 *
 *   - it reads nothing at all unless some payment on this network is open *and*
 *     quoted in the native coin (the common case is zero, and then this worker
 *     costs one cheap subscription and no calls);
 *   - block bodies are fetched over HTTP one block at a time, because that is
 *     the true unit — there is no chunking to amortise it the way the log
 *     backfill batches ranges.
 *
 * Known limit: only top-level transactions carry a `to` and a `value` here, so a
 * payer funded by a *contract* (an exchange sweeping through a router, a Safe,
 * a multicall) moves value in an internal call this cannot see. That case needs
 * a tracing endpoint, which is a paid tier on every provider; the payer sending
 * from their own wallet — the overwhelming case for a checkout — is a top-level
 * transaction and is caught.
 */

const ACTIVE = ["pending", "detecting", "partially_paid"] as const;

/** Native transfers have no log index; -1 marks them (see the deposits schema). */
const NATIVE_LOG_INDEX = -1;

/**
 * Open payments on this network quoted in its native coin, keyed by lower-cased
 * address.
 *
 * Lower-cased because a block's transactions carry whatever casing the node
 * emits, while `payments.address` holds the EIP-55 checksummed form that
 * `registerDeposit` looks up — so the map both matches loosely and hands back
 * the exact stored string.
 */
async function activeNativeAddresses(
  network: NetworkId,
  symbol: string
): Promise<Map<string, string>> {
  const rows = await db
    .select({ address: schema.payments.address })
    .from(schema.payments)
    .where(
      and(
        eq(schema.payments.network, network),
        eq(schema.payments.asset, symbol),
        inArray(schema.payments.status, [...ACTIVE])
      )
    );
  return new Map(rows.map((r) => [r.address.toLowerCase(), r.address]));
}

export function startNativeWatcher(network: NetworkId) {
  const net = NETWORKS[network] as EvmNetworkDef;
  const native = net.native;
  if (!native) return; // nothing to watch: this chain's coin is not accepted

  const wsClient = createPublicClient({ chain: net.chain, transport: webSocket(net.wsRpc) });
  const httpClient = createPublicClient({ chain: net.chain, transport: http(net.httpRpc) });
  const log = getLogger(`native-watcher:${network}`, { "chain.network": network });

  let watched = new Map<string, string>();
  // Highest block already examined, so a burst of heads (or a reconnection)
  // scans the gap instead of only the newest block.
  let lastScanned = 0n;
  // Block scans are serialised: they share `lastScanned`, and two overlapping
  // sweeps would each pay for the same block bodies.
  let scanning = false;

  async function refreshWatched(): Promise<void> {
    watched = await activeNativeAddresses(network, native!.symbol);
    gauge("chain.watched_native_addresses", watched.size, { network });
  }

  /** Credits every top-level transfer to a watched address in one block. */
  async function scanBlock(blockNumber: bigint, source: "head" | "backfill"): Promise<number> {
    const block = (await httpClient.getBlock({
      blockNumber,
      includeTransactions: true,
    })) as Block<bigint, true>;
    count("rpc.calls", { network, method: "eth_getBlockByNumber" });

    let found = 0;
    for (const tx of block.transactions as Transaction[]) {
      if (!tx.to || tx.value === 0n) continue;
      const address = watched.get(tx.to.toLowerCase());
      if (!address) continue;

      found++;
      count("chain.transfers.seen", { network, source: `native_${source}` });
      log.info("transfer seen", {
        "transfer.source": `native_${source}`,
        "token.symbol": native!.symbol,
        "transfer.to": address,
        "transfer.from": tx.from,
        "transfer.amount_raw": tx.value,
        "chain.tx_hash": tx.hash,
        "chain.block_number": blockNumber,
      });

      await registerDeposit({
        network,
        address,
        txHash: tx.hash,
        logIndex: NATIVE_LOG_INDEX,
        from: tx.from,
        asset: native!.symbol,
        amountRaw: tx.value,
        blockNumber,
      }); // idempotent: duplicates are dropped by the unique index
    }
    return found;
  }

  /**
   * Scans everything from `lastScanned` up to `latest`.
   *
   * The span is capped: after a long disconnection the gap can be thousands of
   * blocks, and reading all of them would spend the provider quota that the rest
   * of the gateway needs. The skip is logged rather than absorbed silently,
   * because those blocks are genuinely unexamined.
   */
  async function scanUpTo(latest: bigint, source: "head" | "backfill"): Promise<void> {
    if (scanning) return;
    scanning = true;
    const started = performance.now();
    try {
      const cap = env.nativeBackfillBlocks;
      let from = lastScanned === 0n ? latest : lastScanned + 1n;
      if (latest - from + 1n > cap) {
        const skipped = latest - from + 1n - cap;
        from = latest - cap + 1n;
        log.warn("native scan window capped — older blocks skipped", {
          "chain.blocks_skipped": skipped,
          "chain.from_block": from,
          "chain.to_block": latest,
          "config.native_backfill_blocks": Number(cap),
        });
      }

      // The cursor advances per block rather than once at the end, so a failure
      // part-way through does not re-read the blocks already examined. This is
      // not hypothetical: a node can report a head it cannot yet serve
      // (`BlockNotFoundError`), which is exactly a mid-sweep throw. Nothing is
      // skipped either way — the failing block keeps its place at `from` and is
      // retried on the next head or backfill.
      let found = 0;
      for (let n = from; n <= latest; n++) {
        found += await scanBlock(n, source);
        if (n > lastScanned) lastScanned = n;
      }

      const ms = performance.now() - started;
      observe("chain.native_scan.duration", ms, { network });
      gauge("chain.height", Number(latest), { network });
      log.debug("native scan complete", {
        "chain.watched_native_addresses": watched.size,
        "chain.from_block": from,
        "chain.to_block": latest,
        "rpc.calls": Number(latest - from + 1n),
        "chain.transfers_found": found,
        "transfer.source": source,
        duration_ms: Math.round(ms),
      });
    } finally {
      scanning = false;
    }
  }

  const onError = (scope: string) => (e: unknown) => logRpcError(`native-watcher:${network}:${scope}`, e);

  /**
   * New heads drive live detection. The subscription itself is cheap — it
   * carries headers, not bodies — so it stays up regardless; what it gates is
   * the block *body* fetch, which only happens while a native payment is open.
   */
  wsClient.watchBlockNumber({
    emitOnBegin: true,
    onBlockNumber: async (latest) => {
      await withContext(
        { attributes: { "chain.network": network, "worker.name": "native-watcher" } },
        async () => {
          if (watched.size === 0) {
            // Keep the cursor current: once a payment does open, the sweep
            // starts from now rather than replaying the idle stretch.
            lastScanned = latest;
            log.trace("head ignored — no open native payments", { "chain.block_number": latest });
            return;
          }
          try {
            await scanUpTo(latest, "head");
            clearRpcError(`native-watcher:${network}:head`);
          } catch (e) {
            onError("head")(e);
          }
        }
      );
    },
    onError: onError("subscription"),
  });

  /**
   * Safety net for heads the subscription dropped, mirroring the token
   * watcher's backfill. It re-reads the tail of the chain rather than trusting
   * the cursor, so a scan that failed mid-block is retried.
   */
  async function backfill(): Promise<void> {
    await withContext(
      { attributes: { "chain.network": network, "worker.name": "native-backfill" } },
      async () => {
        await refreshWatched();
        if (watched.size === 0) {
          log.debug("native backfill skipped — no open native payments");
          return;
        }
        const latest = await httpClient.getBlockNumber();
        count("rpc.calls", { network, method: "eth_blockNumber" });
        const span = env.nativeBackfillBlocks;
        lastScanned = latest > span ? latest - span : 0n;
        await scanUpTo(latest, "backfill");
        clearRpcError(`native-watcher:${network}:backfill`);
      }
    );
  }

  log.info("native watcher started", {
    "token.symbol": native.symbol,
    "token.decimals": native.decimals,
    "chain.ws_endpoint": new URL(net.wsRpc).host,
    "worker.refresh_interval_s": 15,
    "worker.backfill_interval_s": env.backfillSec,
    "config.native_backfill_blocks": Number(env.nativeBackfillBlocks),
  });

  refreshWatched().catch(onError("refresh"));
  backfill().catch(onError("backfill"));
  // Refreshing the address set only touches the database, so its cadence is
  // free; every scan it enables is metered.
  setInterval(() => refreshWatched().catch(onError("refresh")), 15_000);
  setInterval(() => backfill().catch(onError("backfill")), env.backfillSec * 1000);
}
