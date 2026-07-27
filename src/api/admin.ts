/**
 * Read-only backoffice API for the internal console served at /admin.
 *
 * Cross-merchant by design: this is an internal operator tool, so it exposes
 * every merchant's payments plus operational internals the merchant API
 * deliberately hides (derivation index, frozen rate, webhook delivery attempts,
 * ledger entries).
 *
 * Access is therefore all-or-nothing, and gated one level up in ./routes.ts by
 * the session guard in ./admin-auth.ts: a named operator from `admin_users`
 * signs in and carries a session cookie. Production boots refuse to start
 * without `ADMIN_PASSWORD` (the bootstrap operator's password); local
 * development may leave it unset and run open. There is no per-merchant scoping
 * here — an operator who reaches these routes sees everything.
 *
 * Every route is a SELECT. Nothing here mutates the payment state machine, so
 * the console can never corrupt a payment no matter what it is asked to render.
 */
import { Hono } from "hono";
import { and, count, desc, eq, ilike, inArray, or, sql, sum } from "drizzle-orm";
import { db, schema } from "../db";
import { NETWORKS, env, tokenFor, configSummary, missingCredential, type NetworkId } from "../config";
import { requiredWithTolerance } from "../services/payments";
import { rateCacheState } from "../services/rates";
import { activeSessionCounts } from "../services/admin-auth";
import {
  recentLogs,
  loggingConfig,
  otlpStatus,
  processStats,
  snapshot,
  resource,
  LEVELS,
  type Level,
} from "../observability";

export const adminApi = new Hono();

const PAGE_MAX = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATUSES = schema.paymentStatus.enumValues;
type Status = (typeof STATUSES)[number];

/** bigint -> decimal string. JSON.stringify throws on bigint, so every money field goes through here. */
const s = (v: bigint | null | undefined): string | null => (v == null ? null : v.toString());

function networkMeta(id: string) {
  const net = NETWORKS[id as NetworkId];
  if (!net) return null;
  return {
    id,
    family: net.family,
    confirmations: Number(net.confirmations),
    explorer: net.explorer,
    chain_id: net.family === "evm" ? net.chain.id : null,
  };
}

// -- Filters shared by the list and its count ---------------------------
function paymentFilters(q: Record<string, string | undefined>) {
  const conds = [];

  if (q.status && (STATUSES as readonly string[]).includes(q.status)) {
    conds.push(eq(schema.payments.status, q.status as Status));
  }
  if (q.network && NETWORKS[q.network as NetworkId]) {
    conds.push(eq(schema.payments.network, q.network));
  }
  if (q.asset) conds.push(eq(schema.payments.asset, q.asset));
  // An invalid uuid would make Postgres error rather than return nothing.
  if (q.client_id && UUID_RE.test(q.client_id)) {
    conds.push(eq(schema.payments.clientId, q.client_id));
  }

  const term = q.q?.trim();
  if (term) {
    const pat = `%${term}%`;
    conds.push(
      or(
        ilike(schema.payments.publicId, pat),
        ilike(schema.payments.address, pat),
        // metadata is stored as a JSON string, so a substring match finds
        // order_id and any other merchant field without parsing it.
        ilike(schema.payments.metadata, pat),
        // Searching by txHash is the common case when reconciling against an
        // explorer, and the hash lives one table over.
        sql`exists (select 1 from ${schema.deposits} where ${schema.deposits.paymentId} = ${schema.payments.id} and ${schema.deposits.txHash} ilike ${pat})`
      )
    );
  }

  return conds.length ? and(...conds) : undefined;
}

