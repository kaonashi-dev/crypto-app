/**
 * Phase 0 of docs/design/SWEEPING-PLAN.md — the capability probe.
 *
 * Answers, per served (network, asset) pairing and from the chain itself rather
 * than from an assumption: can value leave a deposit address without that
 * address first being funded with gas?
 *
 * For an EVM token that means EIP-3009 (`transferWithAuthorization`), which is
 * signed off-chain and submitted by a relayer. The signature is EIP-712, so it
 * only verifies against the exact domain the contract was deployed with — and
 * deployments genuinely differ (`name()` is "USD Coin" on some and "USDC" on
 * others; `version()` is "1" or "2"). Guessing wrong produces a signature that
 * fails on-chain *after* a ledger row has been written, so the domain is read
 * here and cross-checked against the contract's own `DOMAIN_SEPARATOR()`.
 *
 * This is the one script in the repo that touches a chain. Every call is a
 * view/constant call: it reads, it never signs and never broadcasts.
 *
 *   bun run scripts/sweep-probe.ts
 *   bun run scripts/sweep-probe.ts --network eth-sepolia
 */
import "./quiet"; // must precede every ../src import
import { createPublicClient, hashDomain, http, parseAbi, toFunctionSelector } from "viem";
import {
  NETWORKS,
  NETWORK_IDS,
  gasCoinFor,
  missingCredential,
  type EvmNetworkDef,
  type NetworkId,
  type TronNetworkDef,
} from "../src/config";
import { base58ToHexAddress, triggerConstantContract } from "../src/services/tron";

