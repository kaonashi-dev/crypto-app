/**
 * Creates one merchant and prints its credentials.
 *
 * The console can do this too now (Merchants → New merchant), and should be
 * preferred where possible: it records who created the account. This stays for
 * bootstrapping a fresh database before anyone can sign in, and for scripted setup.
 *
 * Both credentials are printed, because both are needed and neither can be
 * recovered afterwards: the API key is stored only as a SHA-256, and the webhook
 * secret is never returned by any read. Earlier versions of this script printed
 * only the key, which left a merchant provisioned this way unable to verify the
 * signature on its own webhooks.
 */
import { db, schema, sql } from "../src/db";
import { hashApiKey, newApiKey, newWebhookSecret } from "../src/services/merchants";

const apiKey = newApiKey();
const webhookSecret = newWebhookSecret();

const [client] = await db
  .insert(schema.clients)
  .values({
    name: "Cliente Demo",
    apiKeyHash: await hashApiKey(apiKey),
    webhookSecret,
    webhookUrl: null, // put a webhook.site URL here to watch the events
  })
  .returning();

console.log("Client created:", client!.id);
console.log("API KEY (save it, it is not shown again):       ", apiKey);
console.log("WEBHOOK SECRET (save it, it is not shown again):", webhookSecret);

await sql.end();
process.exit(0);
