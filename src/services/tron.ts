import { base58check } from "@scure/base";
import { sha256 } from "@noble/hashes/sha256";
import { env, type TronNetworkDef } from "../config";
import { getLogger, count, observe } from "../observability";

const log = getLogger("trongrid");

const b58 = base58check(sha256);

/** Tron address prefix byte (0x41) that precedes the 20-byte hash. */
export const TRON_ADDRESS_PREFIX = 0x41;

/** keccak256("Transfer(address,address,uint256)") — same topic as EVM. */
export const TRANSFER_TOPIC =
  "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 21-byte 0x41-prefixed hex -> Base58Check ("T..."). */
export function hexToBase58Address(hex: string): string {
  return b58.encode(hexToBytes(hex));
}

/** Base58Check ("T...") -> 21-byte 0x41-prefixed hex. */
export function base58ToHexAddress(address: string): string {
  return bytesToHex(b58.decode(address));
}

/**
 * Event-log topic (32-byte, left-padded) -> Base58Check address.
 * Tron logs carry the bare 20-byte hash, so the 0x41 prefix is re-attached.
 */
export function topicToBase58Address(topic: string): string {
  const clean = topic.startsWith("0x") ? topic.slice(2) : topic;
  const last20 = clean.slice(-40);
  return hexToBase58Address(`41${last20}`);
}

/** True for a syntactically valid Base58Check Tron address. */
export function isTronAddress(address: string): boolean {
  try {
    const bytes = b58.decode(address);
    return bytes.length === 21 && bytes[0] === TRON_ADDRESS_PREFIX;
  } catch {
    return false;
  }
}

// -- TronGrid HTTP client ---------------------------------------------

function headers(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (env.trongridApiKey) h["TRON-PRO-API-KEY"] = env.trongridApiKey;
  return h;
}

/**
 * One call to TronGrid, timed and counted.
 *
 * Tron detection is entirely polling, so the call count *is* the cost model and
 * the per-call latency is the first thing to look at when a scan starts taking
 * longer than its interval. HTTP 429 is called out by name because the free
 * tier is rate-limited per IP and a silent 429 looks exactly like "the payer
 * never sent anything".
 */
