/**
 * HTTP-layer test for the read-only backoffice API behind /admin.
 *
 * Uses Hono's app.request() — no chain workers, no external network. Seeds one
 * payment with two deposits, a webhook job and a ledger entry, then checks that
 * every console endpoint reports them, that filters and search work, and that no
 * bigint escapes as a JSON number.
 */
import "./quiet"; // must precede every ../src import
import { randomBytes } from "crypto";
import { eq } from "drizzle-orm";
import { app } from "../src/api/routes";
import { db, schema, sql } from "../src/db";
import { env, NETWORKS, NETWORK_IDS } from "../src/config";
import { copToRaw, primeRateCache } from "../src/services/rates";
import { hashApiKey } from "../src/services/merchants";
import { deriveAddress, reserveDerivationIndex } from "../src/services/wallet";
import { bootstrapOperator } from "../src/services/admin-auth";

let failures = 0;
function assert(cond: boolean, msg: string) {
  console[cond ? "log" : "error"](`  ${cond ? "ok  " : "FAIL"}- ${msg}`);
  if (!cond) failures++;
}

const RATE = 4_000_000_000n; // 4,000 COP per USDC

// The console is gated by an operator session when ADMIN_PASSWORD is set (always
// in production, optionally in development). Sign in once and carry the cookie,
// so this test exercises the same routes either way.
//
// Mutated in place by signIn() below — every request reads it at call time.
const adminHeaders: Record<string, string> = {};

/** The cookie a signed-in browser would hold, or nothing when the console runs open. */
async function signIn(): Promise<void> {
  if (!env.adminPassword) return;

  // Normally done at boot by src/index.ts; this test drives `app` directly.
  await bootstrapOperator();

  const res = await app.request("/admin/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: env.adminUser, password: env.adminPassword }),
  });
  const cookie = res.headers.get("set-cookie");
  if (res.status !== 200 || !cookie) {
    console.error(`[admin-test] could not sign in as "${env.adminUser}" (${res.status})`);
    process.exit(1);
  }
  adminHeaders.Cookie = cookie.split(";")[0]!;
}

const get = (path: string) => app.request(path, { headers: adminHeaders });
const json = async (path: string) => {
  const res = await get(path);
  return { status: res.status, body: (await res.json()) as any };
};