// EIP-3009 requires `authorizationState(address,bytes32)`; ERC-5267 supplies
// `eip712Domain()`. Both are view calls, so their mere success is the capability
// signal — no state is touched either way.
const ABI = parseAbi([
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)",
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

const TRANSFER_WITH_AUTHORIZATION = toFunctionSelector(
  "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)"
);

const ZERO = "0x0000000000000000000000000000000000000000" as const;
const ZERO32 = `0x${"0".repeat(64)}` as const;

type Row = {
  network: string;
  asset: string;
  address: string;
  /** Registry decimals vs the contract's own. */
  decimals: string;
  symbol: string;
  mechanism: string;
  domain: string;
  note: string;
};

const rows: Row[] = [];
let problems = 0;

function note(row: Row, text: string, isProblem = false) {
  row.note = row.note ? `${row.note}; ${text}` : text;
  if (isProblem) problems++;
}

// -- EVM ---------------------------------------------------------------

async function probeEvm(network: NetworkId, net: EvmNetworkDef) {
  const client = createPublicClient({ chain: net.chain, transport: http(net.httpRpc) });

  // Liveness first, and the whole network is skipped if it fails. Without this
  // an unreachable node answers every view call with the same "error" a missing
  // function does, and the probe would confidently record "no EIP-3009" for a
  // contract it never actually reached — the precise class of false fact this
  // script exists to prevent.
  try {
    await client.getBlockNumber();
  } catch (e) {
    problems++;
    rows.push({
      network,
      asset: "—",
      address: "—",
      decimals: "—",
      symbol: "—",
      mechanism: "unreachable",
      domain: "—",
      note: `RPC unreachable (${(e as Error).message.split("\n")[0]}) — no verdict for this network`,
    });
    return;
  }

  for (const [asset, def] of Object.entries(net.tokens) as Array<
    [string, { address: `0x${string}`; decimals: number }]
  >) {
    const row: Row = {
      network,
      asset,
      address: def.address,
      decimals: String(def.decimals),
      symbol: "?",
      mechanism: "prefund",
      domain: "—",
      note: "",
    };
    rows.push(row);

    const read = <T>(functionName: string, args: unknown[] = []) =>
      client
        .readContract({ address: def.address, abi: ABI, functionName, args } as never)
        .then((v) => v as T)
        .catch(() => null);

    // Registry cross-check first: a wrong `decimals` mis-sizes every sweep the
    // same way it would mis-size a quote, and it costs one call to rule out.
    const [symbol, decimals] = await Promise.all([read<string>("symbol"), read<number>("decimals")]);
    if (symbol) row.symbol = symbol;
    // `symbol()` is ERC-20 mandatory. A live node that cannot answer it means the
    // address is not the token we think it is, so no capability verdict below
    // would mean anything — say so instead of inferring one.
    if (symbol === null) {
      row.mechanism = "unknown";
      note(row, "symbol() unreadable on a reachable node — verdict withheld", true);
      continue;
    }
    if (typeof decimals === "number") {
      row.decimals = decimals === def.decimals ? String(decimals) : `${def.decimals} ≠ ${decimals}`;
      if (decimals !== def.decimals) {
        note(row, `registry decimals disagree with the contract (${def.decimals} vs ${decimals})`, true);
      }
    }

    // EIP-3009. `authorizationState` is mandatory in the standard, so a contract
    // that answers it implements the scheme; one that reverts does not.
    const authState = await read<boolean>("authorizationState", [ZERO, ZERO32]);
    if (authState === null) {
      note(row, "no EIP-3009 (authorizationState absent) — needs gas at the leaf");
      continue;
    }

    // Present as a view function, but the *transfer* entry point is what the
    // sweeper actually calls. A proxy hides its selectors, so this only reports
    // when the bytecode is readable and plainly lacks it.
    const code = await client.getCode({ address: def.address }).catch(() => undefined);
    const bare = code && code.length > 2 && !code.includes(TRANSFER_WITH_AUTHORIZATION.slice(2));
    if (bare) note(row, "authorizationState present but transferWithAuthorization not in bytecode (proxy?)");

    row.mechanism = "eip3009";

    // Domain resolution, in the order §4.2 of the plan specifies.
    const five = await read<
      readonly [`0x${string}`, string, string, bigint, `0x${string}`, `0x${string}`, readonly bigint[]]
    >("eip712Domain");

    let name: string | null = null;
    let version: string | null = null;
    let source = "";
    if (five) {
      [, name, version] = five;
      source = "eip712Domain()";
      if (Number(five[3]) !== net.chain.id) {
        note(row, `eip712Domain() chainId ${five[3]} ≠ ${net.chain.id}`, true);
      }
    } else {
      [name, version] = await Promise.all([read<string>("name"), read<string>("version")]);
      source = "name()+version()";
    }

    if (!name) {
      note(row, "EIP-712 domain unresolvable — sweeping must stay disabled", true);
      row.mechanism = "eip3009 (blocked)";
      continue;
    }

    // Cross-check. This is the assertion the whole mechanism rests on: if our
    // assembled separator does not equal the contract's, every signature we
    // produce would be rejected on-chain.
    const onChain = await read<`0x${string}`>("DOMAIN_SEPARATOR");
    const candidates = version ? [version] : ["1", "2"];
    let matched: string | null = null;
    for (const v of candidates) {
      const local = hashDomain({
        domain: { name, version: v, chainId: BigInt(net.chain.id), verifyingContract: def.address },
        types: {
          EIP712Domain: [
            { name: "name", type: "string" },
            { name: "version", type: "string" },
            { name: "chainId", type: "uint256" },
            { name: "verifyingContract", type: "address" },
          ],
        },
      });
      if (!onChain || local.toLowerCase() === onChain.toLowerCase()) {
        matched = v;
        break;
      }
    }

    row.domain = `${name} / v${matched ?? version ?? "?"}`;
    if (!onChain) {
      note(row, `domain from ${source}, DOMAIN_SEPARATOR() absent — unverified`, true);
      row.mechanism = "eip3009 (blocked)";
    } else if (!matched) {
      note(row, `DOMAIN_SEPARATOR() mismatch against ${source} — sweeping must stay disabled`, true);
      row.mechanism = "eip3009 (blocked)";
    } else {
      note(row, `domain verified against DOMAIN_SEPARATOR() (${source})`);
    }
  }

  // The chain's fee currency, which is what a native sweep and every gas
  // estimate is denominated in — present even where the gateway does not accept
  // it as a payment asset (Sepolia quotes stablecoins only). Resolved through
  // `gasCoinFor` so this reports the name the sweeper will actually price
  // against, not the chain's own testnet rename ("tBNB", which no rate provider
  // quotes).
  const gas = gasCoinFor(network);
  rows.push({
    network,
    asset: gas.symbol,
    address: "—",
    decimals: String(gas.decimals),
    symbol: net.chain.nativeCurrency.symbol,
    mechanism: net.native ? "native" : "gas only (not quoted)",
    domain: "—",
    note: net.native ? "swept as balance − gas" : "fee currency; no deposits to sweep",
  });
}

// -- Tron --------------------------------------------------------------

/**
 * ABI-decodes a `string` return value: 32-byte offset, 32-byte length, then the
 * bytes. TronGrid hands back raw hex rather than a decoded value, and viem's
 * decoder is not reachable here without an ABI object per call.
 */
function decodeAbiString(hex: string): string {
  const offset = Number(BigInt(`0x${hex.slice(0, 64)}`)) * 2;
  const length = Number(BigInt(`0x${hex.slice(offset, offset + 64)}`));
  const body = hex.slice(offset + 64, offset + 64 + length * 2);
  return Buffer.from(body, "hex").toString("utf8");
}

async function probeTron(network: NetworkId, net: TronNetworkDef) {
  for (const [asset, def] of Object.entries(net.tokens) as Array<
    [string, { address: string; decimals: number }]
  >) {
    const row: Row = {
      network,
      asset,
      address: def.address,
      decimals: String(def.decimals),
      symbol: "?",
      mechanism: "delegate",
      domain: "—",
      note: "",
    };
    rows.push(row);

    const contract = base58ToHexAddress(def.address);
    // An owner is required even for a constant call; the contract itself is a
    // valid one and costs nothing.
    const call = (selector: string, params = "") =>
      triggerConstantContract(net, contract, contract, selector, params).catch(() => null);

    const [decimals, symbol] = await Promise.all([call("decimals()"), call("symbol()")]);
    // Same withholding rule as the EVM path: TronGrid answers a missing function
    // and an unreachable node identically, so a pairing whose mandatory ERC-20
    // metadata will not read gets no capability verdict at all.
    if (decimals === null) {
      row.mechanism = "unknown";
      note(row, "decimals() unreadable — verdict withheld", true);
      continue;
    }
    if (symbol) row.symbol = decodeAbiString(symbol);
    const value = Number(BigInt(`0x${decimals}`));
    row.decimals = value === def.decimals ? String(value) : `${def.decimals} ≠ ${value}`;
    if (value !== def.decimals) note(row, "registry decimals disagree with the contract", true);

    const auth = await call(
      "authorizationState(address,bytes32)",
      `${"0".repeat(64)}${"0".repeat(64)}`
    );
    if (auth === null) {
      note(row, "no EIP-3009 — TRC-20 sweeps use delegated energy, not an authorization");
    } else {
      row.mechanism = "eip3009?";
      note(row, "authorizationState answered — unexpected on TRC-20, worth a second look");
    }
  }

  if (net.native) {
    rows.push({
      network,
      asset: net.native.symbol,
      address: "—",
      decimals: String(net.native.decimals),
      symbol: net.native.symbol,
      mechanism: "native",
      domain: "—",
      note: "swept as balance − fee; also the resource that pays for TRC-20 sweeps",
    });
  }
}

// -- Report ------------------------------------------------------------

function table() {
  const cols: Array<[keyof Row, string]> = [
    ["network", "network"],
    ["asset", "asset"],
    ["symbol", "on-chain"],
    ["decimals", "decimals"],
    ["mechanism", "mechanism"],
    ["domain", "EIP-712 domain"],
  ];
  const width = (k: keyof Row, header: string) =>
    Math.max(header.length, ...rows.map((r) => String(r[k]).length));
  const widths = cols.map(([k, h]) => width(k, h));

  console.log("\n" + cols.map(([, h], i) => h.padEnd(widths[i]!)).join("  "));
  console.log(widths.map((w) => "─".repeat(w)).join("  "));
  for (const r of rows) {
    console.log(cols.map(([k], i) => String(r[k]).padEnd(widths[i]!)).join("  "));
  }

  console.log("");
  for (const r of rows) {
    if (r.note) console.log(`  ${r.network}/${r.asset}: ${r.note}`);
  }
}

async function main() {
  const only = process.argv.includes("--network")
    ? process.argv[process.argv.indexOf("--network") + 1]
    : null;

  for (const network of NETWORK_IDS) {
    if (only && network !== only) continue;
    const net = NETWORKS[network];

    const missing = missingCredential(network);
    if (missing) {
      console.log(`\n${network}: skipped — ${missing} is not set`);
      continue;
    }

    console.log(`\n${network}: probing…`);
    try {
      if (net.family === "tron") await probeTron(network, net);
      else await probeEvm(network, net);
    } catch (e) {
      problems++;
      console.error(`  ${network}: probe failed — ${(e as Error).message.split("\n")[0]}`);
    }
  }

  table();
  console.log(
    problems === 0
      ? "PROBE CLEAN — every pairing above resolved a verified mechanism"
      : `${problems} PROBLEM(S) — only pairings with a verified mechanism may be swept; ` +
          `"blocked", "unknown" and "unreachable" carry no verdict`
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
