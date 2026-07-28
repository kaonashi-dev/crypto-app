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
 * Every route in *this* file is a SELECT. Nothing here mutates the payment state
 * machine, so the console can never corrupt a payment no matter what it is asked
 * to render.
 *
 * That is a property of this file, not of the console as a whole: the write
 * surface — merchant CRUD and operator-issued payments — lives in
 * ./admin-write.ts, mounted at the same prefix and behind its own additional
 * guard. Keeping the split is what lets the sentence above stay checkable, so a
 * mutation belongs there even when the read it pairs with is here.
 */
import { Hono } from "hono";
import { and, count, desc, eq, ilike, inArray, or, sql, sum } from "drizzle-orm";
import { db, schema } from "../db";
import {
  NETWORKS,
  NETWORK_IDS,
  env,
  assetFor,
  gasCoinFor,
  configSummary,
  missingCredential,
  sweepablePairings,
  type NetworkId,
} from "../config";
import { requiredWithTolerance } from "../services/payments";
import { unsweptTotals } from "../workers/sweeper";
import { walletOverview } from "../services/treasury";
import { rateCacheState } from "../services/rates";
import { activeSessionCounts } from "../services/admin-auth";
import { AUDIT_ACTIONS, auditTrail } from "../services/audit";
import { apiKeyHashPrefix } from "../services/merchants";
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
    testnet: net.testnet,
    tokens: Object.keys(net.tokens),
    native: net.native?.symbol ?? null,
    // A network can hold historical payments and still not be offered any more
    // (a mainnet with ENABLE_MAINNETS unset), so the console distinguishes
    // "gone" from "never existed".
    offered: (NETWORK_IDS as readonly string[]).includes(id),
  };
}

/**
 * One audit row on the wire.
 *
 * `detail` was serialized and secret-scrubbed on the way in (services/audit.ts)
 * and is parsed back here so the console renders a diff rather than a string. A
 * row written before a schema change may not parse; that is shown as null rather
 * than failing the whole response.
 */
