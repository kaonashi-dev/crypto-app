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

  // -- Sweeping (docs/SWEEPING-PLAN.md) --------------------------------
  //
  // Consolidating per-payment deposit addresses into one treasury. Off by
  // default, and the two switches are not the same switch:
  //
  //   SWEEP_ENABLED=false            the worker never starts. Nothing is
  //                                  planned, signed or written. This is today's
  //                                  behaviour — funds accumulate at the leaves.
  //   SWEEP_ENABLED + SWEEP_DRY_RUN  candidates are selected and recorded as
  //                                  `planned` rows with their reasons. Nothing
  //                                  is ever signed. Safe anywhere.
  //   SWEEP_ENABLED only             full execution: authorize, broadcast,
  //                                  confirm.
  //
  // Sweeping cannot corrupt settlement in any of these modes — settlement is
  // event-sourced from Transfer logs and never reads a balance — but dry-run is
  // how that gets demonstrated before the first signature.
  sweepEnabled: /^(1|true|yes)$/i.test(Bun.env.SWEEP_ENABLED ?? ""),
  sweepDryRun: !/^(0|false|no)$/i.test(Bun.env.SWEEP_DRY_RUN ?? "true"),
  sweepIntervalSec: Number(Bun.env.SWEEP_INTERVAL_SEC ?? 120),
  // Floor, in USD, below which value is left to accumulate. Converted per
  // (network, asset) through the same rate service that prices a quote, because
  // the floor is about value and the column is about raw units.
  sweepMinUsd: Number(Bun.env.SWEEP_MIN_USD ?? 5),
  // Refuse a sweep whose estimated fee exceeds this share of what it moves.
  // The load-bearing economic test: 200 bps = 2%.
  sweepMaxCostBps: BigInt(Bun.env.SWEEP_MAX_COST_BPS ?? 200),
  // Global override of the per-network `sweepGasCeilingGwei` in the registry.
  // Unset = each network keeps its own figure.
  sweepGasCeilingGwei: Bun.env.SWEEP_GAS_CEILING_GWEI
    ? Number(Bun.env.SWEEP_GAS_CEILING_GWEI)
    : null,
  // Matches the webhook dead-letter convention (see /admin/api/stats).
  sweepMaxAttempts: Number(Bun.env.SWEEP_MAX_ATTEMPTS ?? 8),
  // Headroom on a native sweep, which is inherently racy: the fee is subtracted
  // from the very balance being moved, and the gas price can rise between the
  // estimate and inclusion. A small residue left behind is normal, not an error.
  sweepNativeHeadroomBps: BigInt(Bun.env.SWEEP_NATIVE_HEADROOM_BPS ?? 500),
  // How long a signed EIP-3009 authorization stays valid. Long by design: a
  // crash-recovery rebroadcast re-signs the *stored* nonce and must still be
  // accepted, and an authorization that expired mid-flight would force a new
  // nonce and a second on-chain attempt. Persisting one is safe — its only
  // possible effect is moving funds to the treasury.
  sweepAuthTtlSec: Number(Bun.env.SWEEP_AUTH_TTL_SEC ?? 86_400),
  // Reconciliation (§9): on-chain balance vs the ledger, per address. Read-only
  // and independently useful — it is what surfaces value that arrived on a chain
  // no watcher covers — so it can run with the sweeper itself switched off.
  sweepReconEnabled: /^(1|true|yes)$/i.test(Bun.env.SWEEP_RECON_ENABLED ?? ""),
  sweepReconIntervalSec: Number(Bun.env.SWEEP_RECON_INTERVAL_SEC ?? 3600),
  // Addresses examined per reconciliation tick. EVM networks batch them through
  // multicall3 (one call per network), Tron costs one call per address, so this
  // bounds the metered cost. A cursor rotates through the rest on later ticks;
  // what a tick did not reach is logged rather than silently dropped.
  sweepReconMaxAddresses: Number(Bun.env.SWEEP_RECON_MAX_ADDRESSES ?? 200),
  // Where swept value lands. One per family, snapshotted onto every sweep row at
  // plan time so a later change cannot rewrite history. The gateway never holds
  // a key for these — they are destinations, never sources.
  treasuryEvm: (Bun.env.TREASURY_ADDRESS_EVM ?? "").trim() || null,
  treasuryTron: (Bun.env.TREASURY_ADDRESS_TRON ?? "").trim() || null,
  // Which `Signer` implementation holds the deposit keys (§5, §10). `local`
  // derives them in-process from HD_MNEMONIC, which is appropriate for a testnet
  // and unacceptable for real value: it gives an always-on process the ability
  // to sign movements of money. `remote` is the KMS/HSM/MPC seam, and the
  // preflight below is what makes the distinction binding rather than advisory.
  sweepSigner: (Bun.env.SWEEP_SIGNER ?? "local").trim().toLowerCase(),
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

  preflightSweeping(mainnets);

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
 * Base58Check is not decoded here — the codec lives with the Tron client, and
 * importing it would make this module depend on a service. A typo'd address is
 * what this catches; `treasuryFor()` in services/sweeper.ts re-checks the
 * checksum before a single sweep is planned, so a value that passes here and
 * fails there disables that family rather than sending anywhere.
 */
