# Configuration

Every environment variable the gateway reads, cross-checked against three sources:
the `env` object in `src/config.ts` (roughly lines 9–137, plus the per-network
Alchemy keys read inline in the `NETWORKS` registry), the `.env.example`
template, and the boot-time validation in `preflight()` / `preflightSweeping()`.
Logging and telemetry variables live in
`src/observability/` rather than `config.ts`; they are documented in full at
[Observability](../architecture/observability.md) and summarised here.

Bun loads `.env` automatically — copy `.env.example` to `.env` and fill it in. See
[Local development](./local-development.md) for the setup sequence.

## Core

| Variable | Default | Meaning | Preflight rule |
|---|---|---|---|
| `DATABASE_URL` | — (required) | Postgres connection string. Also required by every Drizzle command and test script. | Missing → `preflight()` logs `fatal` and `process.exit(1)`. |
| `HD_MNEMONIC` | — (required) | The seed every receiving, relayer and treasury-bound key derives from. Trimmed before use — a stray leading space derives a silently different tree. | Missing → fatal exit. Invalid BIP-39 checksum → fatal exit. A [published test mnemonic](../../src/config.ts) (hardhat/anvil, ganache, the BIP-39 vector) → **fatal** if any offered network is a mainnet, **warning** if testnets only. |
| `PORT` | `3000` | HTTP port. Railway injects its own value — do not set this variable there. | none |

## Business parameters

| Variable | Default | Meaning | Preflight rule |
|---|---|---|---|
| `QUOTE_TTL_MINUTES` | `15` | How long a frozen COP→crypto quote is valid before `expired`. | none |
| `GRACE_TTL_MINUTES` | `90` | Extra time after a first (partial) deposit to complete at the frozen rate. | none |
| `SPREAD_BPS` | `75` (0.75%) | Spread added over the market rate when quoting. | none |
| `DUST_TOLERANCE_BPS` | `50` (0.5%) | How far below the exact required amount still counts as paid. | none |

## Mainnets

| Variable | Default | Meaning | Preflight rule |
|---|---|---|---|
| `ENABLE_MAINNETS` | off (`false`) | Serves `bsc` and `polygon` alongside the testnets — i.e. `NETWORK_IDS` includes them, so the API will quote and derive a real address on them. Not inferred from whether a mainnet Alchemy key is present. | Arms the public-mnemonic check above: a build with this set and a known-public `HD_MNEMONIC` refuses to boot. See the [mainnet checklist](./mainnet-checklist.md). |
| `ALCHEMY_BSC_KEY` | unset | Alchemy key for `bsc`. Only read once `ENABLE_MAINNETS` serves it. | Missing → network skipped at boot with a log line (`missingCredential`), not fatal. |
| `ALCHEMY_POLYGON_KEY` | unset | Alchemy key for `polygon`. Same rule. | Same. |

## Alchemy (per-network RPC credentials)

Read directly off `Bun.env` inside the `NETWORKS` registry (`credentialEnv` per
network), not through the `env` object — `missingCredential()` looks each one up by
name. A network whose key is unset still accepts payments and derives addresses; it
just has nothing watching it, and the boot names it in a warning.

| Variable | Network | Preflight rule |
|---|---|---|
| `ALCHEMY_SEPOLIA_KEY` | `eth-sepolia` | Missing → warning, network runs unwatched. |
| `ALCHEMY_BASE_SEPOLIA_KEY` | `base-sepolia` | Same. |
| `ALCHEMY_BSC_TESTNET_KEY` | `bsc-testnet` | Same. |
| `ALCHEMY_AMOY_KEY` | `polygon-amoy` | Same. |
| `ALCHEMY_BSC_KEY` | `bsc` (mainnet) | Same; also gated behind `ENABLE_MAINNETS`. |
| `ALCHEMY_POLYGON_KEY` | `polygon` (mainnet) | Same; also gated behind `ENABLE_MAINNETS`. |

## Tron and EVM cost dials

