import { expireStalePayments } from "../services/payments";
import { deliverPendingWebhooks } from "../services/webhooks";
import { getLogger, withContext } from "../observability";

const EXPIRY_INTERVAL_MS = 20_000;
const WEBHOOK_INTERVAL_MS = 5_000;

/**
 * The two DB-only loops: window expiry and webhook delivery.
 *
 * Both run unconditionally (no chain access, no provider cost), so each tick is
 * wrapped in its own trace and reports at trace level when it found nothing —
 * that is the line that proves the loop is alive when a payment fails to expire.
 */
export function startExpirer() {
  const log = getLogger("expirer");

  const run = (name: string, fn: () => Promise<void>) => () =>
    void withContext({ attributes: { "worker.name": name } }, async () => {
      try {
        await fn();
      } catch (e) {
        log.repeat(name, "error", `${name} tick failed`, { err: e });
      }
    });

  log.info("expiry + webhook loops started", {
    "worker.expiry_interval_s": EXPIRY_INTERVAL_MS / 1000,
    "worker.webhook_interval_s": WEBHOOK_INTERVAL_MS / 1000,
  });

  setInterval(run("expirer", expireStalePayments), EXPIRY_INTERVAL_MS);
  setInterval(run("webhooks", deliverPendingWebhooks), WEBHOOK_INTERVAL_MS);
}
