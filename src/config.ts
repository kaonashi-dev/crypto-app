import { sepolia, baseSepolia } from "viem/chains";
import type { Chain } from "viem";

export const env = {
  databaseUrl: Bun.env.DATABASE_URL!,
  mnemonic: Bun.env.HD_MNEMONIC!,
  quoteTtlMin: Number(Bun.env.QUOTE_TTL_MINUTES ?? 15),
  graceTtlMin: Number(Bun.env.GRACE_TTL_MINUTES ?? 90),
  spreadBps: BigInt(Bun.env.SPREAD_BPS ?? 75),
  dustBps: BigInt(Bun.env.DUST_TOLERANCE_BPS ?? 50),
  port: Number(Bun.env.PORT ?? 3000),
  // Last-resort USD->COP rate if every FX provider is unreachable and no cached
  // rate is fresh enough. Unset = refuse to quote rather than guess.
  fallbackUsdCop: Bun.env.FALLBACK_USD_COP ? Number(Bun.env.FALLBACK_USD_COP) : null,
  // Optional. TronGrid serves the public testnet without a key but rate-limits
  // by IP; a free key raises the ceiling.
  trongridApiKey: Bun.env.TRONGRID_API_KEY ?? null,
  // How far back the EVM backfill looks, and the largest eth_getLogs range the
  // provider accepts (Alchemy's free tier: 10 blocks). The backfill walks the
  // span in chunks of this size, so a wider span costs proportionally more calls.
  backfillBlocks: BigInt(Bun.env.BACKFILL_BLOCKS ?? 50),
  logRangeBlocks: BigInt(Bun.env.LOG_RANGE_BLOCKS ?? 10),
  // Polling cadences, in seconds. These are the main cost dial: every tick that
  // finds work costs provider calls. The EVM backfill only has to catch what the
  // WebSocket missed, so it can run far less often than live detection; Tron has
  // no WebSocket, so its watcher interval *is* the detection latency.
  backfillSec: Number(Bun.env.BACKFILL_INTERVAL_SEC ?? 300),
  tronPollSec: Number(Bun.env.TRON_POLL_INTERVAL_SEC ?? 60),
  confirmerSec: Number(Bun.env.CONFIRMER_INTERVAL_SEC ?? 30),
  // Set by the deployment image, not by a developer. It only tightens the boot
  // preflight below; nothing in the payment path branches on it.
  isProduction: Bun.env.NODE_ENV === "production",
  // Canonical public origin, no trailing slash. Merchant-facing `checkout_url`s
  // are built from the request when this is unset, which is right locally and
  // behind a proxy that sets X-Forwarded-Proto. Set it when the gateway sits on
  // a custom domain and the links must not vary with the Host header.
  publicBaseUrl: Bun.env.PUBLIC_BASE_URL?.replace(/\/+$/, "") || null,
  // Gates the /admin console (see src/api/admin.ts) with HTTP Basic. Optional in
  // development, required in production — the preflight refuses to boot without
  // it. The username is only the other half of the Basic credential; the password
  // is the secret.
  adminUser: Bun.env.ADMIN_USER || "admin",
  adminPassword: Bun.env.ADMIN_PASSWORD || null,
};

/** The public hardhat/anvil mnemonic: every address derived from it is known. */
const PUBLIC_TEST_MNEMONIC = "test test test test test test test test test test test junk";

/**
 * Validates the environment once, at process start, and exits rather than
 * failing later inside a request or a worker tick.
 *
 * Called only from src/index.ts: importing this module must stay side-effect
 * free so the test scripts can pull in `app` without a full environment.
 */
export function preflight(): void {
  const missing = [
    !Bun.env.DATABASE_URL && "DATABASE_URL",
    !Bun.env.HD_MNEMONIC && "HD_MNEMONIC",
    // /admin is read-only but cross-merchant, and surfaces internals the
    // merchant API deliberately hides. A deployed instance is internet-facing,
    // so it may not serve that console unauthenticated.
    env.isProduction && !env.adminPassword && "ADMIN_PASSWORD",
  ].filter((v): v is string => typeof v === "string");

  if (missing.length) {
    console.error(`[gateway] missing required environment: ${missing.join(", ")}`);
    console.error("[gateway] see .env.example; refusing to start");
    process.exit(1);
  }

  if (env.isProduction && env.mnemonic.trim() === PUBLIC_TEST_MNEMONIC) {
    console.warn(
      "[gateway] HD_MNEMONIC is the public anvil test mnemonic — every derived " +
        "address is spendable by anyone. Testnet only; never point this deployment at mainnet."
    );
  }

  if (!env.isProduction && !env.adminPassword) {
    console.warn("[gateway] /admin is unauthenticated (set ADMIN_PASSWORD to gate it)");
  }

  for (const network of NETWORK_IDS) {
    const key = missingCredential(network);
    if (key) {
      console.warn(`[gateway:${network}] ${key} is not set — this network's workers stay off`);
    }
  }
}

/** EVM token: 0x-hex contract. */
export type EvmTokenDef = { address: `0x${string}`; decimals: number };
/** Tron token: Base58Check ("T...") contract. */
export type TronTokenDef = { address: string; decimals: number };

