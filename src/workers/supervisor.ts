import { createPublicClient, http } from "viem";
import { NETWORKS, type NetworkId } from "../config";
import { startWatcher } from "./watcher";
import { startConfirmer } from "./confirmer";
import { startTronWatcher } from "./tron-watcher";
import { startTronConfirmer } from "./tron-confirmer";
import { getNowBlock } from "../services/tron";
import { logRpcError } from "./rpc-log";
import { getLogger, withContext, count, gauge, observe } from "../observability";

const PROBE_RETRY_MS = 60_000;
// A network that stays unreachable is usually a config gap someone has to fix
// (a plan limit, a disabled network), not a blip — so back off instead of
// probing at a fixed rate forever. Capped so recovery is still picked up.
const PROBE_RETRY_MAX_MS = 900_000;

/** Per-family liveness probe + worker pair. */
function driver(network: NetworkId) {
  const net = NETWORKS[network];

  if (net.family === "tron") {
    return {
      probe: () => getNowBlock(net),
      start: () => {
        startTronWatcher(network);
        startTronConfirmer(network);
      },
    };
  }

  const client = createPublicClient({ chain: net.chain, transport: http(net.httpRpc) });
  return {
    probe: () => client.getBlockNumber(),
    start: () => {
      startWatcher(network);
      startConfirmer(network);
    },
  };
}

/**
 * Brings a network's workers up only once its RPC actually answers.
 *
 * Opening a WebSocket against a network the Alchemy app has not enabled makes
 * viem's reconnect loop print a raw ErrorEvent straight to the console (it does
 * `setup().catch(console.error)` internally, so it cannot be intercepted). We
 * probe over HTTP first and retry quietly, which keeps the log clean and lets
 * the workers start on their own once the network is enabled — no restart.
 */
export function superviseNetwork(network: NetworkId): void {
  const { probe, start } = driver(network);
  const scope = `supervisor:${network}`;
  const log = getLogger(scope, { "chain.network": network });
  const net = NETWORKS[network];
  let attempt = 0;
  let retryMs = PROBE_RETRY_MS;

  async function run(): Promise<void> {
    // One trace per probe attempt, so the probe, its failure and the workers it
    // starts all correlate.
    await withContext({ attributes: { "chain.network": network } }, async () => {
      attempt++;
      const started = performance.now();
      let height: bigint;
      try {
        height = await probe();
        observe("chain.probe.duration", performance.now() - started, { network });
      } catch (e) {
        observe("chain.probe.duration", performance.now() - started, { network });
        count("chain.probe.failures", { network });
        gauge("chain.up", 0, { network });
        logRpcError(scope, e);
        log.repeat("paused", "warn", "workers paused — RPC unreachable, retrying", {
          "chain.probe.attempt": attempt,
          "chain.probe.retry_in_s": Math.round(retryMs / 1000),
          "chain.probe.max_backoff_min": PROBE_RETRY_MAX_MS / 60_000,
        });
        setTimeout(run, retryMs);
        retryMs = Math.min(retryMs * 2, PROBE_RETRY_MAX_MS);
        return;
      }

      gauge("chain.up", 1, { network });
      gauge("chain.height", Number(height), { network });
      log.resolved("paused", "rpc reachable again");
      log.info("RPC reachable — starting watcher + confirmer", {
        "chain.family": net.family,
        "chain.height": height,
        "chain.confirmations_required": net.confirmations,
        "chain.probe.attempt": attempt,
        "chain.probe.duration_ms": Math.round(performance.now() - started),
      });
      start();
    });
  }

  log.debug("supervising", { "chain.family": net.family });
  void run();
}
