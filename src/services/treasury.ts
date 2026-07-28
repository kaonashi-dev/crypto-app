/**
 * What the gateway's own wallets hold, read from the chain.
 *
 * Three addresses matter operationally, and none of them is visible from the
 * database:
 *
 *  - **treasury** — where swept value lands. The gateway holds no key for it; it
 *    is a destination only. Its balance is the answer to "did the money actually
 *    arrive", which the `sweeps` ledger asserts but cannot prove.
 *  - **relayer** — pays gas for sweeps out of deposit addresses that hold no
 *    native balance of their own. An empty relayer is the single likeliest
 *    reason sweeps plan and never move, and it is invisible in every table.
 *  - the deposit addresses themselves, which reconciliation covers (§9).
 *
 * **Auditing only.** This is the same narrow exception as
 * `workers/sweep-recon.ts`: settlement is event-sourced from Transfer logs and
 * never reads a balance, and nothing here feeds `registerDeposit`,
 * `confirmDeposit` or any payment column. It exists so an operator can see the
 * custody picture without an explorer and without the deployment's `.env`.
 *
 * Results are cached, because the console polls and these are metered calls —
 * see `TTL_MS`.
 */
import { erc20Abi, type Hex } from "viem";
import {
  NETWORKS,
  NETWORK_IDS,
  env,
  gasCoinFor,
  missingCredential,
  type EvmNetworkDef,
  type NetworkId,
  type TronNetworkDef,
} from "../config";
import { clientFor } from "./evm-sweep";
import { getSigner } from "./signer";
import { base58ToHexAddress, getAccountBalances } from "./tron";
import { getLogger, count } from "../observability";

const log = getLogger("treasury");

/**
 * How long a reading stays fresh.
 *
 * The console refreshes on its own cadence, which an operator can set as low as
 * a few seconds; without a cache that would turn an open browser tab into a
 * standing RPC bill. Balances move only when a sweep confirms, so half a minute
 * of staleness costs nothing and the response says how old it is.
 */
const TTL_MS = 30_000;

export type AssetBalance = {
  asset: string;
  raw: string;
  decimals: number;
  kind: "token" | "native";
  /** True for the coin this chain charges fees in. */
  isFeeCurrency: boolean;
};

export type WalletInfo = {
  role: "treasury" | "relayer";
  address: string | null;
  balances: AssetBalance[];
  /** Why there is nothing to report, when there is nothing to report. */
  note: string | null;
};

export type NetworkWallets = {
  network: string;
  family: "evm" | "tron";
  testnet: boolean;
  /** False when the RPC did not answer — balances are unknown, not zero. */
  reachable: boolean;
  error: string | null;
  wallets: WalletInfo[];
};

type Cached = { value: NetworkWallets; fetchedAt: number };
const cache = new Map<NetworkId, Cached>();

const zero = (asset: string, decimals: number, kind: "token" | "native", fee: string) => ({
  asset,
  raw: "0",
  decimals,
  kind,
  isFeeCurrency: asset === fee,
});

// -- EVM ---------------------------------------------------------------

async function evmBalances(
  network: NetworkId,
  net: EvmNetworkDef,
  address: Hex
): Promise<AssetBalance[]> {
  const client = clientFor(network);
  const fee = gasCoinFor(network);
  const tokens = Object.entries(net.tokens) as Array<[string, { address: Hex; decimals: number }]>;

  const [native, tokenBalances] = await Promise.all([
    client.getBalance({ address }),
    tokens.length && net.chain.contracts?.multicall3
      ? client.multicall({
          allowFailure: true,
          contracts: tokens.map(([, def]) => ({
            address: def.address,
            abi: erc20Abi,
            functionName: "balanceOf" as const,
            args: [address],
          })),
        })
      : Promise.all(
          tokens.map(([, def]) =>
            client
              .readContract({
                address: def.address,
                abi: erc20Abi,
                functionName: "balanceOf",
                args: [address],
              })
              .then((r) => ({ status: "success" as const, result: r }))
              .catch(() => ({ status: "failure" as const, result: undefined }))
          )
        ),
  ]);
  count("rpc.calls", { network, method: "eth_getBalance" });
  if (tokens.length) count("rpc.calls", { network, method: "eth_call:multicall" });

  const out: AssetBalance[] = [
    // The fee currency, which on Sepolia and Base is ETH — a coin the gateway
    // does not accept as payment but every sweep there is priced in.
    {
      asset: fee.symbol,
      raw: native.toString(),
      decimals: fee.decimals,
      kind: "native",
      isFeeCurrency: true,
    },
  ];

  tokens.forEach(([symbol, def], i) => {
    const r = tokenBalances[i];
    if (!r || r.status !== "success") return;
    out.push({
      asset: symbol,
      raw: (r.result as bigint).toString(),
      decimals: def.decimals,
      kind: "token",
      isFeeCurrency: false,
    });
  });
  return out;
}

// -- Tron --------------------------------------------------------------

