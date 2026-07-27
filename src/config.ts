import { sepolia, baseSepolia, bsc, bscTestnet, polygon, polygonAmoy } from "viem/chains";
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
  // Native coins (BNB, POL) emit no Transfer log, so they are found by reading
  // whole blocks — one call per block, no batching possible. This is the span
  // the native backfill re-reads, kept separate from BACKFILL_BLOCKS and much
  // smaller because the cost here is one call per block rather than per chunk.
  nativeBackfillBlocks: BigInt(Bun.env.NATIVE_BACKFILL_BLOCKS ?? 20),
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
  // Whether the mainnet networks in the registry below are actually served.
  //
  // Off by default, and the difference is not cosmetic: an *offered* network is
  // one the API will quote and derive a receiving address on, so registering a
  // mainnet is what turns a published test mnemonic into a published private key
  // for real funds. Turning this on therefore also arms the preflight check that
  // refuses to boot on a known-public seed. A missing RPC key is not a substitute
  // for this flag — a keyless network still hands out addresses, it just never
  // watches them.
  enableMainnets: /^(1|true|yes)$/i.test(Bun.env.ENABLE_MAINNETS ?? ""),
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
      hint:
        "generate a private mnemonic with `bun run mnemonic:new`, or unset " +
        "ENABLE_MAINNETS to serve testnets only",
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
    "config.native_backfill_blocks": Number(env.nativeBackfillBlocks),
    "config.networks_offered": NETWORK_IDS,
    "config.networks_enabled": NETWORK_IDS.filter((n) => !missingCredential(n)),
    "config.networks_mainnet": NETWORK_IDS.filter((n) => !NETWORKS[n].testnet),
    "config.mainnets_enabled": env.enableMainnets,
    // Networks defined but withheld — the answer to "why does the API reject a
    // network that is plainly in config.ts".
    "config.networks_withheld": ALL_NETWORK_IDS.filter((n) => !NETWORK_IDS.includes(n)),
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
 * The chain's own coin (BNB, POL, TRX) — the one asset with no contract behind
 * it.
 *
 * Kept apart from `tokens` rather than given a sentinel address because the
 * difference is not a detail of the definition, it is the detection path: a
 * token transfer is an event a node can filter and push, and a native transfer
 * is a field on the transaction itself, which nothing indexes for you. The two
 * watchers are separate for that reason, and this is the flag that decides
 * whether the second one runs at all.
 */
export type NativeAssetDef = { symbol: string; decimals: number };

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
  /** The chain's own coin, or null when this gateway does not accept it. */
  native: NativeAssetDef | null;
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
  /** The chain's own coin, or null when this gateway does not accept it. */
  native: NativeAssetDef | null;
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
    // Sepolia ETH is not accepted: this gateway quotes stablecoins here.
    native: null,
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
    native: null,
  },
  // BNB Smart Chain testnet (Chapel). Blocks are sub-second since the Maxwell
  // upgrade and fast finality settles a block in two or three, so 12 is already
  // generous; it is kept in that range because the testnet's validator set is
  // small enough to wobble.
  // Faucet (test BNB): https://www.bnbchain.org/en/testnet-faucet
  //
  // Note the decimals: BEP20 USDT and USDC are 18-decimal, unlike the 6-decimal
  // deployments of the same symbols everywhere else in this registry. Nothing
  // may assume 6 — see `copToRaw` and the numeric(78,0) amount columns.
  "bsc-testnet": {
    family: "evm",
    testnet: true,
    chain: bscTestnet,
    confirmations: 12n,
    httpRpc: `https://bnb-testnet.g.alchemy.com/v2/${Bun.env.ALCHEMY_BSC_TESTNET_KEY}`,
    wsRpc: `wss://bnb-testnet.g.alchemy.com/v2/${Bun.env.ALCHEMY_BSC_TESTNET_KEY}`,
    credentialEnv: "ALCHEMY_BSC_TESTNET_KEY",
    explorer: {
      tx: "https://testnet.bscscan.com/tx/{v}",
      address: "https://testnet.bscscan.com/address/{v}",
    },
    tokens: {
      // Verified on-chain: symbol()="USDT", decimals()=18.
      USDT: { address: "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd", decimals: 18 },
      // Verified on-chain: symbol()="USDC", decimals()=18.
      USDC: { address: "0x64544969ed7EBf5f083679233325356EbE738930", decimals: 18 },
    },
    native: { symbol: "BNB", decimals: 18 },
  },
  // Polygon Amoy testnet, the Mumbai replacement.
  // Faucet (test POL): https://faucet.polygon.technology
  //
  // USDC only: Tether publishes no canonical Amoy deployment, so there is no
  // USDT here to point at. The pairing simply does not exist and `tokenFor`
  // rejects it, rather than the registry naming a random test contract.
  "polygon-amoy": {
    family: "evm",
    testnet: true,
    chain: polygonAmoy,
    confirmations: 64n,
    httpRpc: `https://polygon-amoy.g.alchemy.com/v2/${Bun.env.ALCHEMY_AMOY_KEY}`,
    wsRpc: `wss://polygon-amoy.g.alchemy.com/v2/${Bun.env.ALCHEMY_AMOY_KEY}`,
    credentialEnv: "ALCHEMY_AMOY_KEY",
    explorer: {
      tx: "https://amoy.polygonscan.com/tx/{v}",
      address: "https://amoy.polygonscan.com/address/{v}",
    },
    tokens: {
      // Circle's Amoy USDC. Verified on-chain: symbol()="USDC", decimals()=6.
      USDC: { address: "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582", decimals: 6 },
    },
    native: { symbol: "POL", decimals: 18 },
  },
  // -- Mainnets ---------------------------------------------------------
  // Registered but not served unless ENABLE_MAINNETS is set (see NETWORK_IDS).
  // Real value: a payer who scans one of these QR codes sends real funds to an
  // address derived from HD_MNEMONIC, so read the note on `enableMainnets` above
  // before switching them on.
  //
  // BNB Smart Chain. 15 confirmations is the figure the large exchanges credit
  // BEP20 deposits at; fast finality makes it comfortably conservative.
  bsc: {
    family: "evm",
    testnet: false,
    chain: bsc,
    confirmations: 15n,
    httpRpc: `https://bnb-mainnet.g.alchemy.com/v2/${Bun.env.ALCHEMY_BSC_KEY}`,
    wsRpc: `wss://bnb-mainnet.g.alchemy.com/v2/${Bun.env.ALCHEMY_BSC_KEY}`,
    credentialEnv: "ALCHEMY_BSC_KEY",
    explorer: {
      tx: "https://bscscan.com/tx/{v}",
      address: "https://bscscan.com/address/{v}",
    },
    tokens: {
      // Both verified on-chain: 18 decimals, not 6. Binance-Peg USDT is the
      // 0x55d3… contract; USDC is 0x8AC7….
      USDT: { address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18 },
      USDC: { address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18 },
    },
    native: { symbol: "BNB", decimals: 18 },
  },
  // Polygon PoS. Bor produces ~2s blocks and reorgs of a few blocks are routine;
  // Heimdall milestones give deterministic finality well inside 128 blocks
  // (~4 minutes), which is the wait a payer sees here.
  polygon: {
    family: "evm",
    testnet: false,
    chain: polygon,
    confirmations: 128n,
    httpRpc: `https://polygon-mainnet.g.alchemy.com/v2/${Bun.env.ALCHEMY_POLYGON_KEY}`,
    wsRpc: `wss://polygon-mainnet.g.alchemy.com/v2/${Bun.env.ALCHEMY_POLYGON_KEY}`,
    credentialEnv: "ALCHEMY_POLYGON_KEY",
    explorer: {
      tx: "https://polygonscan.com/tx/{v}",
      address: "https://polygonscan.com/address/{v}",
    },
    tokens: {
      // Native-issued Circle USDC (not the bridged USDC.e). Verified on-chain:
      // symbol()="USDC", decimals()=6.
      USDC: { address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6 },
      // Tether on Polygon, 6 decimals. Its symbol() now reads "USDT0" after the
      // migration to the omnichain deployment; it is quoted and displayed here
      // as USDT, which is what a payer's wallet shows.
      USDT: { address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6 },
    },
    native: { symbol: "POL", decimals: 18 },
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
    // TRX is quoted in sun: 6 decimals, like the TRC-20s beside it.
    native: { symbol: "TRX", decimals: 6 },
  },
} satisfies Record<string, NetworkDef>;

