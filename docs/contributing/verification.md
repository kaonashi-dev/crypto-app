# Verification

There is no lint script and no test-runner suite. Two independent typechecks
plus three standalone scripts are what this repository has instead — run all
five before calling a change verified.

```bash
bun run typecheck        # tsc --noEmit over src/ and scripts/
bun run typecheck:web    # tsc -p web/tsconfig.json over web/src/

bun run build:web                # required before api-test.ts / admin-test.ts
bun run scripts/smoke-test.ts    # state machine: partial, complete, overpay, dust, idempotency
bun run scripts/api-test.ts      # HTTP layer: auth, checkout endpoint (EIP-681/QR), SPA + assets
bun run scripts/admin-test.ts    # backoffice API: filters, tx-hash search, detail joins, bigint serialization
```

## What each one actually proves

| Command | Proves | Does not prove |
|---|---|---|
| `typecheck` | The backend and scripts compile against the current types — a changed `bigint`/`string` boundary or a schema field rename that broke a caller shows up here first. | Runtime behaviour, or anything about `web/`. |
| `typecheck:web` | The frontend compiles **and has no unused symbols** — this config rejects them, which `typecheck` does not. | Runtime behaviour, or that a component renders correctly. |
| `smoke-test.ts` | The payment state machine end to end against a real Postgres: partial payment, completion, overpayment, dust tolerance, deposit idempotency. Also runs the global expiry routine as part of its pass. | Anything about the HTTP layer or the console — it calls service functions directly. |
| `api-test.ts` | The merchant-facing HTTP layer: `X-Api-Key` auth, the checkout endpoint's EIP-681/QR payload, and that the SPA shell and its assets are actually served (requires `build:web` first). | Chain detection or the console API. |
| `admin-test.ts` | The backoffice API: list filters, transaction-hash search, per-payment detail joins, and that every bigint on the wire serializes as a string (requires `build:web` first). | Console **write** routes beyond what the script exercises directly — read them before assuming coverage. |

None of the three scripts calls CoinGecko, an FX provider, Alchemy, or
TronGrid — they inject deposits and use fixed rates through the same service
functions the real workers call, which is what makes them runnable offline and
deterministic. They **do** require a migrated PostgreSQL database
(`bun run db:up && bun run db:migrate`).

## The `quiet` import

Each script imports `./quiet` **first**, before any `../src` import. It drops
the service log to `warn` so the script's own `ok`/`FAIL` lines stay readable
against a normally-chatty `debug` default. This has to be the first import
because ES modules evaluate in import order and the logger reads `LOG_LEVEL`
once, when it loads — importing `quiet` afterwards is a no-op. Override it
explicitly to watch the machinery work while a script runs:

```bash
LOG_LEVEL=debug bun run scripts/smoke-test.ts
```

## Use a disposable database

The three scripts **append** clients, payments and deposits and do not clean up
after themselves. `smoke-test.ts` additionally runs the global expiry routine,
which can expire unrelated stale rows it did not create. Point `DATABASE_URL` at
a development database you are comfortable accumulating test data in — not one
with data you need to keep, and never a real or production database.

## Import boundary the test scripts depend on

`preflight()` in `src/config.ts` is the only place that exits the process on bad
configuration, and it is called from `src/index.ts` alone. Importing
`src/config.ts` — or anything that transitively imports it, which is most of
`src/` — must stay side-effect free, which is what lets `api-test.ts` and
`admin-test.ts` import `app` from `src/api/routes.ts` and exercise real routes
via Hono's `app.request()` without a running server, a full `.env`, or chain
access.