function auditView(e: Awaited<ReturnType<typeof auditTrail>>["entries"][number]) {
  let detail: unknown = null;
  if (e.detail) {
    try {
      detail = JSON.parse(e.detail);
    } catch {
      detail = null;
    }
  }
  return {
    id: e.id,
    operator_id: e.operatorId,
    operator_username: e.operatorUsername,
    action: e.action,
    target_type: e.targetType,
    target_id: e.targetId,
    outcome: e.outcome,
    detail,
    ip_address: e.ipAddress,
    user_agent: e.userAgent,
    // The handle that expands this row into its full request in /admin/api/logs.
    trace_id: e.traceId,
    created_at: e.createdAt,
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
  const [byStatus, byNetwork, deposits, queue, clients, sweepCounts, unswept] = await Promise.all([
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

    db
      .select({ status: schema.sweeps.status, n: count() })
      .from(schema.sweeps)
      .groupBy(schema.sweeps.status),

    unsweptTotals(),
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
    sweeps: {
      by_status: Object.fromEntries(
        schema.sweepStatus.enumValues.map((st) => [
          st,
          Number(sweepCounts.find((r) => r.status === st)?.n ?? 0),
        ])
      ),
      // Confirmed in minus confirmed out, per (network, asset). The headline
      // number for "how much is still sitting at deposit addresses".
      unswept,
    },
    // Surfacing the live parameters makes a frozen quote or a dust-tolerance
    // settle reproducible without reading .env on the server.
    config: {
      quote_ttl_min: env.quoteTtlMin,
      grace_ttl_min: env.graceTtlMin,
      spread_bps: Number(env.spreadBps),
      dust_bps: Number(env.dustBps),
      sweep_enabled: env.sweepEnabled,
      sweep_dry_run: env.sweepDryRun,
      sweep_min_usd: env.sweepMinUsd,
      sweep_max_cost_bps: Number(env.sweepMaxCostBps),
      // Which pairings this build can consolidate at all — the answer to "why
      // has nothing swept", which is almost always a registry gap rather than a
      // switch.
      sweep_pairings: sweepablePairings(),
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

// -- GET /admin/api/clients/:id ----------------------------------------
// One merchant, with the numbers the Merchants view needs to decide what may be
// done to it: the reference counts a hard delete would violate, and the payment
// mix that says whether it has ever been used.
//
// `api_key_hash_prefix` is the same handle src/api/auth.ts logs when it rejects a
// key, which is what lets an operator match a 401 in the log tail to an account.
// The hash itself and the webhook secret are not selected — not masked in the
// response, not selected — so no later edit to this handler can start returning
// them.
adminApi.get("/clients/:id", async (c) => {
  const id = c.req.param("id");
  // An invalid uuid would make Postgres error rather than return nothing.
  if (!UUID_RE.test(id)) return c.json({ error: "not_found" }, 404);

  const [row] = await db.select().from(schema.clients).where(eq(schema.clients.id, id));
  if (!row) return c.json({ error: "not_found" }, 404);

  const [byStatus, ledger, webhooks, audit] = await Promise.all([
    db
      .select({ status: schema.payments.status, n: count() })
      .from(schema.payments)
      .where(eq(schema.payments.clientId, id))
      .groupBy(schema.payments.status),
    db
      .select({ n: count(), total: sum(schema.ledgerEntries.amountCop) })
      .from(schema.ledgerEntries)
      .where(eq(schema.ledgerEntries.clientId, id)),
    db
      .select({
        total: count(),
        pending: sql<number>`(count(*) filter (where ${schema.webhookJobs.deliveredAt} is null and ${schema.webhookJobs.attempts} < 8))::int`,
        dead: sql<number>`(count(*) filter (where ${schema.webhookJobs.deliveredAt} is null and ${schema.webhookJobs.attempts} >= 8))::int`,
      })
      .from(schema.webhookJobs)
      .where(eq(schema.webhookJobs.clientId, id)),
    auditTrail({ targetType: "client", targetId: id, limit: 20 }),
  ]);

  const payments = byStatus.reduce((acc, r) => acc + Number(r.n), 0);

  return c.json({
    client: {
      id: row.id,
      name: row.name,
      balance_cop: s(row.balanceCop),
      webhook_url: row.webhookUrl,
      is_active: row.isActive,
      created_at: row.createdAt,
      api_key_hash_prefix: apiKeyHashPrefix(row.apiKeyHash),
    },
    payments: {
      total: payments,
      by_status: Object.fromEntries(
        STATUSES.map((st) => [st, Number(byStatus.find((r) => r.status === st)?.n ?? 0)])
      ),
    },
    ledger: { entries: Number(ledger[0]?.n ?? 0), credited_cop: ledger[0]?.total ?? "0" },
    webhooks: {
      total: Number(webhooks[0]?.total ?? 0),
      pending: webhooks[0]?.pending ?? 0,
      dead: webhooks[0]?.dead ?? 0,
    },
    // What a hard delete would have to violate. Advisory: the foreign key is what
    // actually refuses it (see the DELETE handler in ./admin-write.ts), because
    // these counts race a watcher inserting a deposit.
    references: {
      payments,
      ledger_entries: Number(ledger[0]?.n ?? 0),
      webhook_jobs: Number(webhooks[0]?.total ?? 0),
    },
    deletable: payments === 0 && Number(ledger[0]?.n ?? 0) === 0 && Number(webhooks[0]?.total ?? 0) === 0,
    audit: audit.entries.map(auditView),
  });
});

// -- GET /admin/api/audit ----------------------------------------------
// The console's own trail: every mutation an operator has made through /admin.
//
// A read of a read-only view still leaves no trace — that gap is unchanged. What
// this covers is every *change*, which is the half that was blocking the console
// from having any write surface at all (see services/audit.ts).
adminApi.get("/audit", async (c) => {
  const q = c.req.query();
  const limit = Math.min(Number(q.limit) || 50, PAGE_MAX);
  const offset = Math.max(Number(q.offset) || 0, 0);

  const { total, entries } = await auditTrail({
    action: q.action?.trim() || undefined,
    targetType: q.target_type?.trim() || undefined,
    targetId: q.target_id?.trim() || undefined,
    operatorId: q.operator_id && UUID_RE.test(q.operator_id) ? q.operator_id : undefined,
    limit,
    offset,
  });

  return c.json({ total, limit, offset, actions: AUDIT_ACTIONS, entries: entries.map(auditView) });
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
      decimals: assetFor(p.network as NetworkId, p.asset)?.decimals ?? 6,
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

  const token = assetFor(p.network as NetworkId, p.asset);

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
    // `address` is null for the chain's own coin: there is no contract to link
    // to on the explorer, which is exactly what the console needs to know.
    token: token
      ? {
          address: token.kind === "token" ? token.address : null,
          decimals: token.decimals,
          symbol: p.asset,
          kind: token.kind,
        }
      : null,
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
      asset: d.asset,
      // False for a deposit in an asset this payment did not quote: recorded,
      // never credited, and needing a human.
      settles: d.asset === p.asset,
      decimals: assetFor(d.network as NetworkId, d.asset)?.decimals ?? token?.decimals ?? 6,
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
    networks: Object.keys(NETWORKS).map((id) => {
      const meta = networkMeta(id)!;
      return {
        ...meta,
        // Watchers run only for a network that is both offered and holds its
        // credential; a withheld mainnet with a key set is still not running.
        enabled: meta.offered && !missingCredential(id as NetworkId),
        missing_credential: missingCredential(id as NetworkId),
      };
    }),
    logging: { ...loggingConfig(), otlp: otlpStatus() },
    rates: rateCacheState(),
    metrics: snapshot(),
  })
);

// -- GET /admin/api/wallets --------------------------------------------
// What the gateway's own wallets hold, read from the chain.
//
// The only console route that reads a chain rather than the database, and the
// only one whose cost is metered — so it is a route of its own rather than part
// of /stats, which every view polls. Readings are cached server-side for 30s
// (see services/treasury.ts) and the response reports its own age.
//
// Balance reads are legitimate here for the same narrow reason they are in
// reconciliation: this is auditing, never settlement. Nothing on this path
// touches a payment.
adminApi.get("/wallets", async (c) => {
  const overview = await walletOverview();
  return c.json({
    age_s: overview.age_s,
    // Mapped rather than spread, so the wire stays snake_case like every other
    // response here and the service keeps its own naming.
    networks: overview.networks.map((n) => ({
      network: n.network,
      family: n.family,
      testnet: n.testnet,
      reachable: n.reachable,
      error: n.error,
      wallets: n.wallets.map((w) => ({
        role: w.role,
        address: w.address,
        note: w.note,
        balances: w.balances.map((b) => ({
          asset: b.asset,
          raw: b.raw,
          decimals: b.decimals,
          kind: b.kind,
          is_fee_currency: b.isFeeCurrency,
        })),
      })),
    })),
    cache_ttl_s: 30,
    // Repeated from /stats so this view is self-contained: the switches explain
    // why a correctly-funded relayer still is not sweeping anything.
    sweep: {
      enabled: env.sweepEnabled,
      dry_run: env.sweepDryRun,
      signer: env.sweepSigner,
      pairings: sweepablePairings(),
    },
  });
});

// -- GET /admin/api/sweeps ---------------------------------------------
// Consolidation of deposit addresses into the treasury, newest first.
//
// Read-only like everything else here, and deliberately so: `AGENTS.md` holds
// /admin to no mutation without an audit model to go with it, and a console
// button that moves money is the last place to make an exception. A "sweep now"
// action is deferred until that model exists — see §2.2 and §13.1 of
// docs/SWEEPING-PLAN.md.
//
// The `reason` column is the point of the view. Most rows are deferrals rather
// than failures — below the floor, gas too expensive, no mechanism yet — and
// that is normal operation, not a queue backing up.
adminApi.get("/sweeps", async (c) => {
  const q = c.req.query();
  const limit = Math.min(Number(q.limit) || 100, PAGE_MAX);

  const conds = [];
  if (q.network && NETWORKS[q.network as NetworkId]) {
    conds.push(eq(schema.sweeps.network, q.network));
  }
  if (q.status && (schema.sweepStatus.enumValues as readonly string[]).includes(q.status)) {
    conds.push(eq(schema.sweeps.status, q.status as (typeof schema.sweepStatus.enumValues)[number]));
  }
  if (q.asset) conds.push(eq(schema.sweeps.asset, q.asset));
  const term = q.q?.trim();
  if (term) {
    const pat = `%${term}%`;
    conds.push(
      or(
        ilike(schema.sweeps.address, pat),
        ilike(schema.sweeps.txHash, pat),
        ilike(schema.sweeps.toAddress, pat)
      )
    );
  }
  const where = conds.length ? and(...conds) : undefined;

  const [rows, total] = await Promise.all([
    db
      .select()
      .from(schema.sweeps)
      .where(where)
      .orderBy(desc(schema.sweeps.createdAt))
      .limit(limit),
    db.select({ n: count() }).from(schema.sweeps).where(where),
  ]);

  return c.json({
    total: Number(total[0]?.n ?? 0),
    limit,
    statuses: schema.sweepStatus.enumValues,
    sweeps: rows.map((r) => ({
      id: r.id,
      network: r.network,
      address: r.address,
      derivation_index: r.derivationIndex,
      asset: r.asset,
      amount_raw: s(r.amountRaw),
      decimals: assetFor(r.network as NetworkId, r.asset)?.decimals ?? 6,
      to_address: r.toAddress,
      via: r.via,
      status: r.status,
      reason: r.reason,
      tx_hash: r.txHash,
      block_number: s(r.blockNumber),
      // In the network's fee currency, which is not always an asset the gateway
      // quotes — Sepolia charges ETH and accepts only stablecoins.
      fee_raw: s(r.feeRaw),
      fee_asset: gasCoinFor(r.network as NetworkId).symbol,
      fee_decimals: gasCoinFor(r.network as NetworkId).decimals,
      attempts: r.attempts,
      next_attempt_at: r.nextAttemptAt,
      last_error: r.lastError,
      // The authorization nonce is shown: it is a replay key the chain has
      // already recorded, not a secret, and it is what makes an on-chain sweep
      // traceable back to this row.
      authorization_nonce: r.authorizationNonce,
      valid_before: r.validBefore,
      created_at: r.createdAt,
      updated_at: r.updatedAt,
    })),
  });
});

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
      // The deposit's own asset, not the payment's — with several assets per
      // network they can differ, and when they do that is the single most
      // important thing on the row (see the mismatch guard in
      // services/payments.ts). The payment's is carried alongside so the
      // console can show the contrast rather than just a symbol.
      asset: schema.deposits.asset,
      paymentAsset: schema.payments.asset,
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
      payment_asset: d.paymentAsset,
      settles: d.asset === d.paymentAsset,
      decimals: assetFor(d.network as NetworkId, d.asset)?.decimals ?? 6,
    })),
  });
});