// -- GET /admin/api/stats ----------------------------------------------
// Header readout: payment counts per status, on-chain and queue health, and the
// business parameters currently in force (so a surprising quote is explainable).
adminApi.get("/stats", async (c) => {
  const [byStatus, byNetwork, deposits, queue, clients] = await Promise.all([
    db
      .select({
        status: schema.payments.status,
        n: count(),
        cop: sum(schema.payments.amountCop),
      })
      .from(schema.payments)
      .groupBy(schema.payments.status),

    db
      .select({ network: schema.payments.network, n: count() })
      .from(schema.payments)
      .groupBy(schema.payments.network),

    db
      .select({
        total: count(),
        unconfirmed: sql<number>`(count(*) filter (where ${schema.deposits.confirmed} = false))::int`,
      })
      .from(schema.deposits),

    db
      .select({
        pending: sql<number>`(count(*) filter (where ${schema.webhookJobs.deliveredAt} is null and ${schema.webhookJobs.attempts} < 8))::int`,
        delivered: sql<number>`(count(*) filter (where ${schema.webhookJobs.deliveredAt} is not null))::int`,
        // 8 attempts is where deliverPendingWebhooks stops retrying: these are
        // dead letters that will never be delivered without intervention.
        dead: sql<number>`(count(*) filter (where ${schema.webhookJobs.deliveredAt} is null and ${schema.webhookJobs.attempts} >= 8))::int`,
      })
      .from(schema.webhookJobs),

    db.select({ n: count() }).from(schema.clients),
  ]);

  const counts = Object.fromEntries(STATUSES.map((st) => [st, 0])) as Record<Status, number>;
  for (const row of byStatus) counts[row.status] = Number(row.n);

  const paidCop = byStatus.find((r) => r.status === "paid")?.cop ?? "0";

  return c.json({
    payments: {
      total: byStatus.reduce((acc, r) => acc + Number(r.n), 0),
      by_status: counts,
      by_network: byNetwork.map((r) => ({ network: r.network, n: Number(r.n) })),
      paid_cop: paidCop ?? "0",
    },
    deposits: { total: Number(deposits[0]?.total ?? 0), unconfirmed: deposits[0]?.unconfirmed ?? 0 },
    webhooks: {
      pending: queue[0]?.pending ?? 0,
      delivered: queue[0]?.delivered ?? 0,
      dead: queue[0]?.dead ?? 0,
    },
    clients: Number(clients[0]?.n ?? 0),
    // Surfacing the live parameters makes a frozen quote or a dust-tolerance
    // settle reproducible without reading .env on the server.
    config: {
      quote_ttl_min: env.quoteTtlMin,
      grace_ttl_min: env.graceTtlMin,
      spread_bps: Number(env.spreadBps),
      dust_bps: Number(env.dustBps),
    },
    networks: Object.keys(NETWORKS).map(networkMeta),
    statuses: STATUSES,
  });
});

// -- GET /admin/api/clients --------------------------------------------
// Populates the merchant filter; balance and webhook URL come along because
// both are things you check while testing a settlement.
//
// The payment tally is a GROUP BY merged in JS rather than a correlated
// subquery in the select list. Drizzle only qualifies column names inside a raw
// `sql` template when the query has a join or the template sits in a WHERE
// clause; in a single-table select list it emits bare names, so
// `where "client_id" = "id"` silently compares two columns of `payments` to each
// other and every count comes back 0. An explicit aggregate cannot fail that way.
adminApi.get("/clients", async (c) => {
  const [rows, tallies] = await Promise.all([
    db
      .select({
        id: schema.clients.id,
        name: schema.clients.name,
        balanceCop: schema.clients.balanceCop,
        webhookUrl: schema.clients.webhookUrl,
        isActive: schema.clients.isActive,
        createdAt: schema.clients.createdAt,
      })
      .from(schema.clients)
      .orderBy(desc(schema.clients.createdAt)),

    db
      .select({ clientId: schema.payments.clientId, n: count() })
      .from(schema.payments)
      .groupBy(schema.payments.clientId),
  ]);

  const paymentsPerClient = new Map(tallies.map((t) => [t.clientId, Number(t.n)]));

  return c.json({
    clients: rows.map((r) => ({
      id: r.id,
      name: r.name,
      balance_cop: s(r.balanceCop),
      webhook_url: r.webhookUrl,
      is_active: r.isActive,
      created_at: r.createdAt,
      payments: paymentsPerClient.get(r.id) ?? 0,
    })),
  });
});

