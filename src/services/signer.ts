/**
 * The key boundary — §5 of docs/SWEEPING-PLAN.md.
 *
 * Every signature the gateway produces goes through this interface, and the key
 * material never crosses it. That is the whole purpose: today the implementation
 * derives in-process from `HD_MNEMONIC`, which is appropriate for a testnet and
 * unacceptable for real value, and the upgrade to KMS/HSM/MPC custody has to be
 * a substitution rather than a rewrite.
 *
 * The rule that makes that true: **no module outside this file may import
 * `derivation.ts` for key purposes.** Address derivation is public and is
 * re-exported by `wallet.ts` for the payment path; `deriveEvmAccount` and
 * `deriveTronKey` are not, and are imported here alone.
 *
 * Two keys exist, and they are deliberately different kinds of thing:
 *
 *  - **deposit** — one per payment, many, individually low-value, and necessarily
 *    able to sign, since that is what releases the funds sitting at them.
 *  - **relayer** — one per family, holds only gas, and pays for sweeps out of
 *    deposit addresses that hold no native balance of their own.
 *
 * The **treasury** key is in neither. The treasury is a destination address, and
 * the gateway never spends from it — so no amount of compromise here reaches the
 * consolidated funds.
 */
import { hashTypedData, keccak256, serializeTransaction, type Hex, type TransactionSerializable, type TypedDataDomain } from "viem";
import { secp256k1 } from "@noble/curves/secp256k1";
import { env } from "../config";
import {
  DEPOSIT_ACCOUNT,
  RELAYER_ACCOUNT,
  deriveEvmAccount,
  deriveTronKey,
  evmPath,
  seedFingerprint,
  tronAddressFromKey,
  tronPath,
} from "./derivation";
import { bytesToHex, hexToBytes } from "./tron";
import { getLogger } from "../observability";

const log = getLogger("signer");

export type Family = "evm" | "tron";

/**
 * Which key to use, by role rather than by path.
 *
 * A reference, never a key: this is what call sites pass around, and what a
 * remote signer would resolve to a KMS key id instead of to a BIP-32 node.
 */
export type KeyRef =
  | { role: "deposit"; family: Family; index: number }
  | { role: "relayer"; family: Family };

export type TypedDataPayload = {
  domain: TypedDataDomain;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
};

export interface Signer {
  /** The address for a key reference, without exposing the key. */
  addressFor(ref: KeyRef): Promise<string>;
  /** EIP-712 typed-data signature — the EIP-3009 authorization path. */
  signTypedData(ref: KeyRef, payload: TypedDataPayload): Promise<Hex>;
  /** A serialized, signed EVM transaction, ready for `eth_sendRawTransaction`. */
  signTransaction(ref: KeyRef, tx: TransactionSerializable): Promise<Hex>;
  /**
   * A recoverable signature over a 32-byte digest, for Tron.
   *
   * Blind by construction — the digest arrives already computed — so the caller
   * carries the obligation to have derived it from a transaction it built
   * itself. `services/tron-sweep.ts` recomputes the txID from `raw_data_hex` and
   * refuses to sign a node's response that does not match; that check is what
   * keeps this primitive safe to expose.
   */
  signDigest(ref: KeyRef, digest: Hex): Promise<Hex>;
  /**
   * The BIP-32 master fingerprint of the tree these keys come from.
   *
   * Must equal `hd_counter.seed_fingerprint` or the caller refuses to proceed:
   * signing for a derivation index issued by a *different* mnemonic would
   * produce a valid signature from the wrong account entirely.
   */
  fingerprint(): Promise<string>;
}

function describe(ref: KeyRef): Record<string, unknown> {
  return {
    "signer.role": ref.role,
    "chain.family": ref.family,
    ...(ref.role === "deposit" ? { "wallet.derivation_index": ref.index } : {}),
    "wallet.derivation_path":
      ref.family === "tron"
        ? tronPath(ref.role === "deposit" ? ref.index : 0, accountOf(ref))
        : evmPath(ref.role === "deposit" ? ref.index : 0, accountOf(ref)),
  };
}