const TRON_ADDRESS_SHAPE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const EVM_ADDRESS_SHAPE = /^0x[0-9a-fA-F]{40}$/;

/**
 * The sweeping half of the preflight (docs/SWEEPING-PLAN.md §7.1, §10).
 *
 * Two things are enforced, and only when sweeping is actually switched on:
 *
 * 1. A served family has somewhere to sweep *to*. Planning a sweep with no
 *    treasury address would write ledger rows pointing nowhere.
 * 2. Real value is never signed for by an in-process key. This reuses the
 *    mechanism directly above — a build that serves a mainnet is already the
 *    thing that arms the public-seed check — so the custody boundary in §10 is
 *    enforced by construction rather than by policy. Dry-run is exempt: it
 *    plans and logs, and never reaches a signature.
 */
function preflightSweeping(mainnets: NetworkId[]): void {
  if (!env.sweepEnabled) return;

  const families = new Set(NETWORK_IDS.map((id) => NETWORKS[id].family));
  const treasuries: Array<{ name: string; value: string | null; shape: RegExp }> = [
    ...(families.has("evm")
      ? [{ name: "TREASURY_ADDRESS_EVM", value: env.treasuryEvm, shape: EVM_ADDRESS_SHAPE }]
      : []),
    ...(families.has("tron")
      ? [{ name: "TREASURY_ADDRESS_TRON", value: env.treasuryTron, shape: TRON_ADDRESS_SHAPE }]
      : []),
  ];

  const bad = treasuries
    .filter((t) => !t.value || !t.shape.test(t.value))
    .map((t) => (t.value ? `${t.name} (malformed)` : `${t.name} (unset)`));

  if (bad.length) {
    log.fatal("SWEEP_ENABLED is set but the treasury is not usable — refusing to start", {
      "sweep.treasury_problems": bad,
      "config.families_served": [...families],
      hint: "set a treasury address per served family, or unset SWEEP_ENABLED",
    });
    process.exit(1);
  }

  if (!env.sweepDryRun && env.sweepSigner === "local" && mainnets.length) {
    log.fatal(
      "SWEEP_ENABLED with a served mainnet and an in-process signer — refusing to start",
      {
        "sweep.signer": env.sweepSigner,
        "config.mainnet_networks": mainnets,
        hint:
          "an always-on process may not hold keys that move real value: set " +
          "SWEEP_SIGNER=remote, or keep SWEEP_DRY_RUN on, or unset ENABLE_MAINNETS",
      }
    );
    process.exit(1);
  }

  if (env.sweepDryRun) {
    log.info("sweeper is in dry run — candidates are planned and recorded, never signed", {
      "sweep.dry_run": true,
    });
  }
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
    // Sweeping. The treasury addresses themselves are not secret, but they are
    // omitted here in favour of the pairings that can actually move: "which
    // (network, asset) will this build consolidate" is the operational question,
    // and it is answered by the registry rather than by the environment.
    "sweep.enabled": env.sweepEnabled,
    "sweep.dry_run": env.sweepDryRun,
    "sweep.signer": env.sweepSigner,
    "sweep.interval_s": env.sweepIntervalSec,
    "sweep.min_usd": env.sweepMinUsd,
    "sweep.max_cost_bps": Number(env.sweepMaxCostBps),
    "sweep.native_headroom_bps": Number(env.sweepNativeHeadroomBps),
    "sweep.max_attempts": env.sweepMaxAttempts,
    "sweep.auth_ttl_s": env.sweepAuthTtlSec,
    "sweep.gas_ceiling_gwei": env.sweepGasCeilingGwei,
    "sweep.recon_enabled": env.sweepReconEnabled,
    "sweep.recon_interval_s": env.sweepReconIntervalSec,
    "sweep.treasury_evm_set": Boolean(env.treasuryEvm),
    "sweep.treasury_tron_set": Boolean(env.treasuryTron),
    "sweep.pairings": sweepablePairings(),
  };
}