// -- GET /admin/api/payments -------------------------------------------
adminApi.get("/payments", async (c) => {
  const q = c.req.query();
  const where = paymentFilters(q);
  const limit = Math.min(Number(q.limit) || 50, PAGE_MAX);
  const offset = Math.max(Number(q.offset) || 0, 0);

  const [rows, total] = await Promise.all([
    db
      .select({
        uuid: schema.payments.id,
        publicId: schema.payments.publicId,
        clientId: schema.payments.clientId,
        clientName: schema.clients.name,
        status: schema.payments.status,
        amountCop: schema.payments.amountCop,
        asset: schema.payments.asset,
        network: schema.payments.network,
        amountCryptoRaw: schema.payments.amountCryptoRaw,
        confirmedRaw: schema.payments.confirmedRaw,
        pendingRaw: schema.payments.pendingRaw,
        overpaidRaw: schema.payments.overpaidRaw,
        address: schema.payments.address,
        quoteExpiresAt: schema.payments.quoteExpiresAt,
        graceExpiresAt: schema.payments.graceExpiresAt,
        paidAt: schema.payments.paidAt,
        createdAt: schema.payments.createdAt,
        metadata: schema.payments.metadata,
      })
      .from(schema.payments)
      .innerJoin(schema.clients, eq(schema.clients.id, schema.payments.clientId))
      .where(where)
      .orderBy(desc(schema.payments.createdAt))
      .limit(limit)
      .offset(offset),

    db.select({ n: count() }).from(schema.payments).where(where),
  ]);

  // Deposit tallies for this page only — an explicit aggregate rather than a
  // correlated subquery, for the reason documented on /clients above.
  const tallies = rows.length
    ? await db
        .select({ paymentId: schema.deposits.paymentId, n: count() })
        .from(schema.deposits)
        .where(inArray(schema.deposits.paymentId, rows.map((r) => r.uuid)))
        .groupBy(schema.deposits.paymentId)
    : [];
  const depositsPerPayment = new Map(tallies.map((t) => [t.paymentId, Number(t.n)]));

  return c.json({
    total: Number(total[0]?.n ?? 0),
    limit,
    offset,
    payments: rows.map((p) => ({
      id: p.publicId,
      client_id: p.clientId,
      client_name: p.clientName,
      status: p.status,
      amount_cop: s(p.amountCop),
      asset: p.asset,
      network: p.network,
      amount_crypto_raw: s(p.amountCryptoRaw),
      confirmed_raw: s(p.confirmedRaw),
      pending_raw: s(p.pendingRaw),
      overpaid_raw: s(p.overpaidRaw),
      address: p.address,
      decimals: tokenFor(p.network as NetworkId, p.asset)?.decimals ?? 6,
      quote_expires_at: p.quoteExpiresAt,
      grace_expires_at: p.graceExpiresAt,
      paid_at: p.paidAt,
      created_at: p.createdAt,
      metadata: p.metadata ? JSON.parse(p.metadata) : null,
      deposits: depositsPerPayment.get(p.uuid) ?? 0,
    })),
  });
});

