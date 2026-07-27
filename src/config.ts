import { sepolia, baseSepolia } from "viem/chains";
import type { Chain } from "viem";
import { validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { getLogger } from "./observability";

const log = getLogger("config");

export const env = {
  databaseUrl: Bun.env.DATABASE_URL!,
  // Trimmed because BIP-39 hashes the phrase verbatim: a stray leading space
  // derives an entirely different, silently wrong tree.
  mnemonic: (Bun.env.HD_MNEMONIC ?? "").trim(),
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
  // The bootstrap console operator (see src/services/admin-auth.ts). The account
  // is created on boot and its password kept in step with this variable, so the
  // environment stays the way you recover access to a deployment. Optional in
  // development, required in production — the preflight refuses to boot without
  // it, and without it the console has no account to sign in to at all.
  adminUser: (Bun.env.ADMIN_USER || "samuel").trim().toLowerCase(),
  adminPassword: Bun.env.ADMIN_PASSWORD || null,
  // How long a console sign-in lasts. Short by default: the session is a
  // cross-merchant view of every payment, and an unattended browser should stop
  // being one by the end of the working day.
  adminSessionTtlHours: Number(Bun.env.ADMIN_SESSION_TTL_HOURS ?? 12),
};

/**
 * Mnemonics that ship inside developer tooling and documentation. They are not
 * weak, they are *published*: the private key of every address they derive is
 * one search away, so funds sent to one belong to whoever sweeps first.
 *
 * Generate a private one with `bun run mnemonic:new`.
 */
const PUBLIC_MNEMONICS = new Map([
  ["test test test test test test test test test test test junk", "hardhat/anvil"],
  ["myth like bonus scare over problem client lizard pioneer submit female collect", "ganache"],
  [
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    "BIP-39 test vector",
  ],
]);

/** Where a mnemonic was published, or null when it is not a known public one. */
export function publicMnemonicSource(mnemonic: string = env.mnemonic): string | null {
  return PUBLIC_MNEMONICS.get(mnemonic.trim()) ?? null;
}

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
    // so it may not serve that console unauthenticated — and this is also the
    // password of the operator account the boot creates, so without it there is
    // nobody to sign in as.
    env.isProduction && !env.adminPassword && "ADMIN_PASSWORD",
  ].filter((v): v is string => typeof v === "string");

  if (missing.length) {
    log.fatal("missing required environment — refusing to start", {
      missing,
      hint: "see .env.example",
    });
    process.exit(1);
  }

  // An invalid phrase still derives *a* tree — BIP-39 checksums exist precisely
  // because a typo otherwise produces valid-looking addresses no wallet can
  // restore. Catching it here costs one check; catching it later costs whatever
  // a payer sent to the first address.
  if (!validateMnemonic(env.mnemonic, wordlist)) {
    log.fatal("HD_MNEMONIC is not a valid BIP-39 mnemonic — refusing to start", {
      "wallet.mnemonic_word_count": env.mnemonic.split(/\s+/).filter(Boolean).length,
      hint: "generate one with `bun run mnemonic:new`; quote it in the environment",
    });
    process.exit(1);
  }

  // A published mnemonic is survivable on a testnet, where the funds are
  // worthless and the noise is only confusing (an address arrives with somebody
  // else's history). On a mainnet it is a published private key for every
  // address the gateway hands a payer, so that combination does not boot.
  const publicSeed = publicMnemonicSource();
  const mainnets = NETWORK_IDS.filter((id) => !NETWORKS[id].testnet);
  if (publicSeed && mainnets.length) {
    log.fatal("HD_MNEMONIC is publicly known and this build serves a mainnet — refusing to start", {
      "wallet.mnemonic_source": publicSeed,
      "config.mainnet_networks": mainnets,
      hint: "generate a private mnemonic with `bun run mnemonic:new`",
    });
    process.exit(1);
  }
  if (publicSeed) {
    log.warn(
      "HD_MNEMONIC is a publicly known test mnemonic — every derived address is " +
        "spendable by anyone, and arrives with unrelated history. Testnet only.",
      { "wallet.mnemonic_is_public": true, "wallet.mnemonic_source": publicSeed }
    );
  }

  if (!env.isProduction && !env.adminPassword) {
    log.warn("/admin is unauthenticated — no operator account exists and the console signs nobody in", {
      hint: `set ADMIN_PASSWORD to create the "${env.adminUser}" operator and require sign-in`,
    });
  }

  for (const network of NETWORK_IDS) {
    const key = missingCredential(network);
    if (key) {
      log.warn("network disabled — credential not set", {
        "chain.network": network,
        "config.credential_env": key,
      });
    }
  }

  log.info("configuration validated", configSummary());
}

/**
 * The effective, non-secret configuration.
 *
 * Logged once at boot and served by /admin/api/diagnostics, because most
 * "why did it quote that / why has nothing settled yet" questions are answered
 * by a dial someone set in the environment, and reading the deployment's `.env`
 * is exactly what you cannot do from a test.
 */
export function configSummary() {
  return {
    "config.quote_ttl_min": env.quoteTtlMin,
    "config.grace_ttl_min": env.graceTtlMin,
    "config.spread_bps": Number(env.spreadBps),
    "config.dust_bps": Number(env.dustBps),
    "config.backfill_blocks": Number(env.backfillBlocks),
    "config.log_range_blocks": Number(env.logRangeBlocks),
    "config.backfill_interval_s": env.backfillSec,
    "config.tron_poll_interval_s": env.tronPollSec,
    "config.confirmer_interval_s": env.confirmerSec,
    "config.fallback_usd_cop": env.fallbackUsdCop,
    "config.public_base_url": env.publicBaseUrl,
    "config.admin_authenticated": Boolean(env.adminPassword),
    "config.admin_user": env.adminUser,
    "config.admin_session_ttl_h": env.adminSessionTtlHours,
    "config.trongrid_key": Boolean(env.trongridApiKey),
    "config.networks_enabled": NETWORK_IDS.filter((n) => !missingCredential(n)),
    "config.networks_mainnet": NETWORK_IDS.filter((n) => !NETWORKS[n].testnet),
    // Not the mnemonic and not its fingerprint — only whether this deployment is
    // deriving from a seed anyone can look up, which is the first question to
    // ask of an address that behaves strangely.
    "wallet.mnemonic_is_public": Boolean(publicMnemonicSource()),
    "config.production": env.isProduction,
  };
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

/**
 * Whether the network's value is play money.
 *
 * Declared per network rather than inferred from the chain object because it
 * gates a safety check, and the preflight has to be able to say "this build can
 * serve a mainnet" about a network whose RPC key is absent — such a network
 * still accepts payments and still derives addresses (see `missingCredential`).
 */
type NetworkRealm = { testnet: boolean };

export type EvmNetworkDef = NetworkRealm & {
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
export type TronNetworkDef = NetworkRealm & {
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
    testnet: true,
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
    testnet: true,
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
    testnet: true,
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
