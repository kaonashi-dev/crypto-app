import type { MiddlewareHandler } from "hono";
import { eq } from "drizzle-orm";
import { db, schema } from "../db";

export const apiKeyAuth: MiddlewareHandler = async (c, next) => {
  const key = c.req.header("X-Api-Key");
  if (!key) return c.json({ error: "missing_api_key" }, 401);

  const hash = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key))
  ).toString("hex");

  const [client] = await db
    .select()
    .from(schema.clients)
    .where(eq(schema.clients.apiKeyHash, hash));
  if (!client || !client.isActive) return c.json({ error: "invalid_api_key" }, 401);

  c.set("client", client);
  await next();
};