| Variable | Default | Meaning | Preflight rule |
|---|---|---|---|
| `TRONGRID_API_KEY` | unset | Raises TronGrid's per-IP rate limit. The public Nile testnet works without one. | none |
| `BACKFILL_BLOCKS` | `50` | How far back the EVM token backfill looks to cover WebSocket gaps. | none |
| `LOG_RANGE_BLOCKS` | `10` | Largest `eth_getLogs` span per call (Alchemy free tier caps this at 10); the backfill walks its window in chunks of this size. | none |
| `NATIVE_BACKFILL_BLOCKS` | `20` | Re-read window for the native-coin backfill. Deliberately smaller than `BACKFILL_BLOCKS`: each block is its own call, with no range query to amortise it. | none |
| `BACKFILL_INTERVAL_SEC` | `300` | EVM token backfill cadence. Live detection is the WebSocket; this only catches what a reconnect missed. | none |
| `TRON_POLL_INTERVAL_SEC` | `60` | Tron has no WebSocket, so this *is* detection latency for a payer who closed the tab. | none |
| `CONFIRMER_INTERVAL_SEC` | `30` | How often maturing deposits are re-checked for confirmation depth. | none |
| `FALLBACK_USD_COP` | unset (`null`) | Last-resort USD→COP rate when every FX provider is unreachable and no cached rate is fresh. Unset means refuse to quote rather than guess. | none |

## Console (`/admin`)

| Variable | Default | Meaning | Preflight rule |
|---|---|---|---|
| `ADMIN_USER` | `admin` | Bootstrap operator username. Lower-cased and trimmed. | none |
| `ADMIN_PASSWORD` | unset (`null`) | Bootstrap operator's password, reapplied to `admin_users` on every boot by `bootstrapOperator()`. Also what gates the console's write surface (`requireOperator`). | **Required in production** (`env.isProduction`) — missing → fatal exit. Optional locally: unset means the console runs open for reads and refuses every write with `403 auth_required_for_mutation`. |
| `ADMIN_SESSION_TTL_HOURS` | `12` | How long a console session cookie lasts, sliding while in use. | none |
| `PUBLIC_BASE_URL` | unset (`null`) | Pins `checkout_url` to a fixed origin instead of deriving it from `X-Forwarded-*` headers. No trailing slash. | none |

## Treasury sweeping

See the [sweeping runbook](./sweeping-runbook.md) and
[docs/design/SWEEPING-PLAN.md](../design/SWEEPING-PLAN.md) for the mechanism; this is
the reference table.

| Variable | Default | Meaning | Preflight rule |
|---|---|---|---|
| `SWEEP_ENABLED` | off (`false`) | Starts the sweeper worker per EVM network. Unset: nothing is planned, signed, or written — today's behaviour. | Arms `preflightSweeping()` below. |
| `SWEEP_DRY_RUN` | **on** (`true`) | Candidates are selected and recorded as `planned` rows with reasons; nothing is ever signed. Note the parse: only `0`/`false`/`no` turn it off — everything else, including unset, is dry-run. | If dry-run, the mainnet/local-signer check below is skipped. |
| `SWEEP_INTERVAL_SEC` | `120` | Sweeper tick cadence. | none |
| `SWEEP_MIN_USD` | `5` | Floor in USD below which value is left to accumulate rather than swept. | none |
| `SWEEP_MAX_COST_BPS` | `200` (2%) | Refuses a sweep whose estimated fee exceeds this share of the value moved. | none |
| `SWEEP_GAS_CEILING_GWEI` | unset (`null`) | Global override of each network's own `sweepGasCeilingGwei` in the registry. | none |
| `SWEEP_MAX_ATTEMPTS` | `8` | Attempts before a sweep is dead-lettered (`failed`), matching the webhook dead-letter convention. | none |
| `SWEEP_NATIVE_HEADROOM_BPS` | `500` (5%) | Extra headroom subtracted from a native-coin sweep, since the fee comes out of the same balance being moved and gas price can rise before inclusion. | none |
| `SWEEP_AUTH_TTL_SEC` | `86400` (24h) | How long a signed EIP-3009 authorization stays valid — long enough that a crash-recovery rebroadcast re-signing the stored nonce is still accepted. | none |
| `TREASURY_ADDRESS_EVM` | unset (`null`) | Where EVM sweeps land. Never a key the gateway holds — a destination only. | If `SWEEP_ENABLED` and an EVM network is served: missing or malformed (`0x` + 40 hex) → fatal exit. |
| `TREASURY_ADDRESS_TRON` | unset (`null`) | Where Tron sweeps land. | If `SWEEP_ENABLED` and Tron is served: missing or malformed (Base58Check `T…`) → fatal exit. |
| `SWEEP_SIGNER` | `local` | Which `Signer` implementation holds deposit/relayer keys. `local` derives in-process from `HD_MNEMONIC`; `remote` (KMS/HSM/MPC) is the seam and is **not implemented** — `getSigner()` throws. | `local` + a served mainnet + `SWEEP_DRY_RUN` off → fatal exit (see [mainnet checklist](./mainnet-checklist.md)). |
| `SWEEP_RECON_ENABLED` | off (`false`) | Starts the reconciliation worker independently of `SWEEP_ENABLED` — it is read-only auditing. | none |
| `SWEEP_RECON_INTERVAL_SEC` | `3600` (1h) | Reconciliation tick cadence. | none |
| `SWEEP_RECON_MAX_ADDRESSES` | `200` | Addresses examined per tick; a cursor rotates through the remainder on later ticks. | none |

