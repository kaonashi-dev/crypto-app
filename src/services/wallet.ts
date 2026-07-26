import { mnemonicToAccount } from "viem/accounts";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { keccak_256 } from "@noble/hashes/sha3";
import { secp256k1 } from "@noble/curves/secp256k1";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { env, NETWORKS, type NetworkId } from "../config";
import { hexToBase58Address, bytesToHex, TRON_ADDRESS_PREFIX } from "./tron";

/** Atomically reserves the next derivation index. */
export async function reserveDerivationIndex(): Promise<number> {
  return db.transaction(async (tx) => {
    const rows = await tx.execute(sql`
      INSERT INTO hd_counter (id, next_index) VALUES (1, 1)
      ON CONFLICT (id) DO UPDATE SET next_index = hd_counter.next_index + 1
      RETURNING next_index - 1 AS idx
    `);
    return Number((rows as unknown as Array<{ idx: number }>)[0]!.idx);
  });
}

/** Derives the address m/44'/60'/0'/0/{index} (EVM standard). */
export function deriveEvmAddress(index: number): `0x${string}` {
  const account = mnemonicToAccount(env.mnemonic, { addressIndex: index });
  return account.address;
}

// Derived once: seed stretching (PBKDF2, 2048 rounds) is deliberately slow.
let tronMaster: HDKey | undefined;
function master(): HDKey {
  tronMaster ??= HDKey.fromMasterSeed(mnemonicToSeedSync(env.mnemonic));
  return tronMaster;
}

/**
 * Derives the address m/44'/195'/0'/0/{index} (Tron's BIP-44 coin type).
 *
 * Same secp256k1 + keccak256 construction as EVM, but the last 20 bytes of the
 * hash get a 0x41 prefix and are Base58Check-encoded rather than hex-encoded.
 */
export function deriveTronAddress(index: number): string {
  const node = master().derive(`m/44'/195'/0'/0/${index}`);
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
  return NETWORKS[network].family === "tron"
    ? deriveTronAddress(index)
    : deriveEvmAddress(index);
}
