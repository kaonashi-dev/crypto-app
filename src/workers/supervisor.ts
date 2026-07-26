import { createPublicClient, http } from "viem";
import { NETWORKS, type NetworkId } from "../config";
import { startWatcher } from "./watcher";
import { startConfirmer } from "./confirmer";
import { startTronWatcher } from "./tron-watcher";
import { startTronConfirmer } from "./tron-confirmer";
import { getNowBlock } from "../services/tron";
import { logRpcError } from "./rpc-log";

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
  const scope = `gateway:${network}`;
  let warned = false;
  let retryMs = PROBE_RETRY_MS;

  async function run(): Promise<void> {
    try {
      await probe();
    } catch (e) {
      logRpcError(scope, e);
      if (!warned) {
        warned = true;
        console.warn(`[${scope}] workers paused — retrying, backing off to ${PROBE_RETRY_MAX_MS / 60_000} min`);
      }
      setTimeout(run, retryMs);
      retryMs = Math.min(retryMs * 2, PROBE_RETRY_MAX_MS);
      return;
    }

    console.log(`[${scope}] RPC reachable — starting watcher + confirmer`);
    start();
  }

  void run();
}
