import { Hono, type Context } from "hono";
import { serveStatic } from "hono/bun";
import { basicAuth } from "hono/basic-auth";
import { z } from "zod";
import { eq } from "drizzle-orm";
import QRCode from "qrcode";
import { db, schema } from "../db";
import { NETWORKS, ASSETS, NETWORK_IDS, env, tokenFor, type NetworkId } from "../config";
import { createPayment } from "../services/payments";
import { publicPaymentView } from "../services/webhooks";
import { apiKeyAuth } from "./auth";
import { adminApi } from "./admin";
import { scanTronPayment } from "../workers/tron-watcher";
import {
  getLogger,
  withContext,
  addContextAttributes,
  parseTraceparent,
  newTraceId,
  count,
  observe,
} from "../observability";

export const app = new Hono<{ Variables: { client: any } }>();

const httpLog = getLogger("http");

/**
 * Request logging, tracing and timing for every route.
 *
 * Registered before anything else because Hono runs middleware in registration
 * order: this has to wrap the auth guards and handlers to see their status codes
 * and to have opened the trace context they log inside.
 *
 * An inbound `traceparent` is adopted so a merchant's own tracing joins up with
 * ours; otherwise a fresh trace id is minted and returned in `x-trace-id`, which
 * is the handle to search the log tail with after a failed call.
 */
app.use("*", async (c, next) => {
  const inbound = parseTraceparent(c.req.header("traceparent"));
  const traceId = inbound?.traceId ?? newTraceId();

  await withContext({ traceId, attributes: { "http.route": c.req.path } }, async () => {
    const started = performance.now();
    const url = new URL(c.req.url);
    const request = {
      "http.request.method": c.req.method,
      "url.path": url.pathname,
      ...(url.search ? { "url.query": url.search.slice(1) } : {}),
      "client.address": c.req.header("x-forwarded-for")?.split(",")[0]?.trim(),
      "user_agent.original": c.req.header("user-agent"),
    };

    httpLog.debug("request received", request);
    c.header("x-trace-id", traceId);

    try {
      await next();
    } catch (e) {
      // Hono's own error handler still runs; this makes sure the throw itself is
      // attributed to the request that caused it.
      count("http.server.errors", { route: url.pathname });
      httpLog.error("request threw", {
        ...request,
        duration_ms: Math.round(performance.now() - started),
        err: e,
      });
      throw e;
    }

    const ms = performance.now() - started;
    const status = c.res.status;
    observe("http.server.duration", ms, { route: url.pathname, method: c.req.method });
    count("http.server.requests", { route: url.pathname, status });

    // A 5xx is ours, a 4xx is the caller's, and the polling endpoints would
    // drown the log at info — so the level follows the outcome.
    const level = status >= 500 ? "error" : status >= 400 ? "warn" : "debug";
    httpLog[level]("request completed", {
      ...request,
      "http.response.status_code": status,
      duration_ms: Math.round(ms * 100) / 100,
    });
  });
});

// Anything that escapes a handler: one record with the trace id the caller was
// handed, and a body that does not leak internals to the client.
app.onError((err, c) => {
  httpLog.error("unhandled error in handler", {
    "http.request.method": c.req.method,
    "url.path": new URL(c.req.url).pathname,
    err,
  });
  return c.json({ error: "internal_error", trace_id: c.res.headers.get("x-trace-id") }, 500);
});

app.notFound((c) => {
  httpLog.debug("route not found", {
    "http.request.method": c.req.method,
    "url.path": new URL(c.req.url).pathname,
  });
  return c.json({ error: "not_found" }, 404);
});

// Built Solid + Tailwind SPA (see ./web, built with `bun run build:web`). It
// serves both the checkout at /pay/:publicId and the console at /admin.
const WEB_DIST = "./web/dist";

