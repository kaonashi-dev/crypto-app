# Database

PostgreSQL via Drizzle ORM. Schema changes always start in
[`src/db/schema.ts`](../../src/db/schema.ts); the versioned SQL under `drizzle/`
is generated from it, never hand-written.

## The three commands, and why there are three

| Command | Runs | Tool | Where it runs | Devs? |
|---|---|---|---|---|
| `bun run db:generate` | `drizzle-kit generate` | drizzle-kit | Locally, after editing `schema.ts` | Yes |
| `bun run db:migrate` | `drizzle-kit migrate` | drizzle-kit | Locally, against `bun run db:up` | Yes |
| `bun run db:deploy` | `scripts/migrate.ts` | drizzle-orm's own migrator | Production container, on every boot | No — see below |

**`db:generate`** diffs `schema.ts` against the migration history and writes a new
`NNNN_name.sql` file under `drizzle/` plus its `meta/` snapshot. It does not touch
the database. Commit the generated file — it is the artifact, not a build output.

**`db:migrate`** applies pending files from `drizzle/` against `DATABASE_URL`,
using `drizzle-kit migrate`. This is the local/development path.

**`db:deploy`** (`scripts/migrate.ts`) applies the exact same `drizzle/` folder
through `drizzle-orm/postgres-js/migrator` directly — no `drizzle-kit` involved.
The reason for a second applier rather than reusing `db:migrate` in production:
**`drizzle-kit` is a `devDependency`**, and the production Docker image installs
a production-only dependency tree (see [Deployment](./deployment.md)). `db:deploy`
runs on a single dedicated connection (`max: 1`, migrations must apply in order),
closes it before the API starts, and is idempotent — already-applied migrations
are skipped — which is what makes it safe to run on every container restart as
part of the start command (`start:prod`).

Both appliers read the same `drizzle/` folder and write to the same
`__drizzle_migrations` bookkeeping table, so they are interchangeable in terms of
what state they produce. **Keep the two paths equivalent**: never hand-edit a
committed migration file, and never apply a migration in one environment through
one path and in another through the other without both ending at the same
`drizzle/` contents.

## Local workflow

```bash
bun run db:up          # docker compose up -d db — Postgres 16 on localhost:5433
bun run db:migrate      # applies drizzle/ against it
```

After editing `schema.ts`:

```bash
bun run db:generate    # writes drizzle/NNNN_*.sql + meta/
bun run db:migrate     # applies it locally
git add drizzle/       # commit the generated migration
```

`DATABASE_URL` is required by every Drizzle command and every test script, and
Drizzle reads it directly from `drizzle.config.ts`
(`dbCredentials: { url: process.env.DATABASE_URL! }`) — no separate config to keep
in sync.

## Production

The container's start command is `start:prod` → `bun run db:deploy && bun run
src/index.ts`. Point `DATABASE_URL` at the deployed database (on Railway, a
variable reference to the linked Postgres service tracks it automatically) and the
migration runs automatically on every deploy and every restart. To run it by hand
against a remote database from a local shell — for `bun run seed`, for instance —
export the deployed database's **public** proxy URL with `?sslmode=require`
appended:

```bash
DATABASE_URL='postgres://...proxy.rlwy.net:PORT/railway?sslmode=require' bun run db:deploy
```

## Tables at a glance

See [Data model](../architecture/data-model.md) for the full schema. In brief:
`clients` (merchants), `payments`, `deposits` (one row per on-chain transfer),
`ledger_entries` (the COP balance audit trail), `webhook_jobs` (outbound queue),
`admin_users` / `admin_sessions` / `admin_audit_log` (the console's identity and
write trail), `sweeps` (treasury consolidation, no foreign key to `payments` — see
[ADR-0008](../adr/0008-sweeps-no-payment-fk.md)), and `hd_counter` (the one-row
global HD derivation index, bound to a mnemonic's BIP-32 fingerprint).
