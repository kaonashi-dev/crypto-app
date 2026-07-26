/**
 * Applies the versioned migrations in ./drizzle, for deployed environments.
 *
 * `bun run db:migrate` (drizzle-kit) is the development path, but drizzle-kit is
 * a devDependency and the production image installs dependencies only. This uses
 * drizzle-orm's own migrator, which reads the same `drizzle/` folder and the same
 * `__drizzle_migrations` bookkeeping table, so the two are interchangeable.
 *
 * Idempotent: already-applied migrations are skipped, which is what makes it safe
 * as part of the container's start command on every restart. It runs on a
 * dedicated single connection that is closed before the API process starts.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("[migrate] DATABASE_URL is not set.");
  process.exit(1);
}

// `max: 1` because migrations must run in order on one connection.
const sql = postgres(url, { max: 1, onnotice: () => {} });

try {
  await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
  console.log("[migrate] schema up to date");
} catch (e) {
  console.error("[migrate] failed:", e instanceof Error ? e.message : e);
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
}

await sql.end({ timeout: 5 });
