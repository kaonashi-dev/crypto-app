import { Hono } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import QRCode from "qrcode";
import { db, schema } from "../db";
import { NETWORKS, type NetworkId } from "../config";
import { createPayment } from "../services/payments";
import { publicPaymentView } from "../services/webhooks";
import { apiKeyAuth } from "./auth";
import { renderPayPage } from "../ui/pay";

export const app = new Hono<{ Variables: { client: any } }>();

const createSchema = z.object({
  amount_cop: z.coerce.bigint().positive(),
  asset: z.enum(["USDC"]),
  network: z.enum(["eth-sepolia", "base-sepolia"]),
  metadata: z.unknown().optional(),
});

app.get("/health", (c) => c.json({ ok: true }));

// -- Merchant API (requires X-Api-Key) --------------------------------
app.post("/api/payments", apiKeyAuth, async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "bad_request", details: "invalid JSON body" }, 400);
  }
  const body = createSchema.safeParse(raw);
  if (!body.success) {
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
    return c.json({ error: "cannot_create_payment", details: e.message }, 400);
  }

  return c.json(
    {
      ...publicPaymentView(p),
      checkout_url: `${new URL(c.req.url).origin}/pay/${p.publicId}`,
    },
    201
  );
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
app.get("/public/payments/:publicId", async (c) => {
  const [p] = await db
    .select()
    .from(schema.payments)
    .where(eq(schema.payments.publicId, c.req.param("publicId")));
  if (!p) return c.json({ error: "not_found" }, 404);
  return c.json(publicPaymentView(p)); // no merchant data
});

app.get("/pay/:publicId", async (c) => {
  const [p] = await db
    .select()
    .from(schema.payments)
    .where(eq(schema.payments.publicId, c.req.param("publicId")));
  if (!p) return c.text("Payment not found", 404);

  // EIP-681 URI: opens the wallet with token, recipient and amount pre-filled.
  const net = NETWORKS[p.network as NetworkId];
  const token = net.tokens[p.asset as keyof typeof net.tokens];
  const uri = `ethereum:${token.address}@${net.chain.id}/transfer?address=${p.address}&uint256=${p.amountCryptoRaw}`;
  const qrDataUrl = await QRCode.toDataURL(uri, { width: 280, margin: 1 });

  return c.html(renderPayPage(publicPaymentView(p), qrDataUrl, uri, token.decimals));
});
