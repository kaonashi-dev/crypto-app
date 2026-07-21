import { randomBytes } from "crypto";
import { db, schema, sql } from "../src/db";

const apiKey = "gk_test_" + randomBytes(24).toString("hex");
const hash = Buffer.from(
  await crypto.subtle.digest("SHA-256", new TextEncoder().encode(apiKey))
).toString("hex");

const [client] = await db
  .insert(schema.clients)
  .values({
    name: "Cliente Demo",
    apiKeyHash: hash,
    webhookSecret: "whsec_" + randomBytes(24).toString("hex"),
    webhookUrl: null, // put a webhook.site URL here to watch the events
  })
  .returning();

console.log("Client created:", client!.id);
console.log("API KEY (save it, it is not shown again):", apiKey);

await sql.end();
process.exit(0);
