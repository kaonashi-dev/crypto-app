/**
 * EVM sweep execution — §4.2, §4.4 and §6.3 of docs/SWEEPING-PLAN.md.
 *
 * Two mechanisms live here because they share a chain client, a fee model and
 * the relayer's nonce queue:
 *
 *  - **eip3009** — the deposit address signs a `transferWithAuthorization`
 *    message off-chain. No gas, no native balance and no account nonce are
 *    consumed at that address; a relayer submits it and pays. One transaction,
 *    nothing stranded at the leaf.
 *  - **native** — the chain's own coin, where the value *is* the gas, so the
 *    deposit address sends its own transaction for `balance − fee`.
 *
 * Nothing here touches `payments` or `deposits`. It reads the chain and writes
 * only to `sweeps`.
 */
import {
  createPublicClient,
  encodeFunctionData,
  hashDomain,
  http,
  parseAbi,
  type Hex,
  type PublicClient,
  type TransactionSerializable,
} from "viem";
import { NETWORKS, env, gasCoinFor, type EvmNetworkDef, type NetworkId } from "../config";
import { getSigner, type KeyRef } from "./signer";
import { getLogger, count } from "../observability";

const log = getLogger("sweeper");

const ABI = parseAbi([
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)",
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function balanceOf(address account) view returns (uint256)",
]);

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

const clients = new Map<NetworkId, PublicClient>();
export function clientFor(network: NetworkId): PublicClient {
  let client = clients.get(network);
  if (!client) {
    const net = NETWORKS[network] as EvmNetworkDef;
    client = createPublicClient({ chain: net.chain, transport: http(net.httpRpc) }) as PublicClient;
    clients.set(network, client);
  }
  return client;
}

// -- EIP-712 domain ----------------------------------------------------

type Domain = { name: string; version: string; chainId: number; verifyingContract: Hex };

/**
 * Resolved domains, and the pairings that failed to resolve one.
 *
 * A failure is cached as `null` deliberately: a domain that does not verify
 * means every signature we could produce for that pairing would be rejected
 * on-chain, so the right behaviour is to stop trying rather than to re-probe on
 * every tick and keep writing ledger rows that cannot settle.
 */
const domains = new Map<string, Domain | null>();

/**
 * The contract's EIP-712 domain, cross-checked against its own
 * `DOMAIN_SEPARATOR()`.
 *
 * Deployments genuinely differ — `name()` reads "USD Coin" on some chains and
 * "USDC" on others, `version()` is "1" or "2" — and a wrong domain produces a
 * signature that fails *after* a ledger row has been written. So the domain is
 * read from the chain, assembled, and compared with what the contract itself
 * computes. A mismatch disables the pairing and logs at error; it never signs.
 *
 * Resolution order is §4.2's: ERC-5267 `eip712Domain()` if present (one call,
 * authoritative), else `name()` + `version()`, else the registry's pinned value.
 */