/** Serves the SPA shell, or a 503 telling you to build it. */
async function spaShell(c: Context) {
  const html = await Bun.file(`${WEB_DIST}/index.html`).text().catch(() => null);
  if (html === null) {
    return c.text("Web UI not built. Run `bun run build:web`.", 503);
  }
  return c.html(html);
}

/**
 * Origin to build merchant-facing links from.
 *
 * A TLS-terminating proxy (Railway's edge, any load balancer) forwards plain
 * HTTP, so `c.req.url` reports scheme `http` and a `checkout_url` derived from it
 * would hand the merchant an insecure link to show a payer. The forwarded headers
 * carry the original scheme and host instead. They are client-settable in
 * principle, so a deployment on a fixed domain should pin `PUBLIC_BASE_URL`,
 * which wins outright.
 */
function publicOrigin(c: Context): string {
  if (env.publicBaseUrl) return env.publicBaseUrl;
  const url = new URL(c.req.url);
  // Each header is a comma-separated chain when several proxies are in front.
  const first = (h: string) => c.req.header(h)?.split(",")[0]?.trim();
  const proto = first("x-forwarded-proto") ?? url.protocol.replace(":", "");
  const host = first("x-forwarded-host") ?? url.host;
  return `${proto}://${host}`;
}

/**
 * Builds the QR payload + wallet deep link for a payment row.
 *
 * EVM uses EIP-681, which carries token, recipient and amount so the wallet
 * opens pre-filled. Tron has no equivalent standard that wallets agree on, so
 * its QR holds the bare Base58 address (what every Tron wallet scans) and there
 * is no deep link — `walletUri` is null and the UI tells the payer to send the
 * exact amount manually.
 */
async function buildCheckoutAssets(p: typeof schema.payments.$inferSelect) {
  const net = NETWORKS[p.network as NetworkId];
  const token = tokenFor(p.network as NetworkId, p.asset)!;

  const uri =
    net.family === "tron"
      ? p.address
      : `ethereum:${token.address}@${net.chain.id}/transfer?address=${p.address}&uint256=${p.amountCryptoRaw}`;

  const qrDataUrl = await QRCode.toDataURL(uri, { width: 280, margin: 1 });
  return {
    uri,
    walletUri: net.family === "tron" ? null : uri,
    qrDataUrl,
    decimals: token.decimals,
    family: net.family,
  };
}

const createSchema = z.object({
  amount_cop: z.coerce.bigint().positive(),
  // Derived from the network registry so supported combinations cannot drift
  // apart from config. createPayment rejects invalid asset/network pairings.
  asset: z.enum(ASSETS),
  network: z.enum(NETWORK_IDS),
  metadata: z.unknown().optional(),
});

// Liveness only, and deliberately thin: it is public, and the platform hits it
// constantly. Operational detail lives behind the console at
// /admin/api/diagnostics.
app.get("/health", (c) =>
  c.json({ ok: true, service: "crypto-gateway", uptime_s: Math.round(process.uptime()) })
);