/**
 * Block-explorer URL templates, `{v}` substituted with the hash/address.
 *
 * Templates rather than a single base URL because the path shape differs per
 * explorer family (Etherscan uses `/tx/:hash`, Tronscan a hash-router
 * `/#/transaction/:hash`), so there is nothing common to concatenate.
 */
export type ExplorerDef = { tx: string; address: string };

export type EvmNetworkDef = {
  family: "evm";
  chain: Chain;
  confirmations: bigint;
  httpRpc: string;
  wsRpc: string;
  /**
   * Name of the environment variable holding this network's RPC key. Kept in the
   * registry so the boot preflight can report a missing key by network without a
   * second mapping to drift out of sync with the URLs above.
   */
  credentialEnv: string;
  explorer: ExplorerDef;
  tokens: Record<string, EvmTokenDef>;
};

/**
 * Tron has no WebSocket log subscription and no viem chain, so it carries an
 * HTTP API base instead of RPC URLs and is polled (see workers/tron-watcher.ts).
 */
export type TronNetworkDef = {
  family: "tron";
  confirmations: bigint;
  apiBase: string;
  explorer: ExplorerDef;
  tokens: Record<string, TronTokenDef>;
};

export type NetworkDef = EvmNetworkDef | TronNetworkDef;

// Registry of networks and tokens supported in the MVP.
// Verify testnet token addresses against Circle's docs (faucet.circle.com)
// before use; they can change.
export const NETWORKS = {
  "eth-sepolia": {
    family: "evm",
    chain: sepolia,
    confirmations: 5n,
    httpRpc: `https://eth-sepolia.g.alchemy.com/v2/${Bun.env.ALCHEMY_SEPOLIA_KEY}`,
    wsRpc: `wss://eth-sepolia.g.alchemy.com/v2/${Bun.env.ALCHEMY_SEPOLIA_KEY}`,
    credentialEnv: "ALCHEMY_SEPOLIA_KEY",
    explorer: {
      tx: "https://sepolia.etherscan.io/tx/{v}",
      address: "https://sepolia.etherscan.io/address/{v}",
    },
    tokens: {
      USDC: { address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", decimals: 6 },
    },
  },
  "base-sepolia": {
    family: "evm",
    chain: baseSepolia,
    confirmations: 3n,
    httpRpc: `https://base-sepolia.g.alchemy.com/v2/${Bun.env.ALCHEMY_BASE_SEPOLIA_KEY}`,
    wsRpc: `wss://base-sepolia.g.alchemy.com/v2/${Bun.env.ALCHEMY_BASE_SEPOLIA_KEY}`,
    credentialEnv: "ALCHEMY_BASE_SEPOLIA_KEY",
    explorer: {
      tx: "https://sepolia.basescan.org/tx/{v}",
      address: "https://sepolia.basescan.org/address/{v}",
    },
    tokens: {
      USDC: { address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6 },
    },
  },
  // Tron Nile testnet. Blocks are ~3s and a block is irreversible after ~19
  // (SR consensus), which is what `confirmations` encodes here.
  // Faucet (test TRX + test USDT): https://nileex.io/join/getJoinPage
  "tron-nile": {
    family: "tron",
    confirmations: 19n,
    apiBase: "https://nile.trongrid.io",
    explorer: {
      tx: "https://nile.tronscan.org/#/transaction/{v}",
      address: "https://nile.tronscan.org/#/address/{v}",
    },
    tokens: {
      // Verified on-chain: symbol()="USDT", decimals()=6.
      USDT: { address: "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf", decimals: 6 },
    },
  },
} satisfies Record<string, NetworkDef>;

export type NetworkId = keyof typeof NETWORKS;

/** Every asset symbol quotable across the registry (for request validation). */
export const ASSETS = [
  ...new Set(Object.values(NETWORKS).flatMap((n) => Object.keys(n.tokens))),
] as [string, ...string[]];

export const NETWORK_IDS = Object.keys(NETWORKS) as [NetworkId, ...NetworkId[]];

/**
 * Looks up a token on a network, or undefined if that pairing is unsupported.
 *
 * Indexing `NETWORKS[id].tokens` directly collapses to `never` across the
 * network union (each network declares a different literal token map), so the
 * lookup is centralised here on the shape both families share.
 */
export function tokenFor(
  network: NetworkId,
  asset: string
): { address: string; decimals: number } | undefined {
  const tokens = NETWORKS[network].tokens as Record<
    string,
    { address: string; decimals: number }
  >;
  return tokens[asset];
}

/**
 * The environment variable a network needs but does not have, or null when it is
 * ready to run. Tron always returns null: TronGrid serves the public testnet
 * without a key, so `TRONGRID_API_KEY` raises a rate limit rather than enabling
 * access.
 *
 * A network without its key still accepts payments (the address derives fine and
 * the row is stored), but nothing would ever detect the transfer — so callers use
 * this to leave those workers off and say so once, instead of retrying a URL that
 * cannot succeed.
 */
export function missingCredential(network: NetworkId): string | null {
  const net = NETWORKS[network];
  if (net.family !== "evm") return null;
  return Bun.env[net.credentialEnv] ? null : net.credentialEnv;
}

export const COINGECKO_IDS: Record<string, string> = {
  USDC: "usd-coin",
  USDT: "tether",
  BTC: "bitcoin",
  ETH: "ethereum",
};