async function request<T>(
  net: TronNetworkDef,
  path: string,
  init?: { method: "POST"; body: unknown }
): Promise<T> {
  const started = performance.now();
  // Query strings carry addresses and timestamps, not secrets, but the path
  // alone is the useful grouping key.
  const route = path.split("?")[0]!;

  let res: Response;
  try {
    res = await fetch(`${net.apiBase}${path}`, {
      method: init ? "POST" : "GET",
      headers: headers(),
      ...(init ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch (e) {
    count("http.client.errors", { host: "trongrid", route });
    log.warn("trongrid request failed", {
      "http.request.method": init ? "POST" : "GET",
      "http.route": route,
      "server.address": new URL(net.apiBase).host,
      duration_ms: Math.round(performance.now() - started),
      err: e,
    });
    throw e;
  }

  const ms = performance.now() - started;
  observe("http.client.duration", ms, { host: "trongrid", route });
  count("http.client.requests", { host: "trongrid", route, status: res.status });
  count("rpc.calls", { network: "tron", method: route });

  log.trace("trongrid request", {
    "http.request.method": init ? "POST" : "GET",
    "http.route": route,
    "url.path": path,
    "http.response.status_code": res.status,
    duration_ms: Math.round(ms),
  });

  if (res.status === 429) {
    log.warn("trongrid rate-limited", {
      "http.route": route,
      hint: "set TRONGRID_API_KEY or raise TRON_POLL_INTERVAL_SEC",
    });
  }
  if (!res.ok) throw new Error(`TronGrid ${path} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

const post = <T>(net: TronNetworkDef, path: string, body: unknown): Promise<T> =>
  request<T>(net, path, { method: "POST", body });

const get = <T>(net: TronNetworkDef, path: string): Promise<T> => request<T>(net, path);

/** Latest block height. Doubles as the liveness probe for the supervisor. */
export async function getNowBlock(net: TronNetworkDef): Promise<bigint> {
  const json = await post<{ block_header?: { raw_data?: { number?: number } } }>(
    net,
    "/wallet/getnowblock",
    {}
  );
  const number = json.block_header?.raw_data?.number;
  if (typeof number !== "number") throw new Error("TronGrid: malformed getnowblock response");
  return BigInt(number);
}

export type Trc20Transfer = {
  transaction_id: string;
  block_timestamp: number;
  from: string;
  to: string;
  value: string;
  type: string;
  token_info?: { address?: string; decimals?: number; symbol?: string };
};

/**
 * TRC-20 transfers involving `address`, newest first.
 *
 * `only_confirmed: false` so a deposit shows up as soon as it is mined — the
 * confirmer is what waits for irreversibility. Note this response carries no
 * block number and no log index; getTransactionInfo supplies both.
 *
 * `since` bounds the query to transfers at or after a moment in time. Callers
 * must pass the payment's creation time: an address's older history must never
 * settle a payment that did not exist when those funds arrived.
 */
export async function getTrc20Transfers(
  net: TronNetworkDef,
  address: string,
  contractAddress: string,
  since: Date,
  limit = 50
): Promise<Trc20Transfer[]> {
  const qs = new URLSearchParams({
    only_confirmed: "false",
    limit: String(limit),
    contract_address: contractAddress,
    min_timestamp: String(since.getTime()),
  });
  const json = await get<{ data?: Trc20Transfer[]; success?: boolean }>(
    net,
    `/v1/accounts/${address}/transactions/trc20?${qs}`
  );
  return json.data ?? [];
}

export type TronNativeTx = {
  txID: string;
  blockNumber?: number;
  block_timestamp?: number;
  ret?: Array<{ contractRet?: string }>;
  raw_data?: {
    contract?: Array<{
      type?: string;
      parameter?: {
        value?: { amount?: number; owner_address?: string; to_address?: string };
      };
    }>;
  };
};

/**
 * Every transaction involving `address`, newest first — the native TRX feed.
 *
 * A TRX transfer is a `TransferContract` on the transaction itself, not a
 * contract event, so it never appears in the TRC-20 listing above and has to be
 * read from the account's own transaction history. The upside over the TRC-20
 * path is that this response already carries `blockNumber` and `contractRet`,
 * so a native deposit costs one call instead of two.
 *
 * `search_internal=false`: TRX moved by a contract call (an exchange sweeping
 * through a router) arrives as an internal transaction with a shape of its own.
 * Excluded deliberately so this stays the same "top-level transfers only"
 * contract as the EVM native watcher, rather than being quietly broader on one
 * chain than the other.
 */
export async function getNativeTransfers(
  net: TronNetworkDef,
  address: string,
  since: Date,
  limit = 50
): Promise<TronNativeTx[]> {
  const qs = new URLSearchParams({
    only_confirmed: "false",
    search_internal: "false",
    limit: String(limit),
    min_timestamp: String(since.getTime()),
  });
  const json = await get<{ data?: TronNativeTx[]; success?: boolean }>(
    net,
    `/v1/accounts/${address}/transactions?${qs}`
  );
  return json.data ?? [];
}

/**
 * Reads an incoming TRX transfer out of a listed transaction, or null when it
 * is not one (a contract call, an outgoing transfer, a failed transaction).
 *
 * Addresses in `raw_data` are 0x41-prefixed hex, so the recipient is re-encoded
 * to Base58 before comparison — the same conversion the TRC-20 path does on log
 * topics.
 */
export function parseNativeTransfer(
  tx: TronNativeTx,
  toBase58: string
): { from: string; amountRaw: bigint; blockNumber: bigint } | null {
  const contract = tx.raw_data?.contract?.[0];
  if (contract?.type !== "TransferContract") return null;

  const value = contract.parameter?.value;
  const to = value?.to_address;
  const amount = value?.amount;
  if (!to || typeof amount !== "number" || amount <= 0) return null;
  if (hexToBase58Address(to) !== toBase58) return null;

  // A transaction can be mined and still have failed (OUT_OF_ENERGY, REVERT);
  // only SUCCESS moved value. Absent means the node did not say, which for a
  // plain transfer is success.
  const result = tx.ret?.[0]?.contractRet;
  if (result && result !== "SUCCESS") return null;

  if (typeof tx.blockNumber !== "number") return null; // not mined yet
  if (!value.owner_address) return null;

  return {
    from: hexToBase58Address(value.owner_address),
    // `amount` is sun (6 decimals) and arrives as a JSON number. Exact below
    // ~9e15 sun (about 9 million TRX), which is far above any checkout.
    amountRaw: BigInt(amount),
    blockNumber: BigInt(tx.blockNumber),
  };
}

export type TronTxInfo = {
  id: string;
  blockNumber: number;
  receipt?: { result?: string };
  log?: Array<{ address: string; topics: string[]; data: string }>;
};

/** Full transaction info: block height, execution result and event logs. */
export async function getTransactionInfo(
  net: TronNetworkDef,
  txHash: string
): Promise<TronTxInfo | null> {
  const json = await post<TronTxInfo | Record<string, never>>(
    net,
    "/wallet/gettransactioninfobyid",
    { value: txHash }
  );
  // An unknown or not-yet-mined tx comes back as `{}`.
  if (!json || typeof (json as TronTxInfo).blockNumber !== "number") return null;
  return json as TronTxInfo;
}

/**
 * Locates a specific TRC-20 Transfer inside a transaction's logs.
 *
 * Returns the log's array position as `logIndex` so deposits stay idempotent
 * per (network, txHash, logIndex) exactly like the EVM path, and re-reads the
 * amount from the log rather than trusting the listing endpoint.
 */
export function findTransferLog(
  info: TronTxInfo,
  contractHex: string,
  toBase58: string
): { logIndex: number; from: string; amountRaw: bigint } | null {
  const contract = contractHex.replace(/^0x/, "").replace(/^41/, "").toLowerCase();
  const logs = info.log ?? [];

  for (const [logIndex, log] of logs.entries()) {
    if (log.address?.toLowerCase().replace(/^41/, "") !== contract) continue;
    if (log.topics?.[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    if (log.topics.length < 3) continue;
    if (topicToBase58Address(log.topics[2]!) !== toBase58) continue;

    return {
      logIndex,
      from: topicToBase58Address(log.topics[1]!),
      amountRaw: BigInt(`0x${log.data || "0"}`),
    };
  }
  return null;
}