async function main() {
  await signIn();

  const [client] = await db
    .insert(schema.clients)
    .values({
      name: "Console Test Merchant",
      apiKeyHash: Buffer.from(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(randomBytes(16).toString("hex")))
      ).toString("hex"),
      webhookSecret: "whsec_" + randomBytes(8).toString("hex"),
      webhookUrl: "https://webhook.site/console-test",
    })
    .returning();

  const idx = await reserveDerivationIndex();
  const orderId = "ORD-CONSOLE-" + randomBytes(3).toString("hex");
  const [p] = await db
    .insert(schema.payments)
    .values({
      publicId: "console_" + randomBytes(5).toString("hex"),
      clientId: client!.id,
      amountCop: 50_000n,
      asset: "USDC",
      network: "base-sepolia",
      amountCryptoRaw: copToRaw(50_000n, RATE, 6), // 12.5 USDC
      rateCopPerUnitE6: RATE,
      address: deriveAddress(idx, "base-sepolia"),
      derivationIndex: idx,
      status: "partially_paid",
      confirmedRaw: 4_000_000n,
      pendingRaw: 2_000_000n,
      quoteExpiresAt: new Date(Date.now() + 15 * 60_000),
      graceExpiresAt: new Date(Date.now() + 90 * 60_000),
      metadata: JSON.stringify({ order_id: orderId }),
    })
    .returning();

  const confirmedTx = "0x" + randomBytes(32).toString("hex");
  const pendingTx = "0x" + randomBytes(32).toString("hex");
  await db.insert(schema.deposits).values([
    {
      paymentId: p!.id,
      network: "base-sepolia",
      txHash: confirmedTx,
      logIndex: 0,
      fromAddress: "0xconsolepayer",
      asset: "USDC",
      amountRaw: 4_000_000n,
      blockNumber: 1234n,
      confirmed: true,
    },
    {
      paymentId: p!.id,
      network: "base-sepolia",
      txHash: pendingTx,
      logIndex: 1,
      fromAddress: "0xconsolepayer",
      asset: "USDC",
      amountRaw: 2_000_000n,
      blockNumber: 1240n,
      confirmed: false,
    },
  ]);
  await db.insert(schema.webhookJobs).values({
    clientId: client!.id,
    paymentId: p!.id,
    event: "payment.partially_paid",
    payload: JSON.stringify({ event: "payment.partially_paid" }),
    attempts: 2,
  });
  await db.insert(schema.ledgerEntries).values({
    clientId: client!.id,
    paymentId: p!.id,
    amountCop: 50_000n,
    type: "payment_credit",
  });

  // A second merchant, with its own payment, so the assertions below can fail.
  // "limit paginates without losing total" needs more than one payment to exist
  // and "merchant filter scopes to that merchant" needs a merchant to exclude —
  // with a single seeded row both passed only on the residue of an earlier run,
  // and failed against a fresh database.
  const [other] = await db
    .insert(schema.clients)
    .values({
      name: "Other Test Merchant",
      apiKeyHash: Buffer.from(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(randomBytes(16).toString("hex"))
        )
      ).toString("hex"),
      webhookSecret: "whsec_" + randomBytes(8).toString("hex"),
    })
    .returning();

  const otherIdx = await reserveDerivationIndex();
  await db.insert(schema.payments).values({
    publicId: "console_" + randomBytes(5).toString("hex"),
    clientId: other!.id,
    amountCop: 25_000n,
    asset: "USDC",
    network: "base-sepolia",
    amountCryptoRaw: copToRaw(25_000n, RATE, 6),
    rateCopPerUnitE6: RATE,
    address: deriveAddress(otherIdx, "base-sepolia"),
    derivationIndex: otherIdx,
    // Deliberately not partially_paid: the status filter asserts every returned
    // row matches, so this row has to be one the filter drops.
    status: "pending",
    quoteExpiresAt: new Date(Date.now() + 15 * 60_000),
  });

  console.log("\n[GET /admin serves the console SPA]");
  let res = await get("/admin");
  assert(res.status === 200, "/admin -> 200");
  let html = await res.text();
  assert(html.includes(`id="root"`), "SPA root mount point present");
  res = await get(`/admin/p/${p!.publicId}`);
  assert(res.status === 200, "deep link /admin/p/:id -> 200 (client-routed)");
  res = await get("/admin/deposits");
  assert(res.status === 200, "/admin/deposits -> 200 (client-routed)");

  // The gate is the deployment's only protection for a cross-merchant surface,
  // so assert it actually refuses when configured. The shell itself is public by
  // design — it is static markup, and the login screen has to be servable.
  if (env.adminPassword) {
    console.log("\n[session gate]");
    assert(
      (await app.request("/admin/api/stats")).status === 401,
      "data route without a session -> 401"
    );
    assert(
      (await app.request("/admin/api/auth/me")).status === 401,
      "identity probe without a session -> 401"
    );
    assert(
      (await app.request("/admin")).status === 200,
      "console shell stays public so the login screen can render"
    );

    const bad = await app.request("/admin/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: env.adminUser, password: "not-the-password" }),
    });
    assert(bad.status === 401, "wrong password -> 401");
    assert(
      ((await bad.json()) as any).error === "invalid_credentials" &&
        !bad.headers.get("set-cookie"),
      "rejection names neither half of the credential, and issues no cookie"
    );

    const unknown = await app.request("/admin/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: `nobody-${randomBytes(4).toString("hex")}`, password: "x" }),
    });
    assert(
      unknown.status === 401 && ((await unknown.json()) as any).error === "invalid_credentials",
      "unknown operator is indistinguishable from a wrong password"
    );

    const me = await json("/admin/api/auth/me");
    assert(me.status === 200 && me.body.mode === "session", "signed-in identity probe -> session");
    assert(me.body.user?.username === env.adminUser, "the session names the bootstrap operator");
    assert(
      !JSON.stringify(me.body).includes("password"),
      "no password material in the identity payload"
    );
  }

  console.log("\n[GET /admin/api/stats]");
  let r = await json("/admin/api/stats");
  assert(r.status === 200, "stats -> 200");
  assert(typeof r.body.sweeps?.by_status?.planned === "number", "sweep status tallies present");
  assert(Array.isArray(r.body.sweeps?.unswept), "unswept value per (network, asset) present");
  assert(
    typeof r.body.config?.sweep_enabled === "boolean" &&
      Array.isArray(r.body.config?.sweep_pairings),
    "the sweeping switches and the sweepable pairings are surfaced"
  );
  assert(
    ["pending", "detecting", "partially_paid", "paid", "expired", "underpaid_expired"].every(
      (k) => typeof r.body.payments.by_status[k] === "number"
    ),
    "by_status covers all six states"
  );
  assert(r.body.payments.by_status.partially_paid >= 1, "our partially_paid payment is counted");
  assert(typeof r.body.payments.paid_cop === "string", "paid_cop serialized as a string");
  assert(r.body.deposits.unconfirmed >= 1, "unconfirmed deposit counted");
  assert(r.body.webhooks.pending >= 1, "pending webhook job counted");
  assert(r.body.config.dust_bps === 50, "live dust tolerance surfaced");
  const base = r.body.networks.find((n: any) => n.id === "base-sepolia");
  assert(base?.confirmations === 3, "base-sepolia requires 3 confirmations");
  assert(
    base?.explorer?.tx?.includes("{v}"),
    "explorer tx template carries the {v} placeholder"
  );

  console.log("\n[GET /admin/api/clients]");
  r = await json("/admin/api/clients");
  assert(r.status === 200, "clients -> 200");
  const cl = r.body.clients.find((c: any) => c.id === client!.id);
  assert(!!cl, "our merchant is listed");
  assert(typeof cl.balance_cop === "string", "balance_cop serialized as a string");
  assert(cl.payments >= 1, "payment count per merchant");

  console.log("\n[GET /admin/api/payments]");
  r = await json(`/admin/api/payments?q=${p!.publicId}`);
  assert(r.status === 200, "payments -> 200");
  assert(r.body.total === 1, "search by public id finds exactly one");
  const row = r.body.payments[0];
  assert(row.amount_cop === "50000", "amount_cop as string");
  assert(row.amount_crypto_raw === "12500000", "12.5 USDC required for 50k COP @4000");
  assert(row.confirmed_raw === "4000000", "confirmed_raw as string");
  assert(row.pending_raw === "2000000", "pending_raw as string");
  assert(row.deposits === 2, "deposit count joined onto the row");
  assert(row.client_name === "Console Test Merchant", "merchant name joined");
  assert(row.decimals === 6, "token decimals resolved from the registry");
  assert(row.metadata?.order_id === orderId, "metadata parsed, not raw JSON");

  console.log("\n[filters and search]");
  r = await json("/admin/api/payments?status=partially_paid");
  assert(
    r.body.payments.every((x: any) => x.status === "partially_paid"),
    "status filter narrows to one state"
  );
  r = await json("/admin/api/payments?network=base-sepolia");
  assert(
    r.body.payments.every((x: any) => x.network === "base-sepolia"),
    "network filter narrows to one network"
  );
  r = await json(`/admin/api/payments?client_id=${client!.id}`);
  assert(r.body.total === 1, "merchant filter scopes to that merchant");
  r = await json(`/admin/api/payments?q=${confirmedTx}`);
  assert(r.body.total === 1, "search by tx hash reaches across the deposits table");
  r = await json(`/admin/api/payments?q=${orderId}`);
  assert(r.body.total === 1, "search by order_id matches inside metadata");
  r = await json(`/admin/api/payments?q=${p!.address}`);
  assert(r.body.total === 1, "search by deposit address");
  r = await json("/admin/api/payments?client_id=not-a-uuid");
  assert(r.status === 200, "malformed client_id is ignored, not a 500");
  r = await json("/admin/api/payments?status=bogus");
  assert(r.status === 200, "unknown status is ignored, not a 500");
  r = await json("/admin/api/payments?limit=1");
  assert(r.body.payments.length === 1 && r.body.total > 1, "limit paginates without losing total");

  console.log("\n[GET /admin/api/payments/:publicId]");
  r = await json(`/admin/api/payments/${p!.publicId}`);
  assert(r.status === 200, "detail -> 200");
  // 12.5 USDC less the 0.5% dust tolerance.
  assert(r.body.payment.threshold_raw === "12437500", "settle threshold = required - dust tolerance");
  assert(r.body.payment.rate_cop_per_unit_e6 === "4000000000", "frozen rate exposed as a string");
  assert(r.body.payment.derivation_index === idx, "HD derivation index exposed");
  assert(r.body.client.webhook_url === "https://webhook.site/console-test", "merchant endpoint shown");
  assert(r.body.token?.decimals === 6, "token metadata resolved");
  assert(r.body.network?.family === "evm", "network family resolved");
  assert(r.body.deposits.length === 2, "both deposits returned");
  assert(
    r.body.deposits.every((d: any) => typeof d.amount_raw === "string" && typeof d.block_number === "string"),
    "deposit bigints serialized as strings"
  );
  assert(r.body.webhooks.length === 1 && r.body.webhooks[0].attempts === 2, "webhook attempt count");
  assert(r.body.ledger.length === 1 && r.body.ledger[0].amount_cop === "50000", "ledger entry credited");
  res = await get("/admin/api/payments/does-not-exist");
  assert(res.status === 404, "unknown payment -> 404");

  console.log("\n[GET /admin/api/deposits]");
  r = await json(`/admin/api/deposits?q=${confirmedTx}`);
  assert(r.status === 200, "deposits -> 200");
  assert(r.body.deposits.length === 1, "search by tx hash finds the deposit");
  assert(r.body.deposits[0].payment_id === p!.publicId, "deposit carries its payment's public id");
  assert(r.body.deposits[0].payment_status === "partially_paid", "deposit carries the payment status");
  assert(r.body.deposits[0].amount_raw === "4000000", "deposit amount as string");
  r = await json(`/admin/api/deposits?confirmed=false&q=${pendingTx}`);
  assert(
    r.body.deposits.length === 1 && r.body.deposits[0].confirmed === false,
    "confirmed=false filter isolates unconfirmed deposits"
  );
  r = await json(`/admin/api/deposits?confirmed=true&q=${pendingTx}`);
  assert(r.body.deposits.length === 0, "confirmed=true excludes it");

  console.log("\n[GET /admin/api/sweeps]");
  // A row per status is inserted directly: the sweeper itself needs a chain and
  // a treasury, while this is checking the read surface the console renders.
  const sweptAddress = deriveAddress(idx, "eth-sepolia");
  const sweepTx = "0x" + randomBytes(32).toString("hex");
  await db.insert(schema.sweeps).values([
    {
      network: "eth-sepolia", address: sweptAddress, derivationIndex: idx, asset: "USDC",
      amountRaw: 4_000_000n, toAddress: "0x000000000000000000000000000000000000dEaD",
      via: "eip3009", status: "confirmed", txHash: sweepTx, blockNumber: 900n,
      feeRaw: 120_000_000_000_000n,
    },
    {
      network: "eth-sepolia", address: sweptAddress, derivationIndex: idx, asset: "USDT",
      amountRaw: 1_000n, toAddress: "0x000000000000000000000000000000000000dEaD",
      via: "eip3009", status: "skipped", reason: "below_floor",
    },
  ]);

  r = await json("/admin/api/sweeps");
  assert(r.status === 200, "sweeps -> 200");
  assert(Array.isArray(r.body.statuses) && r.body.statuses.includes("skipped"),
    "the status vocabulary is served for the filter");
  r = await json(`/admin/api/sweeps?q=${sweepTx}`);
  assert(r.body.sweeps.length === 1, "search by transaction hash finds the sweep");
  const sw = r.body.sweeps[0];
  assert(sw.amount_raw === "4000000", "sweep amount serialized as a string");
  assert(sw.fee_raw === "120000000000000", "fee serialized as a string");
  // Sepolia quotes stablecoins and accepts no native asset, but its fees are
  // still charged in ETH — the fee currency is not the quoted one.
  assert(sw.fee_asset === "ETH" && sw.fee_decimals === 18, "the fee is denominated in the chain's fee currency");
  assert(sw.decimals === 6, "the swept asset's decimals come from the registry");
  assert(sw.derivation_index === idx, "the sweep carries the derivation index of its address");
  r = await json(`/admin/api/sweeps?status=skipped&q=${sweptAddress}`);
  assert(
    r.body.sweeps.length === 1 && r.body.sweeps[0].reason === "below_floor",
    "the status filter isolates deferrals, and the reason explains them"
  );
  assert(
    !/private|mnemonic|signature/i.test(JSON.stringify(r.body)),
    "no key material or signature reaches the console"
  );

  console.log("\n[GET /admin/api/wallets]");
  // The only console route that reads a chain. It must answer without one:
  // every network here either has no RPC credential or is unreachable from a
  // test run, and reporting that honestly is the behaviour being checked.
  r = await json("/admin/api/wallets");
  assert(r.status === 200, "wallets -> 200");
  assert(
    r.body.networks.length === NETWORK_IDS.length,
    "every served network is listed, including ones with no credential"
  );
  const evm = r.body.networks.find((n: any) => n.network === "bsc-testnet");
  assert(evm?.reachable === false && typeof evm?.error === "string",
    "a network without its RPC credential reports unreachable, with the reason");
  assert(
    evm.wallets.every((w: any) => w.balances.length === 0 && typeof w.note === "string"),
    "…and reports no balances with an explanation — unknown is never rendered as zero"
  );
  assert(
    r.body.networks.every((n: any) =>
      n.wallets.map((w: any) => w.role).join() === "treasury,relayer"
    ),
    "every network reports both wallet roles"
  );
  const relayers = new Set(
    r.body.networks
      .filter((n: any) => n.family === "evm")
      .map((n: any) => n.wallets.find((w: any) => w.role === "relayer").address)
  );
  assert(relayers.size === 1, "one EVM relayer address across every EVM network");
  assert(
    !/private|mnemonic|secret/i.test(JSON.stringify(r.body)),
    "no key material reaches the wallets view"
  );
  assert(typeof r.body.age_s === "number", "the response reports how stale its readings are");

  console.log("\n[GET /admin/api/users]");
  r = await json("/admin/api/users");
  assert(r.status === 200, "users -> 200");
  assert(
    !/password/i.test(JSON.stringify(r.body)),
    "no password material in the operator list — hashes are never selected"
  );
  if (env.adminPassword) {
    const me = r.body.users.find((u: any) => u.username === env.adminUser);
    assert(!!me, "the bootstrap operator is listed");
    assert(me.is_you === true && r.body.signed_in_as === me.id, "the caller is marked as themselves");
    assert(me.active_sessions >= 1, "the session this test signed in with is counted");
    assert(me.is_active === true, "the bootstrap operator is active");
  } else {
    assert(r.body.signed_in_as === null, "open console reports nobody signed in");
  }

  console.log("\n[GET /admin/api/diagnostics]");
  r = await json("/admin/api/diagnostics");
  assert(r.status === 200, "diagnostics -> 200");
  assert(r.body.service?.["service.name"] === "crypto-gateway", "service resource attributes present");
  assert(typeof r.body.process?.uptime_s === "number", "process uptime reported");
  assert(r.body.config?.["config.dust_bps"] === Number(env.dustBps), "live dust tolerance reported");
  // Counted from the registry, not a literal: diagnostics reports every network
  // that exists, including mainnets the build is withholding.
  assert(
    r.body.networks?.length === Object.keys(NETWORKS).length &&
      r.body.networks.every((n: any) => "enabled" in n),
    "every network reported with its enabled flag"
  );
  assert(
    r.body.networks.every((n: any) => n.offered === NETWORK_IDS.includes(n.id)),
    "diagnostics distinguishes offered networks from withheld ones"
  );
  const withheld = r.body.networks.filter((n: any) => !n.offered);
  assert(
    withheld.every((n: any) => n.testnet === false) &&
      withheld.every((n: any) => n.enabled === false),
    "only mainnets are withheld, and a withheld network never reads as enabled"
  );
  const bsc = r.body.networks.find((n: any) => n.id === "bsc-testnet");
  assert(bsc?.native === "BNB", "bsc-testnet reports BNB as its native asset");
  assert(
    Array.isArray(bsc?.tokens) && bsc.tokens.includes("USDT") && bsc.tokens.includes("USDC"),
    "bsc-testnet reports both BEP20 tokens"
  );
  assert(typeof r.body.logging?.level === "string", "effective log level reported");
  assert(r.body.metrics?.counters !== undefined, "metric counters present");
  // The pool was created and queried by this very script.
  assert(Number(r.body.metrics.counters["db.queries"] ?? 0) > 0, "db queries counted");

  console.log("\n[GET /admin/api/logs]");
  r = await json("/admin/api/logs?limit=50");
  assert(r.status === 200, "logs -> 200");
  assert(Array.isArray(r.body.records) && r.body.records.length > 0, "log tail returns records");
  assert(
    r.body.records.every((l: any) => l.time && l.level && l.scope),
    "every record carries time, level and scope"
  );
  // The requests this script has already made are in the buffer.
  r = await json("/admin/api/logs?scope=http&limit=50");
  assert(
    r.body.records.length > 0 && r.body.records.every((l: any) => l.scope.startsWith("http")),
    "scope filter narrows to one module"
  );
  r = await json("/admin/api/logs?level=error&limit=50");
  assert(
    r.body.records.every((l: any) => l.level === "ERROR" || l.level === "FATAL"),
    "level filter keeps only that severity and above"
  );
  // `url.path` is an attribute, not part of the message, so this only passes if
  // the search reads attribute values. The 404 probes above put it in the buffer
  // at WARN, which is the level this script runs the services at (see ./quiet).
  r = await json("/admin/api/logs?q=does-not-exist&limit=50");
  assert(
    r.body.records.length > 0 &&
      r.body.records.every((l: any) => JSON.stringify(l.attributes).includes("does-not-exist")),
    "text search matches attribute values"
  );
  const cursor = r.body.cursor;
  r = await json(`/admin/api/logs?since=${cursor}&limit=50`);
  assert(
    r.body.records.every((l: any) => l.seq > cursor),
    "since= returns only newer records"
  );
  // The log tail must never become a way to read the environment's secrets.
  const logDump = await (await get("/admin/api/logs?limit=200")).text();
  assert(!logDump.includes(env.mnemonic.slice(0, 24)), "mnemonic never reaches the log tail");

  console.log("\n[no bigint leaks as JSON numbers]");
  const raw = await (await get(`/admin/api/payments/${p!.publicId}`)).text();
  // Both checks below are negative, so an error body would satisfy them without
  // ever seeing an amount. Assert we are reading the real payload first.
  assert(raw.includes(`"amount_cop"`), "detail payload actually returned");
  assert(!/"amount_cop":\s*\d/.test(raw), "amount_cop is quoted, never a bare number");
  assert(!/"amount_raw":\s*\d/.test(raw), "amount_raw is quoted, never a bare number");

  // -- The write surface ------------------------------------------------
  // Everything above this line is a SELECT. Everything below mutates, and each
  // one has to leave an admin_audit_log row behind — that trail is the condition
  // AGENTS.md puts on the console having a write surface at all.
  console.log("\n[console write surface]");

  /** A console request with a body, carrying whatever session we hold. */
  const send = (
    path: string,
    method: string,
    body?: unknown,
    headers: Record<string, string> = {}
  ) =>
    app.request(path, {
      method,
      headers: {
        ...adminHeaders,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  if (!env.adminPassword) {
    // The guard's entire purpose. With no operator account there is nobody to
    // attribute a change to, so writes are refused while reads carry on working —
    // and this script says plainly which half it just skipped, rather than
    // reporting a pass over checks it never ran.
    const refused = await send("/admin/api/clients", "POST", { name: "Should Not Exist" });
    assert(refused.status === 403, "an open console refuses a write -> 403");
    assert(
      ((await refused.json()) as any).error === "auth_required_for_mutation",
      "...and names the reason"
    );
    assert((await get("/admin/api/stats")).status === 200, "...while reads still answer");
    const [ghost] = await db
      .select()
      .from(schema.clients)
      .where(eq(schema.clients.name, "Should Not Exist"));
    assert(!ghost, "...and nothing was written");
    console.log(
      "  note- ADMIN_PASSWORD is unset, so the write surface itself was NOT exercised.\n" +
        "        Re-run with ADMIN_PASSWORD set to cover merchant CRUD and console payments."
    );
  } else {
    console.log("\n  [guards]");
    const wrongType = await app.request("/admin/api/clients", {
      method: "POST",
      headers: { ...adminHeaders, "content-type": "text/plain" },
      body: JSON.stringify({ name: "Wrong Content Type" }),
    });
    assert(wrongType.status === 415, "a body that is not application/json -> 415");

    const noSession = await app.request("/admin/api/clients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "No Session" }),
    });
    assert(noSession.status === 401, "a write with no session -> 401");

    console.log("\n  [merchant create]");
    const createRes = await send("/admin/api/clients", "POST", {
      name: "Console Created Merchant",
      webhook_url: "https://webhook.site/console-created",
    });
    assert(createRes.status === 201, "merchant create -> 201");
    const created = (await createRes.json()) as any;
    const merchantId: string = created.client.id;
    const firstKey: string = created.api_key;
    const firstSecret: string = created.webhook_secret;

    assert(typeof firstKey === "string" && firstKey.startsWith("gk_"), "an api key is returned");
    assert(
      typeof firstSecret === "string" && firstSecret.startsWith("whsec_"),
      "a webhook secret is returned — the one thing seed.ts never surfaced"
    );
    const [storedRow] = await db
      .select()
      .from(schema.clients)
      .where(eq(schema.clients.id, merchantId));
    assert(
      storedRow!.apiKeyHash === (await hashApiKey(firstKey)),
      "what is stored is the hash of the key that was handed out"
    );
    assert(
      (await app.request("/api/me", { headers: { "X-Api-Key": firstKey } })).status === 200,
      "the new key authenticates against the merchant API"
    );

    console.log("\n  [merchant detail never re-serves a secret]");
    const detail = await json(`/admin/api/clients/${merchantId}`);
    assert(detail.status === 200, "merchant detail -> 200");
    assert(detail.body.client.api_key_hash_prefix.length === 12, "a hash prefix is shown");
    assert(detail.body.deletable === true, "a merchant with nothing pointing at it is deletable");
    const detailText = JSON.stringify(detail.body);
    assert(!detailText.includes(firstKey), "the api key is never returned again");
    assert(!detailText.includes(firstSecret), "the webhook secret is never returned again");

    console.log("\n  [merchant update]");
    const patched = await send(`/admin/api/clients/${merchantId}`, "PATCH", {
      name: "Renamed Merchant",
    });
    assert(patched.status === 200, "merchant update -> 200");
    assert(((await patched.json()) as any).client.name === "Renamed Merchant", "the rename lands");

    const badUrl = await send(`/admin/api/clients/${merchantId}`, "PATCH", {
      webhook_url: "ftp://example.com/hook",
    });
    assert(badUrl.status === 400, "a webhook url that is not http(s) is refused");

    let trail = await json(`/admin/api/audit?target_id=${merchantId}`);
    const updateEntry = trail.body.entries.find((e: any) => e.action === "merchant.update");
    assert(Boolean(updateEntry), "the update wrote an audit row");
    assert(
      updateEntry?.detail?.before?.name === "Console Created Merchant" &&
        updateEntry?.detail?.after?.name === "Renamed Merchant",
      "the audit row carries before and after"
    );
    assert(updateEntry?.operator_username === env.adminUser, "the audit row names the operator");
    assert(typeof updateEntry?.trace_id === "string", "the audit row carries its trace id");

    console.log("\n  [credential rotation]");
    const rotated = (await (
      await send(`/admin/api/clients/${merchantId}/api-key`, "POST", {})
    ).json()) as any;
    assert(rotated.api_key !== firstKey, "rotation issues a different key");
    assert(
      (await app.request("/api/me", { headers: { "X-Api-Key": firstKey } })).status === 401,
      "the previous key stops authenticating immediately"
    );
    assert(
      (await app.request("/api/me", { headers: { "X-Api-Key": rotated.api_key } })).status === 200,
      "the replacement authenticates"
    );

    const newSecret = (await (
      await send(`/admin/api/clients/${merchantId}/webhook-secret`, "POST", {})
    ).json()) as any;
    assert(newSecret.webhook_secret !== firstSecret, "a different webhook secret is issued");

    console.log("\n  [payment created by an operator]");
    // Primed so this exercises the real createPayment() without reaching
    // CoinGecko — the whole point is that the console path and the merchant path
    // are the same code, so mirroring it here would prove nothing.
    primeRateCache("USDC", RATE);
    const payRes = await send("/admin/api/payments", "POST", {
      client_id: merchantId,
      amount_cop: "50000",
      asset: "USDC",
      network: "base-sepolia",
      metadata: { order_id: "ORD-CONSOLE-WRITE" },
    });
    assert(payRes.status === 201, "console payment create -> 201");
    const consolePayment = (await payRes.json()) as any;
    assert(
      consolePayment.amount_crypto_raw === "12500000",
      "the operator path quotes exactly like the merchant path"
    );
    assert(
      typeof consolePayment.checkout_url === "string" &&
        consolePayment.checkout_url.endsWith(`/pay/${consolePayment.id}`),
      "a checkout url is returned, built the same way"
    );

    const listed = await json(`/admin/api/payments?client_id=${merchantId}`);
    assert(
      listed.body.payments.some((x: any) => x.id === consolePayment.id),
      "the payment shows up in the console's own list"
    );
    trail = await json("/admin/api/audit?action=payment.create");
    assert(
      trail.body.entries.some((e: any) => e.target_id === consolePayment.id),
      "the payment create wrote an audit row"
    );

    console.log("\n  [delete semantics]");
    const hardRefused = await send(`/admin/api/clients/${merchantId}?hard=true`, "DELETE");
    assert(hardRefused.status === 409, "hard delete of a merchant with payments -> 409");
    const refusal = (await hardRefused.json()) as any;
    assert(refusal.counts.payments >= 1, "the refusal reports what still references it");

    const soft = await send(`/admin/api/clients/${merchantId}`, "DELETE");
    assert(soft.status === 200, "soft delete -> 200");
    assert(((await soft.json()) as any).client.is_active === false, "the merchant is deactivated");
    assert(
      (await app.request("/api/me", { headers: { "X-Api-Key": rotated.api_key } })).status === 401,
      "a deactivated merchant's key stops authenticating"
    );
    const refusedPayment = await send("/admin/api/payments", "POST", {
      client_id: merchantId,
      amount_cop: "50000",
      asset: "USDC",
      network: "base-sepolia",
    });
    assert(refusedPayment.status === 409, "a payment for a deactivated merchant -> 409");

    const throwawayId = (
      (await (
        await send("/admin/api/clients", "POST", { name: "Throwaway Merchant" })
      ).json()) as any
    ).client.id;
    const gone = await send(`/admin/api/clients/${throwawayId}?hard=true`, "DELETE");
    assert(gone.status === 200, "hard delete of an unused merchant -> 200");
    const [absent] = await db
      .select()
      .from(schema.clients)
      .where(eq(schema.clients.id, throwawayId));
    assert(!absent, "the row is actually gone");
    const orphaned = await json(`/admin/api/audit?target_id=${throwawayId}`);
    assert(
      orphaned.body.entries.some((e: any) => e.action === "merchant.delete"),
      "the deletion is still on the record after the merchant is gone"
    );

    console.log("\n  [no credential ever reaches the trail]");
    const auditDump = await (await get("/admin/api/audit?limit=200")).text();
    assert(!auditDump.includes(firstKey), "the first api key is not in the audit trail");
    assert(!auditDump.includes(rotated.api_key), "the rotated api key is not in the audit trail");
    assert(!auditDump.includes(firstSecret), "the first webhook secret is not in the audit trail");
    assert(
      !auditDump.includes(newSecret.webhook_secret),
      "the rotated webhook secret is not in the audit trail"
    );
    const writeLogs = await (await get("/admin/api/logs?limit=300")).text();
    assert(!writeLogs.includes(firstKey), "no api key reaches the log tail either");
  }

  // Last, because it spends the session every check above needed: a logout has
  // to end the session server-side, not just clear the browser's cookie.
  if (env.adminPassword) {
    console.log("\n[logout revokes the session]");
    const out = await app.request("/admin/api/auth/logout", {
      method: "POST",
      headers: adminHeaders,
    });
    assert(out.status === 200, "logout -> 200");
    assert(
      (await get("/admin/api/stats")).status === 401,
      "the same cookie no longer opens a data route"
    );
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