/**
 * Every (network, asset) this build is able to consolidate, as
 * `network/ASSET:mechanism`.
 *
 * The answer to "why has nothing swept" is almost always that a pairing has no
 * mechanism in the registry, so it is reported next to the switches rather than
 * left to be inferred from them.
 */
export function sweepablePairings(): string[] {
  return NETWORK_IDS.flatMap((id) => {
    const net = NETWORKS[id];
    const assets = [...Object.keys(net.tokens), ...(net.native ? [net.native.symbol] : [])];
    return assets.flatMap((asset) => {
      const how = sweepFor(id, asset);
      return how ? [`${id}/${asset}:${how.via}`] : [];
    });
  });
}

/**
 * How value leaves a deposit address — see §4 of docs/SWEEPING-PLAN.md.
 *
 * A deposit address is an EOA holding only a token, and moving an ERC-20 out of
 * one normally needs native gas *at that address*. Which escape hatch applies is
 * a property of the contract, so it is declared here beside the contract rather
 * than kept as a lookup table inside the sweeper: adding a network cannot then
 * silently inherit another network's assumption, and "what can we consolidate"
 * is answered by reading the registry.
 *
 *  - `eip3009`  the holder signs an authorization off-chain and a relayer pays
 *               the gas. One transaction, nothing needed at the leaf.
 *  - `prefund`  no authorization scheme: send gas, then transfer. Two
 *               transactions, and leftover gas dust stays at the address.
 *  - `delegate` Tron. Energy is delegated to the address, spent, and reclaimed;
 *               the staked TRX is lent rather than consumed.
 *  - `native`   the chain's own coin, where the value *is* the gas.
 *
 * The EIP-712 domain is optional and normally absent: it is read from the
 * contract and cross-checked against `DOMAIN_SEPARATOR()` at runtime, because a
 * wrong domain produces a signature that fails on-chain after a ledger row has
 * already been written. Set it only to pin a deployment whose `name()`/
 * `version()` cannot be trusted. `scripts/sweep-probe.ts` reports both.
 */
export type SweepVia =
  | { via: "eip3009"; domain?: { name: string; version: string } }
  | { via: "prefund" }
  | { via: "delegate" }
  | { via: "native" };