const accountOf = (ref: KeyRef) =>
  ref.role === "relayer" ? RELAYER_ACCOUNT : DEPOSIT_ACCOUNT;
const indexOf = (ref: KeyRef) => (ref.role === "deposit" ? ref.index : 0);

/**
 * Keys derived in-process from `HD_MNEMONIC`.
 *
 * Testnet only, and that is enforced rather than documented: `preflight()`
 * refuses to boot a build that pairs this signer with a served mainnet and live
 * sweeping (see `preflightSweeping` in config.ts).
 */
export class LocalSigner implements Signer {
  async addressFor(ref: KeyRef): Promise<string> {
    return ref.family === "tron"
      ? tronAddressFromKey(deriveTronKey(indexOf(ref), accountOf(ref)))
      : deriveEvmAccount(indexOf(ref), accountOf(ref)).address;
  }

  async signTypedData(ref: KeyRef, payload: TypedDataPayload): Promise<Hex> {
    if (ref.family !== "evm") throw new Error("typed-data signing is EVM only");
    const account = deriveEvmAccount(indexOf(ref), accountOf(ref));
    // The digest is logged, never the signature: it identifies which
    // authorization was produced without being one.
    log.debug("typed data signed", {
      ...describe(ref),
      "signer.typed_data_digest": hashTypedData(payload as never),
    });
    return account.signTypedData(payload as never);
  }

  async signTransaction(ref: KeyRef, tx: TransactionSerializable): Promise<Hex> {
    if (ref.family !== "evm") throw new Error("transaction signing here is EVM only");
    const account = deriveEvmAccount(indexOf(ref), accountOf(ref));
    const signed = await account.signTransaction(tx);
    log.debug("transaction signed", {
      ...describe(ref),
      "chain.tx_hash": keccak256(signed),
      "chain.tx_type": tx.type ?? "eip1559",
    });
    return signed;
  }

  async signDigest(ref: KeyRef, digest: Hex): Promise<Hex> {
    if (ref.family !== "tron") throw new Error("digest signing is Tron only");
    const key = deriveTronKey(indexOf(ref), accountOf(ref));
    const signature = secp256k1.sign(hexToBytes(digest), key);
    // Tron expects r ‖ s ‖ v with v as a bare recovery id (0/1), not 27/28.
    const compact = signature.toCompactRawBytes();
    const out = new Uint8Array(65);
    out.set(compact, 0);
    out[64] = signature.recovery;
    log.debug("digest signed", { ...describe(ref), "signer.digest": digest });
    return `0x${bytesToHex(out)}`;
  }

  async fingerprint(): Promise<string> {
    return seedFingerprint();
  }
}

/**
 * The signer this build uses.
 *
 * `SWEEP_SIGNER=remote` is the seam Phase 6 fills with a KMS/HSM/MPC client. It
 * is rejected loudly rather than silently falling back to the local one: a
 * deployment that asked for remote custody and got in-process keys instead is
 * the exact failure the setting exists to prevent.
 */
let cached: Signer | null = null;
export function getSigner(): Signer {
  if (cached) return cached;
  if (env.sweepSigner !== "local") {
    throw new Error(
      `SWEEP_SIGNER=${env.sweepSigner} is not implemented — only "local" exists today ` +
        `(remote custody is Phase 6 of docs/SWEEPING-PLAN.md)`
    );
  }
  cached = new LocalSigner();
  return cached;
}

/** Replaces the process signer. Tests only — `scripts/sweep-test.ts` uses a mock. */
export function setSigner(signer: Signer | null): void {
  cached = signer;
}

/**
 * Serializes an unsigned transaction the way `signTransaction` will, so a caller
 * can compute the hash of what it is about to broadcast.
 */
export const serializeUnsigned = (tx: TransactionSerializable) => serializeTransaction(tx);
