import { expireStalePayments } from "../services/payments";
import { deliverPendingWebhooks } from "../services/webhooks";

export function startExpirer() {
  setInterval(() => expireStalePayments().catch(console.error), 20_000);
  setInterval(() => deliverPendingWebhooks().catch(console.error), 5_000);
}