/** EVM token: 0x-hex contract. */
export type EvmTokenDef = {
  address: `0x${string}`;
  decimals: number;
  /** How value leaves a deposit address. Absent = never swept. */
  sweep?: SweepVia;
};
/** Tron token: Base58Check ("T...") contract. */
export type TronTokenDef = {
  address: string;
  decimals: number;
  /** How value leaves a deposit address. Absent = never swept. */
  sweep?: SweepVia;
};

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
export type NativeAssetDef = {
  symbol: string;
  decimals: number;
  /**
   * How value leaves a deposit address. Always `native` where it is set: the
   * coin pays its own gas, so the sweep is `balance − fee` and needs no contract
   * capability at all. Absent = never swept.
   */
  sweep?: SweepVia;
};

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
  /**
   * Above this gas price the sweeper defers rather than executes (§7). A hard
   * ceiling on top of the value-relative `SWEEP_MAX_COST_BPS` test, because a
   * large enough balance would otherwise justify paying a spike.
   *
   * Per network and therefore in the registry, not the environment: what counts
   * as expensive is a property of the chain. `SWEEP_GAS_CEILING_GWEI` overrides
   * every network at once when one is set.
   *
   * Note this is the *fee* currency, which is not always an asset the gateway
   * accepts — Sepolia and Base quote stablecoins and never ETH, but ETH is still
   * what a sweep there costs. Read it from `chain.nativeCurrency`, never from
   * `native`.
   */
  sweepGasCeilingGwei?: number;
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
      // Circle FiatToken. `scripts/sweep-probe.ts` confirms EIP-3009 on-chain
      // (authorizationState answers) and verifies the EIP-712 domain
      // name="USDC" version="2" against the contract's DOMAIN_SEPARATOR().
      // The domain is left unpinned so the sweeper re-derives and re-checks it
      // at runtime rather than trusting a value copied into this file.
      USDC: {
        address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
        decimals: 6,
        sweep: { via: "eip3009" },
      },
    },
    // Sepolia ETH is not accepted: this gateway quotes stablecoins here.
    native: null,
    sweepGasCeilingGwei: 50,
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
      // Also a Circle FiatToken and so almost certainly EIP-3009 — but `sweep`
      // is deliberately absent because the probe could not reach this network
      // to confirm it (the Alchemy app has Base Sepolia switched off). An
      // unverified capability is exactly what §4.2 of the sweeping plan refuses
      // to act on, so this pairing is simply never swept until
      // `bun run scripts/sweep-probe.ts --network base-sepolia` says otherwise.
      USDC: { address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6 },
    },
    native: null,
    sweepGasCeilingGwei: 5,
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
      // No `sweep`: unprobed, because this network has no RPC credential here.
      USDT: { address: "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd", decimals: 18 },
      // Verified on-chain: symbol()="USDC", decimals()=18.
      USDC: { address: "0x64544969ed7EBf5f083679233325356EbE738930", decimals: 18 },
    },
    // The coin needs no contract capability: a native sweep is balance − fee.
    native: { symbol: "BNB", decimals: 18, sweep: { via: "native" } },
    sweepGasCeilingGwei: 10,
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
      // No `sweep`: unprobed, because this network has no RPC credential here.
      USDC: { address: "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582", decimals: 6 },
    },
    native: { symbol: "POL", decimals: 18, sweep: { via: "native" } },
    sweepGasCeilingGwei: 200,
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
      // Neither carries a `sweep`: they are unprobed, and a mainnet pairing may
      // not acquire one from inference. Binance-Peg tokens are not Circle
      // FiatTokens and are not expected to implement EIP-3009, so `prefund` is
      // the likely answer — which the probe has to establish, not this comment.
      USDT: { address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18 },
      USDC: { address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18 },
    },
    native: { symbol: "BNB", decimals: 18, sweep: { via: "native" } },
    sweepGasCeilingGwei: 5,
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
      // Unprobed, so no `sweep` — see the note on the BSC tokens above.
      USDC: { address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6 },
      // Tether on Polygon, 6 decimals. Its symbol() now reads "USDT0" after the
      // migration to the omnichain deployment; it is quoted and displayed here
      // as USDT, which is what a payer's wallet shows.
      USDT: { address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6 },
    },
    native: { symbol: "POL", decimals: 18, sweep: { via: "native" } },
    sweepGasCeilingGwei: 300,
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
      // Verified on-chain: symbol()="USDT", decimals()=6. The probe confirms it
      // implements no EIP-3009 (`authorizationState` reverts), which is the
      // normal TRC-20 answer — so value leaves by delegating energy to the
      // deposit address rather than by an off-chain authorization.
      USDT: {
        address: "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf",
        decimals: 6,
        sweep: { via: "delegate" },
      },
    },
    // TRX is quoted in sun: 6 decimals, like the TRC-20s beside it.
    native: { symbol: "TRX", decimals: 6, sweep: { via: "native" } },
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
 * How value leaves a deposit address for this pairing, or undefined when the
 * pairing is not sweepable (§4.5 of docs/SWEEPING-PLAN.md).
 *
 * Undefined is the safe default and the common one: a pairing acquires a
 * mechanism only after `scripts/sweep-probe.ts` has confirmed it against the
 * contract. Everything else simply accumulates, exactly as it does today.
 */
export function sweepFor(network: NetworkId, asset: string): SweepVia | undefined {
  const net = NETWORKS[network];
  if (net.native && net.native.symbol === asset) return net.native.sweep;
  const tokens = net.tokens as Record<string, { sweep?: SweepVia }>;
  return tokens[asset]?.sweep;
}

/**
 * The currency a transaction fee is paid in on this network.
 *
 * Not the same question as `native`, and the two must not be conflated in either
 * direction:
 *
 *  - `native` is the chain's coin *as a payment asset the gateway accepts*, and
 *    it is null on Sepolia and Base, which quote stablecoins only. Those chains
 *    still charge ETH for gas, so a sweep cost there is denominated in a coin
 *    with no entry in `tokens` or `native` at all.
 *  - `chain.nativeCurrency` always names the fee currency, but names it as the
 *    *chain* does — and a testnet renames it. viem reports BSC testnet's coin as
 *    `tBNB`, which no price feed has ever heard of, so pricing a sweep against
 *    it silently fails and every BNB sweep defers as `unpriceable` forever.
 *
 * So: prefer the registry's own name for the coin when there is one, since it is
 * the mainnet name the rate service can actually quote, and fall back to viem
 * only where the gateway has not named it. Both describe the same coin; this
 * picks the source that can be priced.
 *
 * A testnet coin priced at its mainnet rate is fictional in absolute terms, and
 * deliberately so — it is the same arithmetic mainnet will run.
 */
export function gasCoinFor(network: NetworkId): NativeAssetDef {
  const net = NETWORKS[network];
  if (net.family === "tron") return net.native ?? { symbol: "TRX", decimals: 6 };
  return (
    net.native ?? {
      symbol: net.chain.nativeCurrency.symbol,
      decimals: net.chain.nativeCurrency.decimals,
    }
  );
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
