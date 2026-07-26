import { app } from "./api/routes";
import { superviseNetwork } from "./workers/supervisor";
import { startExpirer } from "./workers/expirer";
import { env, preflight, missingCredential, NETWORK_IDS } from "./config";
import { logRpcError } from "./workers/rpc-log";
import { sql } from "./db";

// A dropped WebSocket surfaces as an unhandled ErrorEvent from the transport,
// which would otherwise dump raw and take the workers down with it. The polling
// backfill covers the gap, so log it compactly and keep serving.
process.on("unhandledRejection", (e) => logRpcError("gateway:unhandled", e));
process.on("uncaughtException", (e) => logRpcError("gateway:uncaught", e));

// Fails fast on a missing secret instead of surfacing it later as a connection
// error inside a request or a worker tick.
preflight();

for (const network of NETWORK_IDS) {
  // A network whose RPC key is absent can only fail its probe forever. The
  // preflight has already said which one and why, so skip it quietly here.
  if (missingCredential(network)) continue;
  superviseNetwork(network);
}
startExpirer();

// The platform stops a container by signalling it. Close the pool so in-flight
// settlement transactions land instead of being cut mid-statement; anything that
// does not finish in time rolls back and is picked up again on the next boot by
// the same idempotency that guards a redelivered deposit.
let closing = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (closing) process.exit(1); // second signal: stop waiting
    closing = true;
    console.log(`[gateway] ${signal} — draining`);
    sql
      .end({ timeout: 5 })
      .catch(() => {})
      .finally(() => process.exit(0));
  });
}

console.log(`[gateway] API + workers up on port ${env.port}`);

// `hostname` is explicit because the default loopback bind of some runtimes is
// unreachable from a container's health check; Bun already defaults to 0.0.0.0.
export default { port: env.port, hostname: "0.0.0.0", fetch: app.fetch };
// bun run src/index.ts -> API + workers up
