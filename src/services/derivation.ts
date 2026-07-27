/**
 * HD key derivation. Pure: no database, no network, no clock.
 *
 * Split from wallet.ts (which owns the database-backed index reservation) so
 * that generating and inspecting a tree works before a deployment has a
 * database — importing wallet.ts opens the connection pool, and the mnemonic
 * generator has to run before any of that exists.
 */
import { mnemonicToAccount } from "viem/accounts";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { keccak_256 } from "@noble/hashes/sha3";
import { secp256k1 } from "@noble/curves/secp256k1";
import { env, NETWORKS, type NetworkId } from "../config";
import { hexToBase58Address, bytesToHex, TRON_ADDRESS_PREFIX } from "./tron";
import { getLogger } from "../observability";

const log = getLogger("wallet");

/**
 * Master keys, memoised per mnemonic: seed stretching (PBKDF2, 2048 rounds) is
 * deliberately slow, and the gateway derives an address per payment.
 *
 * The map is keyed by the mnemonic itself, which is already in memory as
 * `env.mnemonic`; it holds one entry in the process and a handful in the
 * generator, which feeds it throwaway candidates.
 */
const masters = new Map<string, HDKey>();
function master(mnemonic: string): HDKey {
  let key = masters.get(mnemonic);
  if (!key) {
    key = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic));
    masters.set(mnemonic, key);
  }
  return key;
}

/**
 * The BIP-32 master fingerprint, as 8 hex characters.
 *
 * The first four bytes of hash160(master *public* key): standard, stable, and
 * safe to log or store because it identifies a tree without narrowing the seed.
 * It is what lets the database recognise the mnemonic that issued its
 * derivation indexes (see wallet.ts).
 */
export function seedFingerprint(mnemonic: string = env.mnemonic): string {
  return master(mnemonic).fingerprint.toString(16).padStart(8, "0");
}

/** Derives the address m/44'/60'/0'/0/{index} (EVM standard). */
export function deriveEvmAddress(index: number, mnemonic: string = env.mnemonic): `0x${string}` {
  return mnemonicToAccount(mnemonic, { addressIndex: index }).address;
}

/**
 * Derives the address m/44'/195'/0'/0/{index} (Tron's BIP-44 coin type).
 *
 * Same secp256k1 + keccak256 construction as EVM, but the last 20 bytes of the
 * hash get a 0x41 prefix and are Base58Check-encoded rather than hex-encoded.
 */
export function deriveTronAddress(index: number, mnemonic: string = env.mnemonic): string {
  const node = master(mnemonic).derive(`m/44'/195'/0'/0/${index}`);
  if (!node.privateKey) throw new Error(`No private key at Tron index ${index}`);

  // Uncompressed public key is 65 bytes; drop the leading 0x04 tag.
  const pubkey = secp256k1.getPublicKey(node.privateKey, false).slice(1);
  const hash = keccak_256(pubkey);

  const address = new Uint8Array(21);
  address[0] = TRON_ADDRESS_PREFIX;
  address.set(hash.slice(-20), 1);
  return hexToBase58Address(bytesToHex(address));
}

/** Derives the receiving address for a payment on the given network. */
export function deriveAddress(index: number, network: NetworkId): string {
  const family = NETWORKS[network].family;
  const started = performance.now();
  const address = family === "tron" ? deriveTronAddress(index) : deriveEvmAddress(index);
  // The derivation path is logged, not the key: an address that receives nothing
  // is usually a path/coin-type question, and this is the line that answers it.
  log.debug("address derived", {
    "wallet.derivation_index": index,
    "wallet.derivation_path": family === "tron" ? `m/44'/195'/0'/0/${index}` : `m/44'/60'/0'/0/${index}`,
    "wallet.seed_fingerprint": seedFingerprint(),
    "chain.network": network,
    "chain.family": family,
    "payment.address": address,
    duration_ms: Math.round((performance.now() - started) * 100) / 100,
  });
  return address;
}