export type NetworkId = keyof typeof NETWORKS;

/** Every network in the registry, served or not. */
export const ALL_NETWORK_IDS = Object.keys(NETWORKS) as [NetworkId, ...NetworkId[]];

/**
 * The networks this process actually offers: every testnet, plus the mainnets
 * when ENABLE_MAINNETS is set.
 *
 * This is the list the API validates against, the preflight judges, and the
 * supervisor starts workers for — so a network missing from it cannot be quoted
 * and no address is ever derived on it. Historical rows are still resolvable
 * because `NETWORKS` keeps every definition: a payment taken on a network that
 * was later switched off still renders in the console.
 */
export const NETWORK_IDS = ALL_NETWORK_IDS.filter(
  (id) => NETWORKS[id].testnet || env.enableMainnets
) as [NetworkId, ...NetworkId[]];

/** The chain's own coin on a network, or null when it accepts none. */
export function nativeAssetFor(network: NetworkId): NativeAssetDef | null {
  return NETWORKS[network].native;
}

/**
 * Every asset symbol quotable on a served network (for request validation).
 * Includes the native coins, which have no entry in any `tokens` map.
 */
export const ASSETS = [
  ...new Set(
    NETWORK_IDS.flatMap((id) => {
      const net = NETWORKS[id];
      return [...Object.keys(net.tokens), ...(net.native ? [net.native.symbol] : [])];
    })
  ),
] as [string, ...string[]];

/**
 * Looks up a token on a network, or undefined if that pairing is unsupported.
 *
 * Contract-backed assets only: a native coin has no contract, so this returns
 * undefined for one. The watchers rely on that — `tokens` is exactly the set
 * that can be found by filtering Transfer logs.
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
 * A quotable asset on a network — the one lookup that spans both kinds.
 *
 * Tagged rather than merged into a common shape because every caller has to
 * branch anyway: a native asset has no contract to put in a payment URI, no
 * contract to subscribe to, and no contract to show in the console. Returning
 * `address: null` would let a caller forget; a discriminant does not.
 */
export type AssetRef =
  | { kind: "token"; symbol: string; address: string; decimals: number }
  | { kind: "native"; symbol: string; decimals: number };

export function assetFor(network: NetworkId, asset: string): AssetRef | undefined {
  const native = NETWORKS[network].native;
  if (native && native.symbol === asset) {
    return { kind: "native", symbol: asset, decimals: native.decimals };
  }
  const token = tokenFor(network, asset);
  return token
    ? { kind: "token", symbol: asset, address: token.address, decimals: token.decimals }
    : undefined;
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
  BNB: "binancecoin",
  // The post-rebrand Polygon coin. Not "matic-network", which is still a live
  // CoinGecko id quoting the *old* MATIC token at a different price — picking
  // the wrong one misprices every POL quote without failing anything.
  POL: "polygon-ecosystem-token",
  TRX: "tron",
};
