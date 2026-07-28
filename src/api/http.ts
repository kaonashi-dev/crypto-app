/**
 * The pieces of the payment-creation contract that more than one route needs.
 *
 * Two callers now create payments: `POST /api/payments`, which a merchant reaches
 * with an API key, and `POST /admin/api/payments`, which an operator reaches with
 * a console session. They must accept exactly the same body and hand back exactly
 * the same checkout URL — otherwise the console stops being a way to reproduce
 * what a merchant sees, which is the only reason it can create payments at all.
 *
 * That is why this is a module of its own rather than an export from ./routes.ts:
 * the admin router is mounted *by* routes.ts, so importing back out of it would
 * be a cycle.
 */
import type { Context } from "hono";
import { z } from "zod";
import { ASSETS, NETWORK_IDS, env } from "../config";

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
export function publicOrigin(c: Context): string {
  if (env.publicBaseUrl) return env.publicBaseUrl;
  const url = new URL(c.req.url);
  // Each header is a comma-separated chain when several proxies are in front.
  const first = (h: string) => c.req.header(h)?.split(",")[0]?.trim();
  const proto = first("x-forwarded-proto") ?? url.protocol.replace(":", "");
  const host = first("x-forwarded-host") ?? url.host;
  return `${proto}://${host}`;
}

/** Which of the two origin sources answered, for the log. */
export function originSource(c: Context): string {
  if (env.publicBaseUrl) return "PUBLIC_BASE_URL";
  return c.req.header("x-forwarded-host") ? "x-forwarded-host" : "request-host";
}

/**
 * The body of a payment request.
 *
 * `asset` and `network` are derived from the registry in src/config.ts so the
 * accepted values cannot drift apart from what the gateway actually serves;
 * `createPayment` then rejects a *pairing* that does not exist, which the enums
 * alone cannot express.
 */
export const createPaymentSchema = z.object({
  amount_cop: z.coerce.bigint().positive(),
  asset: z.enum(ASSETS),
  network: z.enum(NETWORK_IDS),
  metadata: z.unknown().optional(),
});