// -- Merchant API (requires X-Api-Key) --------------------------------
app.post("/api/payments", apiKeyAuth, async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch (e) {
    httpLog.warn("payment request rejected — invalid JSON body", {
      "client.id": c.get("client").id,
      err: e,
    });
    return c.json({ error: "bad_request", details: "invalid JSON body" }, 400);
  }
  const body = createSchema.safeParse(raw);
  if (!body.success) {
    // The failing fields, not the body: a merchant integrating against this
    // needs to know which field was wrong, and we should not echo their payload.
    httpLog.warn("payment request rejected — validation failed", {
      "client.id": c.get("client").id,
      "validation.issues": body.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.code}`),
    });
    return c.json({ error: "bad_request", details: body.error.issues }, 400);
  }

  let p;
  try {
    p = await createPayment({
      clientId: c.get("client").id,
      amountCop: body.data.amount_cop,
      asset: body.data.asset,
      network: body.data.network as NetworkId,
      metadata: body.data.metadata,
    });
  } catch (e: any) {
    // createPayment already logged which rule refused it and why.
    httpLog.warn("payment not created", { "client.id": c.get("client").id, err: e });
    return c.json({ error: "cannot_create_payment", details: e.message }, 400);
  }

  const checkoutUrl = `${publicOrigin(c)}/pay/${p.publicId}`;
  httpLog.info("checkout issued", {
    "payment.id": p.publicId,
    "url.full": checkoutUrl,
    "http.origin_source": env.publicBaseUrl
      ? "PUBLIC_BASE_URL"
      : c.req.header("x-forwarded-host")
        ? "x-forwarded-host"
        : "request-host",
  });

  return c.json({ ...publicPaymentView(p), checkout_url: checkoutUrl }, 201);
});

app.get("/api/payments/:publicId", apiKeyAuth, async (c) => {
  const [p] = await db
    .select()
    .from(schema.payments)
    .where(eq(schema.payments.publicId, c.req.param("publicId")));
  if (!p || p.clientId !== c.get("client").id) return c.json({ error: "not_found" }, 404);
  return c.json(publicPaymentView(p));
});

app.get("/api/me", apiKeyAuth, (c) => {
  const cl = c.get("client");
  return c.json({ name: cl.name, balance_cop: cl.balanceCop.toString() });
});

// -- Public endpoints for the checkout UI -----------------------------
// Live status, polled by the SPA every 3s.
app.get("/public/payments/:publicId", async (c) => {
  const [p] = await db
    .select()
    .from(schema.payments)
    .where(eq(schema.payments.publicId, c.req.param("publicId")));
  if (!p) return c.json({ error: "not_found" }, 404);
  return c.json(publicPaymentView(p)); // no merchant data
});

// One-shot checkout payload: public payment view + EIP-681 URI + QR + decimals.
app.get("/public/payments/:publicId/checkout", async (c) => {
  const [p] = await db
    .select()
    .from(schema.payments)
    .where(eq(schema.payments.publicId, c.req.param("publicId")));
  if (!p) return c.json({ error: "not_found" }, 404);
  const { uri, walletUri, qrDataUrl, decimals, family } = await buildCheckoutAssets(p);
  addContextAttributes({ "payment.id": p.publicId });
  httpLog.info("checkout payload served", {
    "payment.id": p.publicId,
    "payment.status": p.status,
    "chain.network": p.network,
    "payment.asset": p.asset,
    "payment.address": p.address,
    "payment.amount_crypto_raw": p.amountCryptoRaw,
    "checkout.payment_uri": uri,
    "checkout.has_wallet_link": walletUri !== null,
    "checkout.qr_bytes": qrDataUrl.length,
  });
  return c.json({
    payment: publicPaymentView(p),
    payment_uri: uri,
    wallet_uri: walletUri, // null when the chain has no wallet deep-link standard
    qr_data_url: qrDataUrl,
    decimals,
    family,
    // The payment view carries deadlines, not durations. The checkout draws each
    // deadline as a depleting bar, which needs the span it is depleting.
    quote_ttl_sec: env.quoteTtlMin * 60,
    grace_ttl_sec: env.graceTtlMin * 60,
  });
});

// On-demand chain check: the payer says "I paid, look now" instead of the
// gateway polling the chain for everyone continuously.
//
// Public and unauthenticated, so it is cooldown-gated per payment — otherwise
// it would be a lever for burning provider quota, the exact opposite of why it
// exists. Callers always get the current status; `checked` says whether this
// request actually reached the chain.
const CHECK_COOLDOWN_MS = 10_000;
const ACTIVE_STATUSES = ["pending", "detecting", "partially_paid"];
const lastCheck = new Map<string, number>();

app.post("/public/payments/:publicId/check", async (c) => {
  const publicId = c.req.param("publicId");
  const [p] = await db
    .select()
    .from(schema.payments)
    .where(eq(schema.payments.publicId, publicId));
  if (!p) return c.json({ error: "not_found" }, 404);

  const now = Date.now();
  const since = now - (lastCheck.get(publicId) ?? 0);
  const net = NETWORKS[p.network as NetworkId];

  // Only Tron needs an on-demand read: the EVM watcher's WebSocket already
  // delivers transfers within seconds, so scanning there would spend calls for
  // nothing. Terminal payments never touch the chain again.
  const worthChecking =
    ACTIVE_STATUSES.includes(p.status) && net.family === "tron" && since >= CHECK_COOLDOWN_MS;

  addContextAttributes({ "payment.id": publicId });

  let checked = false;
  if (worthChecking) {
    lastCheck.set(publicId, now);
    // Drop cooldown entries that can no longer suppress anything.
    for (const [id, at] of lastCheck) {
      if (now - at > CHECK_COOLDOWN_MS) lastCheck.delete(id);
    }
    try {
      await scanTronPayment(p.network as NetworkId, {
        address: p.address,
        createdAt: p.createdAt,
      });
      checked = true;
    } catch (e) {
      // Fall through: the caller still gets the current stored status.
      count("checkout.check", { result: "scan_failed" });
      httpLog.warn("on-demand check failed — returning the stored status", {
        "payment.id": publicId,
        "chain.network": p.network,
        err: e,
      });
    }
  } else {
    // Why the payer's "I paid" button did nothing is the single most confusing
    // thing to debug from the outside, so the reason is always stated.
    const reason = !ACTIVE_STATUSES.includes(p.status)
      ? "terminal_status"
      : net.family !== "tron"
        ? "evm_watched_live"
        : "cooldown";
    count("checkout.check", { result: `skipped_${reason}` });
    httpLog.debug("on-demand check skipped", {
      "payment.id": publicId,
      "payment.status": p.status,
      "chain.network": p.network,
      "checkout.skip_reason": reason,
      "checkout.cooldown_remaining_ms": Math.max(0, CHECK_COOLDOWN_MS - since),
    });
  }

  const [fresh] = await db
    .select()
    .from(schema.payments)
    .where(eq(schema.payments.publicId, publicId));

  if (checked) {
    count("checkout.check", { result: "scanned" });
    httpLog.info("on-demand check complete", {
      "payment.id": publicId,
      "payment.status_before": p.status,
      "payment.status": (fresh ?? p).status,
      "payment.changed": (fresh ?? p).status !== p.status,
    });
  }

  return c.json({
    payment: publicPaymentView(fresh ?? p),
    checked,
    cooldown_ms: worthChecking ? CHECK_COOLDOWN_MS : Math.max(0, CHECK_COOLDOWN_MS - since),
  });
});

// -- Internal backoffice console ---------------------------------------
// The console is read-only but cross-merchant, and exposes operational internals
// the merchant API hides. ADMIN_PASSWORD gates the whole surface — console shell
// and data routes alike — and the boot preflight makes it mandatory in
// production, so a deployed instance is never open. Left unset in local
// development the console stays open, as it always was.
//
// Registered before the routes below, because Hono runs middleware in
// registration order and would skip anything added after a matching handler. The
// browser prompts once on /admin and then carries the credentials to /admin/api
// on its own, so the SPA's queries need no change.
if (env.adminPassword) {
  const guard = basicAuth({
    username: env.adminUser,
    password: env.adminPassword,
    realm: "gateway console",
  });
  app.use("/admin", guard);
  app.use("/admin/*", guard);
}

// Registered before the /admin/* shell route so the data routes win the match.
app.route("/admin/api", adminApi);

// -- SPA (React + Tailwind, served from ./web/dist) ---------------------
app.use("/assets/*", serveStatic({ root: WEB_DIST }));

app.get("/pay/:publicId", spaShell);
// The console is client-routed (/admin, /admin/deposits, /admin/p/:id), so every
// path under /admin returns the same shell and the router reads the pathname.
app.get("/admin", spaShell);
app.get("/admin/*", spaShell);