export async function resolveDomain(
  network: NetworkId,
  asset: string,
  token: Hex,
  pinned?: { name: string; version: string }
): Promise<Domain | null> {
  const key = `${network}/${asset}`;
  const hit = domains.get(key);
  if (hit !== undefined) return hit;

  const net = NETWORKS[network] as EvmNetworkDef;
  const client = clientFor(network);
  const read = <T>(functionName: string, args: unknown[] = []) =>
    client
      .readContract({ address: token, abi: ABI, functionName, args } as never)
      .then((v) => v as T)
      .catch(() => null);

  let name = pinned?.name ?? null;
  let version = pinned?.version ?? null;
  let source = pinned ? "registry" : "";

  if (!name) {
    const five = await read<
      readonly [Hex, string, string, bigint, Hex, Hex, readonly bigint[]]
    >("eip712Domain");
    if (five) {
      [, name, version] = five;
      source = "eip712Domain()";
    } else {
      [name, version] = await Promise.all([read<string>("name"), read<string>("version")]);
      source = "name()+version()";
    }
  }

  const onChain = await read<Hex>("DOMAIN_SEPARATOR");
  // Without the contract's own separator there is nothing to check against, and
  // an unverified domain is exactly what this function exists to refuse.
  if (!name || !onChain) {
    log.error("EIP-712 domain unverifiable — sweeping disabled for this pairing", {
      "chain.network": network,
      "sweep.asset": asset,
      "token.address": token,
      "sweep.domain_source": source || "none",
      "sweep.domain_name": name,
      "sweep.domain_separator_readable": Boolean(onChain),
    });
    count("sweeps.domain_failures", { network, asset });
    domains.set(key, null);
    return null;
  }

  // `version()` is optional in practice, so both common values are tried rather
  // than the pairing being abandoned for the sake of one string.
  for (const candidate of version ? [version] : ["1", "2"]) {
    const domain: Domain = {
      name,
      version: candidate,
      chainId: net.chain.id,
      verifyingContract: token,
    };
    const local = hashDomain({
      domain: { ...domain, chainId: BigInt(domain.chainId) },
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
      },
    });
    if (local.toLowerCase() === onChain.toLowerCase()) {
      log.info("EIP-712 domain verified against DOMAIN_SEPARATOR()", {
        "chain.network": network,
        "sweep.asset": asset,
        "token.address": token,
        "sweep.domain_name": name,
        "sweep.domain_version": candidate,
        "sweep.domain_source": source,
      });
      domains.set(key, domain);
      return domain;
    }
  }

  log.error("EIP-712 domain mismatch — sweeping disabled for this pairing", {
    "chain.network": network,
    "sweep.asset": asset,
    "token.address": token,
    "sweep.domain_name": name,
    "sweep.domain_version": version,
    "sweep.domain_source": source,
    hint: "run `bun run scripts/sweep-probe.ts` and pin the domain in src/config.ts",
  });
  count("sweeps.domain_failures", { network, asset });
  domains.set(key, null);
  return null;
}

/** Test seam: forgets cached domains so a probe can be re-run in one process. */
export function resetDomainCache(): void {
  domains.clear();
}

// -- EIP-3009 ----------------------------------------------------------

export type Authorization = {
  from: Hex;
  to: Hex;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
  signature: Hex;
};

/**
 * Signs a `transferWithAuthorization` for a deposit address.
 *
 * The nonce is an *input*, never generated here: it is persisted before signing
 * (§6.3), which is what makes recovery after a crash reproduce a byte-identical
 * authorization. Generating it at signing time would produce a different one on
 * every retry and lose the guarantee.
 */
export async function signAuthorization(input: {
  network: NetworkId;
  asset: string;
  token: Hex;
  derivationIndex: number;
  from: Hex;
  to: Hex;
  value: bigint;
  nonce: Hex;
  validBefore: Date;
  pinnedDomain?: { name: string; version: string };
}): Promise<Authorization | null> {
  const domain = await resolveDomain(input.network, input.asset, input.token, input.pinnedDomain);
  if (!domain) return null;

  const message = {
    from: input.from,
    to: input.to,
    value: input.value,
    validAfter: 0n,
    validBefore: BigInt(Math.floor(input.validBefore.getTime() / 1000)),
    nonce: input.nonce,
  };

  const ref: KeyRef = { role: "deposit", family: "evm", index: input.derivationIndex };
  const signature = await getSigner().signTypedData(ref, {
    domain: { ...domain, chainId: domain.chainId },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES as never,
    primaryType: "TransferWithAuthorization",
    message,
  });

  return { ...message, signature };
}

/** Calldata for `transferWithAuthorization`, with the signature split into v/r/s. */
export function authorizationCalldata(auth: Authorization): Hex {
  const sig = auth.signature.slice(2);
  const r = `0x${sig.slice(0, 64)}` as Hex;
  const s = `0x${sig.slice(64, 128)}` as Hex;
  // viem returns v as 27/28 in the trailing byte; the contract expects the same.
  const v = Number.parseInt(sig.slice(128, 130), 16);

  return encodeFunctionData({
    abi: ABI,
    functionName: "transferWithAuthorization",
    args: [
      auth.from,
      auth.to,
      auth.value,
      auth.validAfter,
      auth.validBefore,
      auth.nonce,
      v < 27 ? v + 27 : v,
      r,
      s,
    ],
  });
}

