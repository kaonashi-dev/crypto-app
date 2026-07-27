import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { env } from "../config";
import { getLogger, count } from "../observability";

const log = getLogger("db");

const POOL_MAX = 10;

const sql = postgres(env.databaseUrl, {
  max: POOL_MAX,
  onnotice: (notice) => {
    log.debug("postgres notice", {
      "db.system": "postgresql",
      "db.notice.severity": notice.severity,
      "db.notice.message": notice.message,
    });
  },
  connection: {
    // Identifies this process in pg_stat_activity — which is how you find out
    // who is holding the lock when a settlement transaction stalls.
    application_name: "crypto-gateway",
  },
});

/** Squashes a statement onto one line so a record stays one line. */
function collapse(query: string): string {
  const flat = query.replace(/\s+/g, " ").trim();
  return flat.length > 500 ? `${flat.slice(0, 500)}…` : flat;
}

export const db = drizzle(sql, {
  schema,
  /**
   * Statement tracing, off unless you ask for it: `LOG_LEVEL=info,db=trace`.
   *
   * Only the statement text, never the parameters — those carry addresses,
   * amounts and merchant metadata, and the payment path already logs those with
   * names attached. Note this fires when a statement is *dispatched*: drizzle
   * has no completion hook, so durations come from the operation-level timers in
   * the services and workers, not from here.
   */
  logger: {
    logQuery(query, params) {
      count("db.queries");
      if (!log.enabled("trace")) return;
      log.trace("query", {
        "db.system": "postgresql",
        "db.query.text": collapse(query),
        "db.query.parameter_count": params.length,
      });
    },
  },
});

function safeDbTarget(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return "unparseable";
  }
}

log.info("database pool created", {
  "db.system": "postgresql",
  "db.pool.max": POOL_MAX,
  // Host and database only — the URL carries the password.
  "server.address": safeDbTarget(env.databaseUrl),
});

export { schema, sql };
