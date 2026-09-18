# Deployment (Railway)

Still testnet-first: see the [mainnet checklist](./mainnet-checklist.md) before
serving `bsc` or `polygon`. This page covers what makes the gateway reachable on
a public URL.

The repo ships the three files Railway reads: `Dockerfile` (installs, builds the
SPA, and drops the Vite toolchain from the runtime image — a production-only
dependency tree), `.dockerignore`, and `railway.json` (Dockerfile builder,
`/health` health check, `numReplicas: 1`).

## 1. Create the services

In a Railway project, add a **PostgreSQL** database, then a service from this
repo. Railway detects the `Dockerfile` and builds it — no Nixpacks configuration
to maintain.

## 2. Set the variables

| Variable | Value |
|---|---|
| `DATABASE_URL` | Railway's variable reference to the linked Postgres service's connection string, so it tracks the database service automatically |
| `HD_MNEMONIC` | its own mnemonic from `bun run mnemonic:new`, quoted — not the one your local `.env` uses, and not a published test phrase |
| `ADMIN_PASSWORD` | a generated password for the console operator (`ADMIN_USER`, default `admin`); the boot refuses to start in production without it |
| `ALCHEMY_SEPOLIA_KEY`, `ALCHEMY_BASE_SEPOLIA_KEY`, … | your Alchemy key per network you want detected |
| `PUBLIC_BASE_URL` | optional; pins `checkout_url`s to a custom domain, no trailing slash |

Do **not** set `PORT` — Railway injects it and the server binds to it.
`NODE_ENV=production` comes from the image, which is also what makes
`ADMIN_PASSWORD` mandatory (see [Configuration](./configuration.md)). A network
whose Alchemy key is absent is skipped at boot with one log line — payments on it
would be created but never detected — so set only the keys you have.

If serving mainnets or enabling sweeping, also set `ENABLE_MAINNETS`,
`TREASURY_ADDRESS_EVM`/`TREASURY_ADDRESS_TRON`, and the `SWEEP_*` variables per
the [mainnet checklist](./mainnet-checklist.md) and
[sweeping runbook](./sweeping-runbook.md) — both gate hard at boot when
misconfigured.

## 3. Deploy

The container's start command is `start:prod`, which runs `bun run db:deploy`
(drizzle-orm's own migrator over the versioned `drizzle/` folder, idempotent —
see [Database](./database.md)) and then starts the API and workers.
`drizzle-kit` is a devDependency, which is why deployed migrations go through
`scripts/migrate.ts` rather than `bun run db:migrate`.

## 4. Create a merchant

From a local shell with `DATABASE_URL` pointed at the Railway database's
**public** proxy URL (append `?sslmode=require`):

```bash
DATABASE_URL='postgres://...proxy.rlwy.net:PORT/railway?sslmode=require' bun run seed
```

Or use the console's **Build** view once `ADMIN_PASSWORD` is set — it can
provision a merchant (Merchants view) and issue a payment on its behalf without a
shell at all.

Then `POST https://<your-app>.up.railway.app/api/payments` with that key; the
returned `checkout_url` is `https://`, because the origin is read from the
forwarded scheme rather than the plain-HTTP request Railway's edge hands the
container.

## Operational properties worth knowing

- **One replica.** `railway.json` pins `numReplicas: 1`. The watchers, confirmers,
  sweeper and expirer are in-process `setInterval` loops with no leader election,
  so a second replica would duplicate every provider call and every poll. Deposit
  idempotency and row locks mean it would not corrupt a payment, but it doubles
  the metered spend for nothing.
- **Health check.** `GET /health` returns `{"ok":true}` without touching
  Postgres — it reports that the process is serving, deliberately not that the
  database is reachable, so a brief database blip cannot cascade into a restart
  loop that also drops the WebSocket subscriptions.
- **Cost.** The container is idle-cheap by design (see
  [Troubleshooting](./troubleshooting.md) for the provider-cost rules), but it is
  a long-running process with WebSocket subscriptions, not a scale-to-zero
  function — it bills for wall-clock time.
