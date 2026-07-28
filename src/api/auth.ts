import type { MiddlewareHandler } from "hono";
import { eq } from "drizzle-orm";
import { db, schema } from "../db";
import { apiKeyHashPrefix, hashApiKey } from "../services/merchants";
import { getLogger, addContextAttributes, count } from "../observability";

const log = getLogger("auth");

/**
 * Merchant authentication by `X-Api-Key`.
 *
 * Rejections are logged with the *reason* separated — missing, unknown,
 * deactivated — because "401" alone sends an integrator looking in the wrong
 * place. The key itself never reaches the log: a failed attempt is identified by
 * the hash prefix, which is enough to match it against `clients.api_key_hash`
 * without the log becoming a credential store.
 */
export const apiKeyAuth: MiddlewareHandler = async (c, next) => {
  const key = c.req.header("X-Api-Key");
  if (!key) {
    count("auth.rejected", { reason: "missing" });
    log.warn("api key missing", { "http.route": c.req.path });
    return c.json({ error: "missing_api_key" }, 401);
  }

  const hash = await hashApiKey(key);

  const [client] = await db
    .select()
    .from(schema.clients)
    .where(eq(schema.clients.apiKeyHash, hash));

  if (!client) {
    count("auth.rejected", { reason: "unknown" });
    log.warn("api key not recognised", {
      "http.route": c.req.path,
      "client.api_key_hash_prefix": apiKeyHashPrefix(hash),
    });
    return c.json({ error: "invalid_api_key" }, 401);
  }
  if (!client.isActive) {
    count("auth.rejected", { reason: "inactive" });
    log.warn("api key belongs to a deactivated merchant", {
      "http.route": c.req.path,
      "client.id": client.id,
      "client.name": client.name,
    });
    return c.json({ error: "invalid_api_key" }, 401);
  }

  count("auth.accepted");
  // Every record for the rest of this request names the merchant.
  addContextAttributes({ "client.id": client.id, "client.name": client.name });
  log.debug("api key accepted", { "client.id": client.id, "client.name": client.name });

  c.set("client", client);
  await next();
};
