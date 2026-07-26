/**
 * HTTP-layer smoke test using Hono's app.request() (no chain workers, no
 * external network). Validates routing, api-key auth, QR/EIP-681 checkout
 * rendering and the public status endpoint.
 */
import { randomBytes } from "crypto";
import { app } from "../src/api/routes";
import { db, schema, sql } from "../src/db";
import { copToRaw } from "../src/services/rates";
import { deriveAddress, reserveDerivationIndex } from "../src/services/wallet";

let failures = 0;
function assert(cond: boolean, msg: string) {
  console[cond ? "log" : "error"](`  ${cond ? "ok  " : "FAIL"}- ${msg}`);
  if (!cond) failures++;
}

async function main() {
  // client with a known api key
  const apiKey = "gk_test_" + randomBytes(16).toString("hex");
  const hash = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(apiKey))
  ).toString("hex");
  const [client] = await db
    .insert(schema.clients)
    .values({
      name: "API Test Merchant",
      apiKeyHash: hash,
      webhookSecret: "whsec_" + randomBytes(8).toString("hex"),
    })
    .returning();

  // payment inserted directly (avoids CoinGecko)
  const idx = await reserveDerivationIndex();
  const [p] = await db
    .insert(schema.payments)
    .values({
      publicId: "apitest_" + randomBytes(5).toString("hex"),
      clientId: client!.id,
      amountCop: 50_000n,
      asset: "USDC",
      network: "base-sepolia",
      amountCryptoRaw: copToRaw(50_000n, 4_000_000_000n, 6),
      rateCopPerUnitE6: 4_000_000_000n,
      address: deriveAddress(idx, "base-sepolia"),
      derivationIndex: idx,
      quoteExpiresAt: new Date(Date.now() + 15 * 60_000),
      metadata: JSON.stringify({ order_id: "ORD-001" }),
    })
    .returning();

  console.log("\n[GET /health]");
  let res = await app.request("/health");
  assert(res.status === 200, "health -> 200");
  assert(((await res.json()) as any).ok === true, "health body ok");

  console.log("\n[auth]");
  res = await app.request("/api/me");
  assert(res.status === 401, "no api key -> 401");
  res = await app.request("/api/me", { headers: { "X-Api-Key": "wrong" } });
  assert(res.status === 401, "bad api key -> 401");
  res = await app.request("/api/me", { headers: { "X-Api-Key": apiKey } });
  assert(res.status === 200, "valid api key -> 200");
  const me = (await res.json()) as any;
  assert(me.balance_cop === "0", "balance_cop serialized as string '0'");

  console.log("\n[POST /api/payments validation]");
  res = await app.request("/api/payments", {
    method: "POST",
    headers: { "X-Api-Key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ amount_cop: 50000, asset: "DOGE", network: "base-sepolia" }),
  });
  assert(res.status === 400, "unsupported asset -> 400 (rejected before price fetch)");

  console.log("\n[GET /api/payments/:id]");
  res = await app.request(`/api/payments/${p!.publicId}`, { headers: { "X-Api-Key": apiKey } });
  assert(res.status === 200, "authed payment fetch -> 200");
  const pv = (await res.json()) as any;
  assert(pv.amount_crypto_raw === "12500000", "12.5 USDC required for 50k COP @4000");
  assert(pv.metadata?.order_id === "ORD-001", "metadata round-trips");

  console.log("\n[GET /public/payments/:id]");
  res = await app.request(`/public/payments/${p!.publicId}`);
  assert(res.status === 200, "public status -> 200");
  const pub = (await res.json()) as any;
  assert(pub.address === p!.address, "public view exposes the address");
  assert(pub.status === "pending", "public status pending");
  res = await app.request(`/public/payments/does-not-exist`);
  assert(res.status === 404, "unknown public id -> 404");

  console.log("\n[GET /public/payments/:id/checkout]");
  res = await app.request(`/public/payments/${p!.publicId}/checkout`);
  assert(res.status === 200, "checkout payload -> 200");
  const co = (await res.json()) as any;
  assert(typeof co.payment_uri === "string" && co.payment_uri.startsWith("ethereum:"), "EIP-681 URI present");
  assert(co.payment_uri.includes(p!.address), "URI targets the payment address");
  assert(String(co.qr_data_url).startsWith("data:image/png;base64,"), "QR data URL present");
  assert(co.decimals === 6, "decimals = 6 for USDC");
  assert(co.payment.amount_crypto_raw === "12500000", "checkout carries required amount");
  res = await app.request(`/public/payments/does-not-exist/checkout`);
  assert(res.status === 404, "unknown checkout -> 404");

  console.log("\n[GET /pay/:id serves the SPA]");
  res = await app.request(`/pay/${p!.publicId}`);
  assert(res.status === 200, "checkout SPA -> 200");
  const html = await res.text();
  assert(html.includes(`id="root"`), "SPA root mount point present");
  const assetMatch = html.match(/src="(\/assets\/[^"]+\.js)"/);
  assert(!!assetMatch, "SPA bundle script referenced");
  if (assetMatch) {
    const asset = await app.request(assetMatch[1]!);
    assert(asset.status === 200, "static /assets bundle served (200)");
  }

  console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " CHECK(S) FAILED"}`);
  await sql.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await sql.end();
  process.exit(1);
});