async function tronBalances(net: TronNetworkDef, address: string): Promise<AssetBalance[]> {
  const account = await getAccountBalances(net, address);
  const fee = net.native?.symbol ?? "TRX";
  const decimals = net.native?.decimals ?? 6;

  // An address with no on-chain history is not an error: it holds nothing and
  // has simply never been activated.
  if (!account) {
    return [
      zero(fee, decimals, "native", fee),
      ...Object.entries(net.tokens).map(([symbol, def]) =>
        zero(symbol, def.decimals, "token", fee)
      ),
    ];
  }

  const out: AssetBalance[] = [
    {
      asset: fee,
      raw: account.trx.toString(),
      decimals,
      kind: "native",
      isFeeCurrency: true,
    },
  ];
  for (const [symbol, def] of Object.entries(net.tokens)) {
    // TronGrid keys TRC-20 balances by the Base58 contract address; the registry
    // stores the same form, so no conversion is needed — but a node that returns
    // the hex form is tolerated rather than silently reported as zero.
    const raw =
      account.trc20.get(def.address) ?? account.trc20.get(base58ToHexAddress(def.address)) ?? 0n;
    out.push({
      asset: symbol,
      raw: raw.toString(),
      decimals: def.decimals,
      kind: "token",
      isFeeCurrency: false,
    });
  }
  return out;
}

// -- Overview ----------------------------------------------------------

/** The configured treasury for a family, or null. Shape only — see `treasuryFor`. */
function treasuryAddress(network: NetworkId): string | null {
  return NETWORKS[network].family === "tron" ? env.treasuryTron : env.treasuryEvm;
}

/**
 * The relayer's address, or null when no signer can produce one.
 *
 * `getSigner()` throws for `SWEEP_SIGNER=remote`, which is deliberate — it
 * refuses rather than falling back to in-process keys — so the console reports
 * "no signer" instead of failing the whole request.
 */
async function relayerAddress(family: "evm" | "tron"): Promise<string | null> {
  try {
    return await getSigner().addressFor({ role: "relayer", family });
  } catch {
    return null;
  }
}

async function readNetwork(network: NetworkId): Promise<NetworkWallets> {
  const net = NETWORKS[network];
  const base: NetworkWallets = {
    network,
    family: net.family,
    testnet: net.testnet,
    reachable: true,
    error: null,
    wallets: [],
  };

  const treasury = treasuryAddress(network);
  const relayer = await relayerAddress(net.family);

  const read = (address: string) =>
    net.family === "tron"
      ? tronBalances(net, address)
      : evmBalances(network, net, address as Hex);

  try {
    const [treasuryBalances, relayerBalances] = await Promise.all([
      treasury ? read(treasury) : Promise.resolve([]),
      relayer ? read(relayer) : Promise.resolve([]),
    ]);

    base.wallets = [
      {
        role: "treasury",
        address: treasury,
        balances: treasuryBalances,
        note: treasury
          ? null
          : `not configured — set ${net.family === "tron" ? "TREASURY_ADDRESS_TRON" : "TREASURY_ADDRESS_EVM"}`,
      },
      {
        role: "relayer",
        address: relayer,
        balances: relayerBalances,
        note: relayer ? null : "no signer — SWEEP_SIGNER names an implementation that does not exist",
      },
    ];
  } catch (e) {
    // An unreachable node means the balances are *unknown*. Reporting them as
    // zero would be a lie the console has no way to distinguish from an empty
    // wallet — which is the one thing an operator checks this view for.
    base.reachable = false;
    base.error = (e as Error).message.split("\n")[0] ?? "unreachable";
    base.wallets = [
      { role: "treasury", address: treasury, balances: [], note: "balances unknown — RPC unreachable" },
      { role: "relayer", address: relayer, balances: [], note: "balances unknown — RPC unreachable" },
    ];
    log.repeat(`wallets:${network}`, "warn", "wallet balances unavailable — RPC unreachable", {
      "chain.network": network,
      err: e,
    });
  }

  return base;
}

/**
 * Treasury and relayer holdings across every served network.
 *
 * Networks without their RPC credential are reported with their addresses and no
 * balances rather than omitted: knowing *where* to send gas is useful before the
 * network is switched on, and an address that silently vanished from this list
 * would be the wrong answer to "why is nothing sweeping".
 */
export async function walletOverview(): Promise<{ networks: NetworkWallets[]; age_s: number }> {
  const now = Date.now();
  let oldest = now;

  const networks = await Promise.all(
    NETWORK_IDS.map(async (network) => {
      const hit = cache.get(network);
      if (hit && now - hit.fetchedAt < TTL_MS) {
        oldest = Math.min(oldest, hit.fetchedAt);
        return hit.value;
      }

      const missing = missingCredential(network);
      if (missing) {
        const net = NETWORKS[network];
        const value: NetworkWallets = {
          network,
          family: net.family,
          testnet: net.testnet,
          reachable: false,
          error: `${missing} is not set`,
          wallets: [
            {
              role: "treasury",
              address: treasuryAddress(network),
              balances: [],
              note: "network has no RPC credential — balances not read",
            },
            {
              role: "relayer",
              address: await relayerAddress(net.family),
              balances: [],
              note: "network has no RPC credential — balances not read",
            },
          ],
        };
        cache.set(network, { value, fetchedAt: now });
        return value;
      }

      const value = await readNetwork(network);
      cache.set(network, { value, fetchedAt: now });
      return value;
    })
  );

  return { networks, age_s: Math.round((now - oldest) / 1000) };
}

/** Forgets cached readings. Used by the scripts so a check is never stale. */
export function resetWalletCache(): void {
  cache.clear();
}