// -- GET /admin/api/payments/:publicId ---------------------------------
// Everything about one payment: the row itself plus the three tables that
// explain it — on-chain deposits, webhook attempts, and ledger credits.
adminApi.get("/payments/:publicId", async (c) => {
  const [row] = await db
    .select({ payment: schema.payments, client: schema.clients })
    .from(schema.payments)
    .innerJoin(schema.clients, eq(schema.clients.id, schema.payments.clientId))
    .where(eq(schema.payments.publicId, c.req.param("publicId")));

  if (!row) return c.json({ error: "not_found" }, 404);
  const { payment: p, client } = row;

  const [deposits, webhooks, ledger] = await Promise.all([
    db
      .select()
      .from(schema.deposits)
      .where(eq(schema.deposits.paymentId, p.id))
      .orderBy(desc(schema.deposits.blockNumber)),
    db
      .select()
      .from(schema.webhookJobs)
      .where(eq(schema.webhookJobs.paymentId, p.id))
      .orderBy(desc(schema.webhookJobs.createdAt)),
    db
      .select()
      .from(schema.ledgerEntries)
      .where(eq(schema.ledgerEntries.paymentId, p.id))
      .orderBy(desc(schema.ledgerEntries.createdAt)),
  ]);

  const token = tokenFor(p.network as NetworkId, p.asset);

  return c.json({
    payment: {
      id: p.publicId,
      uuid: p.id,
      status: p.status,
      amount_cop: s(p.amountCop),
      asset: p.asset,
      network: p.network,
      amount_crypto_raw: s(p.amountCryptoRaw),
      confirmed_raw: s(p.confirmedRaw),
      pending_raw: s(p.pendingRaw),
      overpaid_raw: s(p.overpaidRaw),
      // The threshold that actually decides "paid" — required minus dust
      // tolerance. Shown so a settle slightly under the exact amount is
      // explainable rather than surprising.
      threshold_raw: s(requiredWithTolerance(p.amountCryptoRaw)),
      rate_cop_per_unit_e6: s(p.rateCopPerUnitE6),
      address: p.address,
      derivation_index: p.derivationIndex,
      quote_expires_at: p.quoteExpiresAt,
      grace_expires_at: p.graceExpiresAt,
      paid_at: p.paidAt,
      created_at: p.createdAt,
      updated_at: p.updatedAt,
      metadata: p.metadata ? JSON.parse(p.metadata) : null,
      decimals: token?.decimals ?? 6,
    },
    client: {
      id: client.id,
      name: client.name,
      balance_cop: s(client.balanceCop),
      webhook_url: client.webhookUrl,
      is_active: client.isActive,
    },
    token: token ? { address: token.address, decimals: token.decimals, symbol: p.asset } : null,
    network: networkMeta(p.network),
    deposits: deposits.map((d) => ({
      id: d.id,
      tx_hash: d.txHash,
      log_index: d.logIndex,
      from_address: d.fromAddress,
      amount_raw: s(d.amountRaw),
      block_number: s(d.blockNumber),
      confirmed: d.confirmed,
      created_at: d.createdAt,
    })),
    webhooks: webhooks.map((w) => ({
      id: w.id,
      event: w.event,
      attempts: w.attempts,
      next_attempt_at: w.nextAttemptAt,
      delivered_at: w.deliveredAt,
      created_at: w.createdAt,
      payload: w.payload,
    })),
    ledger: ledger.map((l) => ({
      id: l.id,
      amount_cop: s(l.amountCop),
      type: l.type,
      created_at: l.createdAt,
    })),
  });
});

// -- GET /admin/api/users ----------------------------------------------
// Who can open this console. Read-only like everything else here: accounts are
// created by the boot from ADMIN_PASSWORD, not through the console, so there is
// no mutation to authorise and no audit model to owe.
//
// Password hashes are not selected — not masked in the response, not selected —
// so no future change to this handler can start returning them.
adminApi.get("/users", async (c) => {
  const [rows, sessions] = await Promise.all([
    db
      .select({
        id: schema.adminUsers.id,
        username: schema.adminUsers.username,
        isActive: schema.adminUsers.isActive,
        lastLoginAt: schema.adminUsers.lastLoginAt,
        createdAt: schema.adminUsers.createdAt,
      })
      .from(schema.adminUsers)
      .orderBy(desc(schema.adminUsers.createdAt)),
    activeSessionCounts(),
  ]);

  const me = c.get("operator");

  return c.json({
    // Null when the console is running open (no ADMIN_PASSWORD): the Users view
    // uses this to explain why nobody is marked as signed in.
    signed_in_as: me?.id ?? null,
    bootstrap_username: env.adminUser,
    session_ttl_hours: env.adminSessionTtlHours,
    users: rows.map((u) => ({
      id: u.id,
      username: u.username,
      is_active: u.isActive,
      last_login_at: u.lastLoginAt,
      created_at: u.createdAt,
      active_sessions: sessions.get(u.id) ?? 0,
      is_you: me?.id === u.id,
    })),
  });
});