/**
 * Whether the token has already recorded this authorization as used.
 *
 * The exactly-once oracle, and the reason §6.3's guarantee is enforced by the
 * chain rather than by our locking: after a crash between broadcast and the
 * ledger write, this answers "did the first attempt land?" without needing the
 * transaction hash we never got to store.
 */
export async function authorizationUsed(
  network: NetworkId,
  token: Hex,
  from: Hex,
  nonce: Hex
): Promise<boolean> {
  const used = await clientFor(network).readContract({
    address: token,
    abi: ABI,
    functionName: "authorizationState",
    args: [from, nonce],
  });
  count("rpc.calls", { network, method: "eth_call" });
  return used as boolean;
}

export async function tokenBalance(network: NetworkId, token: Hex, holder: Hex): Promise<bigint> {
  const balance = await clientFor(network).readContract({
    address: token,
    abi: ABI,
    functionName: "balanceOf",
    args: [holder],
  });
  count("rpc.calls", { network, method: "eth_call" });
  return balance as bigint;
}

// -- Fees --------------------------------------------------------------

export type FeeBasis = { maxFeePerGas: bigint; gasPriceGwei: number };

/**
 * The current price of gas, fetched once per network per tick.
 *
 * Deliberately not `estimateGas` per candidate: the sweeper's two EVM
 * mechanisms have well-known, near-constant gas costs, and one price lookup
 * serves every candidate on the network. Estimating per candidate would also be
 * impossible at plan time for `eip3009` — the call cannot be simulated before
 * the authorization it carries has been signed.
 */
export async function feeBasis(network: NetworkId): Promise<FeeBasis> {
  const fees = await clientFor(network).estimateFeesPerGas();
  count("rpc.calls", { network, method: "eth_feeHistory" });
  const maxFeePerGas = fees.maxFeePerGas ?? fees.gasPrice ?? 0n;
  return { maxFeePerGas, gasPriceGwei: Number(maxFeePerGas) / 1e9 };
}

/**
 * Gas for `transferWithAuthorization`. Measured at ~86k on Circle's FiatToken;
 * the margin covers a cold storage slot for the authorization nonce.
 */
export const EIP3009_GAS = 120_000n;
/** A plain value transfer. */
export const NATIVE_GAS = 21_000n;

/** Gas a mechanism costs on EVM. */
export function gasFor(via: string): bigint {
  return via === "native" ? NATIVE_GAS : EIP3009_GAS;
}

// -- Broadcasting ------------------------------------------------------

/**
 * One in-flight transaction per network at a time.
 *
 * The relayer is the serialization point of the whole subsystem: deposit
 * addresses under `eip3009` never send a transaction at all and so never
 * contend, but every sweep on a network is broadcast from one account with one
 * nonce sequence. Two concurrent sends would read the same pending nonce and one
 * would replace the other. This is also the throughput ceiling, and the first
 * thing to measure under load.
 */
const queues = new Map<NetworkId, Promise<unknown>>();
export function serialized<T>(network: NetworkId, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(network) ?? Promise.resolve();
  const next = previous.then(work, work);
  // The stored tail must never reject, or every later caller inherits it.
  queues.set(network, next.then(
    () => undefined,
    () => undefined
  ));
  return next;
}

export type SignedSend = { txHash: Hex; accountNonce: number; feeRaw: bigint };

/**
 * Signs and broadcasts one transaction, inside the network's queue.
 *
 * `nonce` is returned so the caller can persist it before the next attempt: a
 * retry that reuses the same account nonce either replaces the pending
 * transaction or is rejected as already known, both of which are safe. A retry
 * with a *fresh* nonce would be a second, independent transfer.
 */
