/**
 * Creates a real payment (a "transaction" the gateway waits to be funded),
 * deriving a unique HD receiving address and freezing a quote.
 *
 *   bun run scripts/create-payment.ts [clientId] [amountCop] [network] [asset]
 *
 * Mirrors src/services/payments.ts:createPayment but injects a FIXED frozen
 * rate instead of quoting live, so demos are deterministic and offline.
 * Defaults: newest client, 50,000 COP, base-sepolia, 4,100 COP per token
 * (asset defaults to the network's stablecoin: USDT on Tron, USDC on EVM).
 *
 *   bun run scripts/create-payment.ts "" 50000 tron-nile
 */
import { customAlphabet } from "nanoid";
import { desc, eq } from "drizzle-orm";
import { db, schema, sql } from "../src/db";
import { NETWORKS, tokenFor, env, type NetworkId } from "../src/config";
import { copToRaw } from "../src/services/rates";
import { reserveDerivationIndex, deriveAddress } from "../src/services/wallet";

const nano = customAlphabet("abcdefghijkmnpqrstuvwxyz23456789", 14);

const clientIdArg = process.argv[2];
const amountCop = BigInt(process.argv[3] ?? "50000");
const network = (process.argv[4] ?? "base-sepolia") as NetworkId;

const net = NETWORKS[network];
if (!net) throw new Error(`Unknown network: ${network}`);
// Default to whatever stablecoin the network actually carries (USDT on Tron).
const asset = process.argv[5] ?? (net.family === "tron" ? "USDT" : "USDC");
const rateCopPerUnitE6 = 4_100_000_000n; // 4,100 COP per 1 token, scaled x1e6

const token = tokenFor(network, asset);
if (!token) throw new Error(`Unsupported asset/network: ${asset}/${network}`);

const [client] = clientIdArg
  ? await db.select().from(schema.clients).where(eq(schema.clients.id, clientIdArg))
  : await db.select().from(schema.clients).orderBy(desc(schema.clients.createdAt)).limit(1);
if (!client) throw new Error("No client found. Run `bun run seed` first.");

const amountCryptoRaw = copToRaw(amountCop, rateCopPerUnitE6, token.decimals);
const derivationIndex = await reserveDerivationIndex();
const address = deriveAddress(derivationIndex, network);

const [payment] = await db
  .insert(schema.payments)
  .values({
    publicId: nano(),
    clientId: client.id,
    amountCop,
    asset,
    network,
    amountCryptoRaw,
    rateCopPerUnitE6,
    address,
    derivationIndex,
    quoteExpiresAt: new Date(Date.now() + env.quoteTtlMin * 60_000),
    metadata: JSON.stringify({ order_id: "ORD-DEMO-001", source: "create-payment.ts" }),
  })
  .returning();

// Tron wallets scan a bare Base58 address; EVM wallets take an EIP-681 URI.
const uri =
  net.family === "tron"
    ? payment!.address
    : `ethereum:${token.address}@${net.chain.id}/transfer?address=${payment!.address}&uint256=${payment!.amountCryptoRaw}`;

console.log("=== Payment (transaction) created ==========================");
console.log(`  merchant      : ${client.name} (${client.id})`);
console.log(`  publicId      : ${payment!.publicId}`);
console.log(`  status        : ${payment!.status}`);
console.log(`  amount_cop    : ${payment!.amountCop} COP`);
console.log(`  amount_crypto : ${payment!.amountCryptoRaw} raw (${Number(payment!.amountCryptoRaw) / 10 ** token.decimals} ${asset})`);
console.log(`  frozen_rate   : ${Number(rateCopPerUnitE6) / 1e6} COP/${asset}`);
console.log(`  network       : ${payment!.network} (${net.family === "tron" ? net.apiBase : `chainId ${net.chain.id}`})`);
console.log(`  pay-to addr   : ${payment!.address}  (index ${payment!.derivationIndex})`);
console.log(`  quote_expires : ${payment!.quoteExpiresAt.toISOString()}`);
console.log(`  checkout_url  : http://localhost:${env.port}/pay/${payment!.publicId}`);
console.log(`  EIP-681 URI   : ${uri}`);

await sql.end();
process.exit(0);