// -- GET /admin/api/logs -----------------------------------------------
// The process's own log tail, filterable. Testing a payment means following it
// across an HTTP request, a chain watcher and a confirmer, and the terminal
// holding that output is usually not the one you are testing from — a deployed
// container has none at all. Records are already redacted by the logging
// service; this is the same ADMIN_PASSWORD-gated surface as the rest.
//
//   ?level=warn        minimum severity
//   ?scope=watcher     scope prefix (watcher, payments, http, db, …)
//   ?q=abc123          substring over body, scope and attribute values
//   ?since=1234        only records after this sequence number (polling)
//   ?limit=200
adminApi.get("/logs", (c) => {
  const q = c.req.query();
  const level =
    q.level && q.level.toLowerCase() in LEVELS ? (q.level.toLowerCase() as Level) : undefined;

  return c.json({
    ...recentLogs({
      level,
      scope: q.scope?.trim() || undefined,
      q: q.q,
      since: q.since ? Number(q.since) : undefined,
      limit: q.limit ? Number(q.limit) : undefined,
    }),
    levels: Object.keys(LEVELS),
    config: loggingConfig(),
  });
});

// -- GET /admin/api/diagnostics ----------------------------------------
// Everything about the running process that is not a database row: the
// configuration in force, counters and timings since boot, the pricing caches,
// and where logs are being exported. The questions this answers — "is the
// watcher actually running", "how many provider calls did that test cost",
// "which rate is frozen in the cache" — are otherwise only answerable by
// reading the deployment's environment.
adminApi.get("/diagnostics", (c) =>
  c.json({
    service: resource,
    process: processStats(),
    config: configSummary(),
    networks: Object.keys(NETWORKS).map((id) => ({
      ...networkMeta(id),
      enabled: !missingCredential(id as NetworkId),
    })),
    logging: { ...loggingConfig(), otlp: otlpStatus() },
    rates: rateCacheState(),
    metrics: snapshot(),
  })
);

// -- GET /admin/api/deposits -------------------------------------------
// Flat feed of every Transfer the watchers have recorded, newest first. This is
// the view that answers "did the watcher see my transfer at all?" — a deposit
// can exist here with no effect on its payment (late arrival, terminal state),
// which the payment list alone would not reveal.
adminApi.get("/deposits", async (c) => {
  const q = c.req.query();
  const limit = Math.min(Number(q.limit) || 100, PAGE_MAX);

  const conds = [];
  if (q.network && NETWORKS[q.network as NetworkId]) {
    conds.push(eq(schema.deposits.network, q.network));
  }
  if (q.confirmed === "true") conds.push(eq(schema.deposits.confirmed, true));
  if (q.confirmed === "false") conds.push(eq(schema.deposits.confirmed, false));
  const term = q.q?.trim();
  if (term) {
    const pat = `%${term}%`;
    conds.push(
      or(
        ilike(schema.deposits.txHash, pat),
        ilike(schema.deposits.fromAddress, pat),
        ilike(schema.payments.publicId, pat)
      )
    );
  }
  const where = conds.length ? and(...conds) : undefined;

  const rows = await db
    .select({
      id: schema.deposits.id,
      txHash: schema.deposits.txHash,
      logIndex: schema.deposits.logIndex,
      network: schema.deposits.network,
      fromAddress: schema.deposits.fromAddress,
      amountRaw: schema.deposits.amountRaw,
      blockNumber: schema.deposits.blockNumber,
      confirmed: schema.deposits.confirmed,
      createdAt: schema.deposits.createdAt,
      paymentPublicId: schema.payments.publicId,
      paymentStatus: schema.payments.status,
      asset: schema.payments.asset,
    })
    .from(schema.deposits)
    .innerJoin(schema.payments, eq(schema.payments.id, schema.deposits.paymentId))
    .where(where)
    .orderBy(desc(schema.deposits.createdAt))
    .limit(limit);

  return c.json({
    deposits: rows.map((d) => ({
      id: d.id,
      tx_hash: d.txHash,
      log_index: d.logIndex,
      network: d.network,
      from_address: d.fromAddress,
      amount_raw: s(d.amountRaw),
      block_number: s(d.blockNumber),
      confirmed: d.confirmed,
      created_at: d.createdAt,
      payment_id: d.paymentPublicId,
      payment_status: d.paymentStatus,
      asset: d.asset,
      decimals: tokenFor(d.network as NetworkId, d.asset)?.decimals ?? 6,
    })),
  });
});
