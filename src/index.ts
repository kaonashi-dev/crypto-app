import { app } from "./api/routes";
import { superviseNetwork } from "./workers/supervisor";
import { startExpirer } from "./workers/expirer";
import { env, preflight, missingCredential, NETWORK_IDS } from "./config";
import { assertSeedIdentity, SeedMismatchError } from "./services/wallet";
import { bootstrapOperator } from "./services/admin-auth";
import { sql } from "./db";
import {
  getLogger,
  loggingConfig,
  resource,
  startHeartbeat,
  startOtlpExport,
  withContext,
} from "./observability";

const log = getLogger("gateway");

// A dropped WebSocket surfaces as an unhandled ErrorEvent from the transport,
// which would otherwise dump raw and take the workers down with it. The polling
// backfill covers the gap, so log it compactly and keep serving.
//
// Throttled per condition (`repeat`) rather than printed every time: a provider
// that is flapping produces one of these per reconnect attempt.
process.on("unhandledRejection", (e) => {
  log.repeat("unhandled-rejection", "error", "unhandled promise rejection", { err: e });
});
process.on("uncaughtException", (e) => {
  log.repeat("uncaught-exception", "error", "uncaught exception", { err: e });
});

// Fails fast on a missing secret instead of surfacing it later as a connection
// error inside a request or a worker tick.
preflight();

// Optional OTLP/HTTP export of these same records; a no-op unless
// OTEL_EXPORTER_OTLP_ENDPOINT is set. See src/observability/otlp.ts.
const otlpEndpoint = startOtlpExport();

log.info("starting", {
  ...resource,
  "server.port": env.port,
  "log.level": loggingConfig().level,
  "log.format": loggingConfig().format,
  "log.otlp_endpoint": otlpEndpoint,
});

// The derivation counter is bound to one mnemonic; boot is where that should be
// discovered, not the next checkout. It needs the database, which is why it is
// not part of preflight() — and why a database that is merely unreachable only
// warns: reserveDerivationIndex re-checks the same invariant on every issue, so
// nothing can slip through while this is deferred.
try {
  const seed = await assertSeedIdentity();
  log.info("hd wallet ready", {
    "wallet.seed_fingerprint": seed.fingerprint,
    "wallet.issued_indexes": seed.issued,
  });
} catch (e) {
  if (e instanceof SeedMismatchError) {
    log.fatal("HD_MNEMONIC does not match this database — refusing to start", {
      "wallet.seed_fingerprint": e.configured,
      "wallet.seed_fingerprint_stored": e.stored,
      "wallet.issued_indexes": e.issued,
      err: e,
    });
    process.exit(1);
  }
  log.error("seed identity check deferred — database unavailable at boot", { err: e });
}

// The console's bootstrap operator, kept in step with ADMIN_PASSWORD on every
// boot (see services/admin-auth.ts). Deferred like the seed check because it
// needs the database: a database that is merely unreachable must not stop the
// gateway from serving payments, and the login path re-reads the row anyway, so
// nothing can slip through while this is postponed.
try {
  const operator = await bootstrapOperator();
  if (operator) {
    log.info("console operator ready", {
      "operator.id": operator.id,
      "operator.username": operator.username,
    });
  }
} catch (e) {
  log.error("console operator bootstrap deferred — database unavailable at boot", { err: e });
}

for (const network of NETWORK_IDS) {
  // A network whose RPC key is absent can only fail its probe forever. The
  // preflight has already said which one and why, so skip it quietly here.
  if (missingCredential(network)) continue;
  superviseNetwork(network);
}
startExpirer();
startHeartbeat();

// The platform stops a container by signalling it. Close the pool so in-flight
// settlement transactions land instead of being cut mid-statement; anything that
// does not finish in time rolls back and is picked up again on the next boot by
// the same idempotency that guards a redelivered deposit.
let closing = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (closing) {
      log.warn("second signal — exiting immediately", { "process.signal": signal });
      process.exit(1);
    }
    closing = true;
    withContext({ attributes: { "process.signal": signal } }, () => {
      const done = log.time("database pool drained");
      log.info("draining", { "process.uptime_s": Math.round(process.uptime()) });
      sql
        .end({ timeout: 5 })
        .catch((e) => log.error("pool drain failed", { err: e }))
        .finally(() => {
          done({}, "info");
          process.exit(0);
        });
    });
  });
}

log.info("API + workers up", { "server.port": env.port });

// `hostname` is explicit because the default loopback bind of some runtimes is
// unreachable from a container's health check; Bun already defaults to 0.0.0.0.
export default { port: env.port, hostname: "0.0.0.0", fetch: app.fetch };
// bun run src/index.ts -> API + workers up
