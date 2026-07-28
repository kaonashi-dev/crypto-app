/**
 * HTTP-layer smoke test using Hono's app.request() (no chain workers, no
 * external network). Validates routing, api-key auth, QR/EIP-681 checkout
 * rendering and the public status endpoint.
 */
import "./quiet"; // must precede every ../src import
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

  console.log("\n[GET /api/payments/:id/status]");
  res = await app.request(`/api/payments/${p!.publicId}/status`);
  assert(res.status === 401, "status without an api key -> 401");
  res = await app.request(`/api/payments/${p!.publicId}/status`, {
    headers: { "X-Api-Key": apiKey },
  });
  assert(res.status === 200, "authed status fetch -> 200");
  const statusBody = await res.text();
  const st = JSON.parse(statusBody) as any;
  assert(st.id === p!.publicId, "status reports the payment it was asked about");
  assert(st.status === "pending", "status carries the current state");
  assert(st.terminal === false, "pending is not terminal");
  assert(st.decimals === 6, "decimals come from the (network, asset) pairing");
  assert(st.amount_crypto_raw === "12500000", "required amount agrees with the detail route");
  // The whole point of the endpoint is being polled by a machine, so the amounts
  // have to survive JSON.parse in a language with 64-bit floats.
  assert(!/"amount_crypto_raw":\s*\d/.test(statusBody), "amounts are quoted, never bare numbers");
  assert(!/"amount_cop":\s*\d/.test(statusBody), "amount_cop is quoted, never a bare number");
  assert(statusBody.includes('"address"') === false, "status omits the receiving address");

  // Another merchant's payment answers exactly as an unknown id does, so this is
  // not an oracle for which payments exist.
  const otherKey = "gk_test_" + randomBytes(16).toString("hex");
  await db.insert(schema.clients).values({
    name: "Status Scope Merchant",
    apiKeyHash: Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(otherKey))
    ).toString("hex"),
    webhookSecret: "whsec_" + randomBytes(8).toString("hex"),
  });
  res = await app.request(`/api/payments/${p!.publicId}/status`, {
    headers: { "X-Api-Key": otherKey },
  });
  assert(res.status === 404, "another merchant's payment -> 404");
  res = await app.request("/api/payments/does-not-exist/status", {
    headers: { "X-Api-Key": apiKey },
  });
  assert(res.status === 404, "unknown id -> 404, the same answer");

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
  assert(
    co.payment_uri.includes("/transfer?address="),
    "a token URI targets the contract and calls transfer"
  );
  res = await app.request(`/public/payments/does-not-exist/checkout`);
  assert(res.status === 404, "unknown checkout -> 404");

  // A native coin has no contract to call: EIP-681 addresses the payee directly
  // and carries `value`. Sending the token form for a native payment would ask
  // the wallet to call `transfer` on an account with no code.
  console.log("\n[GET /public/payments/:id/checkout — native coin]");
  const nativeIdx = await reserveDerivationIndex();
  const [pn] = await db
    .insert(schema.payments)
    .values({
      publicId: "apitest_" + randomBytes(5).toString("hex"),
      clientId: client!.id,
      amountCop: 50_000n,
      asset: "BNB",
      network: "bsc-testnet",
      // 18-decimal native coin at 600,000 COP each.
      amountCryptoRaw: copToRaw(50_000n, 600_000_000_000n, 18),
      rateCopPerUnitE6: 600_000_000_000n,
      address: deriveAddress(nativeIdx, "bsc-testnet"),
      derivationIndex: nativeIdx,
      quoteExpiresAt: new Date(Date.now() + 15 * 60_000),
    })
    .returning();

  res = await app.request(`/public/payments/${pn!.publicId}/checkout`);
  assert(res.status === 200, "native checkout payload -> 200");
  const con = (await res.json()) as any;
  assert(con.decimals === 18, "decimals = 18 for BNB");
  assert(
    con.payment_uri.startsWith(`ethereum:${pn!.address}@97`),
    "native URI targets the payee on the chain id, not a contract"
  );
  assert(
    con.payment_uri.includes(`?value=${pn!.amountCryptoRaw}`) &&
      !con.payment_uri.includes("/transfer"),
    "native URI carries value and never calls transfer"
  );
  assert(
    con.payment.amount_crypto_raw === "83333333333333334",
    "native amount serialized in full precision as a string"
  );

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