## Logging and telemetry

Full reference: [Observability](../architecture/observability.md). Read by
`src/observability/logger.ts`, `otlp.ts`, `metrics.ts` and `buffer.ts` — not by
`config.ts`, so they are outside `configSummary()` and reported by
`GET /admin/api/diagnostics.logging` instead.

| Variable | Default | Meaning |
|---|---|---|
| `LOG_LEVEL` | `debug` locally, `info` in production | A level, or a comma list with per-scope overrides (`info,payments=debug,db=trace`). Longest matching scope prefix wins. |
| `LOG_FORMAT` | `pretty` on a TTY, `json` otherwise | Force either explicitly. |
| `LOG_COLOR` | on when a TTY and `NO_COLOR` is unset | `1` forces colour even without a TTY; `0` or `NO_COLOR` disables it. |
| `NO_COLOR` | unset | Standard convention, honoured alongside `LOG_COLOR`. |
| `LOG_BUFFER` | `500` | Records kept in memory for `GET /admin/api/logs`. `0` disables the ring entirely. |
| `LOG_SILENT` | off | `1` drops the console sink — used by the test scripts via `scripts/quiet.ts`. |
| `HEARTBEAT_INTERVAL_SEC` | `60` | Liveness line with counter deltas. `0` disables it. |
| `SERVICE_VERSION` | `RAILWAY_GIT_COMMIT_SHA` (first 7 chars) or `0.1.0` | `service.version` resource attribute. |
| `OTEL_SERVICE_NAME` | `crypto-gateway` | `service.name` resource attribute. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset (export off) | Base collector URL, e.g. `http://localhost:4318`. |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | `<endpoint>/v1/logs` | Full override if the logs path is not the default. |
| `OTEL_EXPORTER_OTLP_HEADERS` | unset | `key=value,key2=value2` — auth headers for the collector. |
| `OTEL_BSP_SCHEDULE_DELAY` | `5000` (ms) | Batch flush interval. |

## Gaps found while cross-checking

Three variables are read in code and are **not** given an example line in
`.env.example` — they are either platform-injected (not meant to live in a
developer's `.env`) or documented only in `.env.example`'s prose header rather than
as a `# VAR=value` line like their neighbours. Listed rather than papered over, per
the source of truth for this page:

- **`NODE_ENV`** — read at `src/config.ts:44` (`env.isProduction`), which gates
  whether `ADMIN_PASSWORD` is mandatory and whether the mainnet/local-signer sweep
  boundary applies. Not in `.env.example` at all. This is deliberate — the README's
  deployment section states Railway's image sets it — but it means a reader of
  `.env.example` alone would not learn that this variable exists or that it changes
  preflight behaviour.
- **`RAILWAY_GIT_COMMIT_SHA`** — read at `src/observability/logger.ts` as a
  fallback for `service.version` when `SERVICE_VERSION` is unset. Platform-injected
  on Railway only; absent from `.env.example`, consistent with `NODE_ENV` above.
- **`LOG_COLOR`, `LOG_BUFFER`, `LOG_SILENT`, `HEARTBEAT_INTERVAL_SEC`** — all four
  are real, read variables (see the table above) and are described in
  `.env.example`'s logging comment block, but unlike `LOG_LEVEL`, `LOG_FORMAT` and
  every `OTEL_*` variable, none of them gets its own `# VAR=value` example line. A
  reader skimming for `# `-prefixed lines rather than prose would miss that they
  exist.

No variable exists in `.env.example` without a matching read in `src/config.ts` or
`src/observability/`, and no sweeping variable is documented in only one of the three
sources — the sweeping block in `.env.example` is complete against `preflightSweeping()`.
