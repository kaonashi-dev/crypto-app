# Repository Guide

## Sources Of Truth

- Use Bun; dependencies are locked by `bun.lock`. There is one package, with a Bun/Hono backend and a Vite/SolidJS frontend under `web/`.
- Treat `src/config.ts` (`NETWORKS`, token definitions, confirmations, explorers) as authoritative for supported chains/assets. `docs/OVERVIEW.md` predates the implemented `tron-nile`/USDT path; the README and code are current.
- Database schema changes start in `src/db/schema.ts`; run `bun run db:generate` and commit the generated migration under `drizzle/`. Apply it with `bun run db:migrate`.

## Setup And Commands

- Copy `.env.example` to `.env`. Bun loads it automatically. Never read, print, or commit the real `.env`; it contains RPC keys and the mnemonic.
- `HD_MNEMONIC` comes from `bun run mnemonic:new --write`, which generates a tree and edits that one line without printing it. Never substitute a published test mnemonic (hardhat/anvil, ganache, the BIP-39 vector): `preflight()` warns on testnets and refuses to boot if any registered network is not a testnet. Rotating it is not a config tweak — `hd_counter.seed_fingerprint` binds the database to one tree, so a swap fails at boot and at the next `reserveDerivationIndex`.
- Never use a real or production environment, database, credentials, RPC configuration, or funds unless the user explicitly requests it.
- Local Postgres is PostgreSQL 16 on host port 5433: `bun run db:up`, then `bun run db:migrate`. `DATABASE_URL` is also required by Drizzle commands and every test script.
- Deployment is a container: `Dockerfile` (builds the SPA, ships a production-only dependency tree) and `railway.json`. Migrations there run through `bun run db:deploy` (`scripts/migrate.ts`, drizzle-orm's migrator) because `drizzle-kit` is a devDependency. Keep the two paths equivalent — both read `drizzle/`.
- `preflight()` in `src/config.ts` is the only place that exits on bad configuration, and it is called from `src/index.ts` alone. Importing `src/config.ts` must stay side-effect free so the test scripts keep working without a full environment.
- Backend plus all network workers: `bun run dev` (watch mode) or `bun run start`. This probes external RPCs and starts watcher/confirmer loops; tests should import `app` from `src/api/routes.ts` instead of importing `src/index.ts`.
- Hot UI development requires two processes: backend `bun run dev` and Vite `bun run dev:web` on port 5173. Vite proxies `/api`, `/public`, and `/admin/api` to port 3000.
- The backend serves only the built SPA from `web/dist`; run `bun run build:web` or `/pay/*` and `/admin*` return 503.

## Verification

- There is no lint script or test-runner suite. Run both independent typechecks: `bun run typecheck` for `src/` and `scripts/`, and `bun run typecheck:web` for `web/src/` (which also rejects unused symbols).
- Focused checks are standalone scripts: `bun run scripts/smoke-test.ts`, `bun run scripts/api-test.ts`, and `bun run scripts/admin-test.ts`. The API/admin scripts use Hono `app.request()`; no running server or chain access is needed.
- Run `bun run build:web` before `api-test.ts` or `admin-test.ts`; both assert that the SPA shell/assets are served. `smoke-test.ts` does not need the web build.
- These scripts use fixed rates and injected deposits, so they do not call CoinGecko, FX providers, Alchemy, or TronGrid. They do require a migrated PostgreSQL database.
- Each script imports `./quiet` first, which drops the service log to `warn` so the `ok/FAIL` lines stay readable; it must stay the first import. Override it to watch the machinery work: `LOG_LEVEL=debug bun run scripts/smoke-test.ts`.
- Tests append clients/payments/deposits and do not clean up. In addition, `smoke-test.ts` runs the global expiry routine and can expire unrelated stale rows. Use a disposable development database, not shared data.

## Architecture And Invariants

- `src/index.ts` is the process entrypoint and starts API, per-network supervisors, expiry, and webhook delivery together. Payment state transitions belong in `src/services/payments.ts`; chain workers should feed its `registerDeposit`/`confirmDeposit` contract rather than duplicate settlement logic.
- EVM uses Alchemy WebSockets plus chunked log backfill; Tron has no WebSocket and polls TronGrid. Preserve family-specific derivation (`m/44'/60'` vs `m/44'/195'`), address formats, and checkout URI behavior when adding networks.
- Keep money as `bigint` in smallest units: COP has no decimals, current tokens have 6 decimals, and frozen COP-per-token rates are scaled by 1e6. COP-to-token conversion must round up; API/admin JSON must serialize bigint amounts as strings.
- Preserve deposit idempotency by `(network, txHash, logIndex)`, row locks around state transitions, and the guard against crediting a paid payment twice. Late/terminal deposits are still recorded for reconciliation even when they no longer affect settlement.
- One Vite bundle serves both surfaces; the TanStack route tree in `web/src/router.tsx` owns `/pay/$publicId` and `/admin/*`, and the backend returns the same shell for both. Checkout copy is intentionally Spanish and payer-facing; `web/src/admin/` is an English, dark operator console. The two palettes and the shared type system live in `web/src/index.css`; status marks (`web/src/lib/status.ts`) are the non-colour channel both surfaces use, so no status is ever carried by hue alone.
- Frontend data access goes through TanStack Query, never a bare `useEffect` fetch. Polling cadence is a query option: the checkout's status query stops itself on a terminal status, and every console query takes its interval from `refreshInterval()` in `web/src/admin/console.ts` so the auto-refresh preference stays in one place. Console filters belong in the URL via `validateSearch`, not in component state.
- Nothing in `src/` calls `console` directly. Get a scoped logger from `src/observability` (`getLogger("payments")`) and log facts as attributes, not as interpolated message text — that single rule is what gives level control, secret redaction, trace correlation, the `/admin/api/logs` tail and OTLP export. Records follow the OpenTelemetry log data model and its semantic conventions; `docs/LOGGING.md` is the reference, including the attribute namespaces and which level a line belongs at. Redaction happens at the sink, so a new call site cannot forget it — but do not defeat it by pasting a secret into a message body.
- `/admin` is intentionally read-only and cross-merchant. Access is a named operator session: `admin_users` holds argon2id password hashes, `admin_sessions` holds one row per signed-in browser (the cookie carries a random token, the row its SHA-256), and `adminSessionGuard` in `src/api/admin-auth.ts` covers all of `/admin/api/*` except the login endpoint. The console *shell* stays public — it is static markup, and the login screen has to render. `ADMIN_PASSWORD` is the bootstrap operator's password (`ADMIN_USER`, default `samuel`), reapplied on every boot by `bootstrapOperator()`, which is how a deployment's access is recovered or reset; the preflight makes it mandatory in production and optional locally, and without it the console runs open as it always did. Accounts are still created only by that boot path — do not add console-driven user management or any other mutation without an audit model to go with it.