export async function sendFrom(
  network: NetworkId,
  ref: KeyRef,
  request: { to: Hex; data?: Hex; value?: bigint; gas: bigint; nonce?: number }
): Promise<SignedSend> {
  const net = NETWORKS[network] as EvmNetworkDef;
  const client = clientFor(network);
  const signer = getSigner();
  const from = (await signer.addressFor(ref)) as Hex;

  return serialized(network, async () => {
    const [fees, pendingNonce] = await Promise.all([
      client.estimateFeesPerGas(),
      request.nonce === undefined
        ? client.getTransactionCount({ address: from, blockTag: "pending" })
        : Promise.resolve(request.nonce),
    ]);
    count("rpc.calls", { network, method: "eth_getTransactionCount" });

    const maxFeePerGas = fees.maxFeePerGas ?? fees.gasPrice ?? 0n;
    const tx: TransactionSerializable = {
      chainId: net.chain.id,
      to: request.to,
      data: request.data,
      value: request.value ?? 0n,
      gas: request.gas,
      nonce: pendingNonce,
      maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? 0n,
      type: "eip1559",
    };

    const serializedTransaction = await signer.signTransaction(ref, tx);
    const txHash = await client.sendRawTransaction({ serializedTransaction });
    count("rpc.calls", { network, method: "eth_sendRawTransaction" });

    return { txHash, accountNonce: pendingNonce, feeRaw: request.gas * maxFeePerGas };
  });
}

/**
 * The relayer's address and native balance on a network.
 *
 * Surfaced because an empty relayer is the single most likely operational cause
 * of sweeps that plan but never broadcast, and it is invisible from the ledger.
 */
export async function relayerState(network: NetworkId) {
  const address = (await getSigner().addressFor({ role: "relayer", family: "evm" })) as Hex;
  const balance = await clientFor(network).getBalance({ address });
  count("rpc.calls", { network, method: "eth_getBalance" });
  return { address, balance, symbol: gasCoinFor(network).symbol };
}

/** Whether a broadcast transaction has reached the network's confirmation depth. */
export async function sweepReceipt(network: NetworkId, txHash: Hex) {
  const net = NETWORKS[network] as EvmNetworkDef;
  const client = clientFor(network);

  const receipt = await client.getTransactionReceipt({ hash: txHash }).catch(() => null);
  count("rpc.calls", { network, method: "eth_getTransactionReceipt" });
  if (!receipt) return { state: "pending" as const };

  const latest = await client.getBlockNumber();
  count("rpc.calls", { network, method: "eth_blockNumber" });

  if (receipt.status !== "success") {
    return { state: "reverted" as const, blockNumber: receipt.blockNumber, feeRaw: receipt.gasUsed * receipt.effectiveGasPrice };
  }
  if (receipt.blockNumber + net.confirmations > latest) {
    return { state: "maturing" as const, blockNumber: receipt.blockNumber };
  }
  return {
    state: "confirmed" as const,
    blockNumber: receipt.blockNumber,
    feeRaw: receipt.gasUsed * receipt.effectiveGasPrice,
  };
}

/** Native balance of a deposit address, for the `native` mechanism. */
export async function nativeBalance(network: NetworkId, address: Hex): Promise<bigint> {
  const balance = await clientFor(network).getBalance({ address });
  count("rpc.calls", { network, method: "eth_getBalance" });
  return balance;
}

/**
 * How much of a native balance can actually be sent: `balance − fee − headroom`.
 *
 * Inherently racy — the fee is subtracted from the very balance being moved and
 * the gas price can rise between this estimate and inclusion — so the headroom
 * dial exists to absorb the difference. A small residue left at the address is
 * normal and is not an error condition; on failure the right response is to
 * re-estimate and retry rather than to tune the subtraction.
 */
export function nativeSweepAmount(balance: bigint, feeRaw: bigint): bigint {
  const withHeadroom = (feeRaw * (10_000n + env.sweepNativeHeadroomBps)) / 10_000n;
  return balance > withHeadroom ? balance - withHeadroom : 0n;
}
