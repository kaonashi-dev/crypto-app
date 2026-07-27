# Logging

Every module logs through one service (`src/observability/`). Nothing in `src/`
writes to `console` directly — that single rule is what makes level control,
secret redaction, trace correlation, the `/admin` log tail and OTLP export
possible at all.

```ts
import { getLogger } from "../observability";

const log = getLogger("payments");

log.info("payment created", {
  "payment.id": p.publicId,
  "payment.amount_cop": p.amountCop,   // bigint is fine — serialised as a string
  "chain.network": p.network,
});
```

## Why this shape

The record model is OpenTelemetry's: observed timestamp, numeric severity 1–24
with its text, a human `body`, a flat map of `attributes`, and the trace/span ids
of the context it was emitted in. Attribute names follow OTel semantic
conventions where one exists (`http.request.method`, `db.system`,
`server.address`, `exception.type`) and a domain namespace where none does
(`payment.*`, `deposit.*`, `chain.*`, `rate.*`, `webhook.*`, `wallet.*`).

Holding that shape without the OTel SDK keeps the dependency tree as it was —
this project runs on Bun with a deliberately short `package.json` — while
staying exportable: `OTEL_EXPORTER_OTLP_ENDPOINT` ships these exact records to
any collector, and until one is configured they are just lines on stdout.

## Reading the output

`pretty` on a TTY, `json` everywhere else (so a container ships parseable lines
without being told to). Force either with `LOG_FORMAT`.

```
23:26:21.129 INFO  payments    payment pending balance updated  payment.id=test_06d… payment.status_before=pending payment.status=detecting …
```

```json
{"timestamp":"2026-07-27T04:26:21.129Z","severity_text":"INFO","severity_number":9,
 "scope":"payments","body":"payment pending balance updated","trace_id":"7cc6fe…","span_id":"17e067…",
 "service.name":"crypto-gateway","payment.id":"test_06d…","payment.status":"detecting"}
```

Warnings and above go to stderr, everything else to stdout — platforms classify
a line by its stream, so a warning on stdout is invisible to every "show me the
errors" filter.

## Levels

`LOG_LEVEL` takes a level, or a comma list with per-scope overrides; the longest
matching scope prefix wins.

```bash
LOG_LEVEL=debug                      # default locally
LOG_LEVEL=info,payments=debug        # quiet, except the state machine
LOG_LEVEL=warn,watcher=trace         # only problems, plus every backfill chunk
LOG_LEVEL=info,db=trace              # add every SQL statement
```

Scopes: `config`, `gateway`, `db`, `http`, `auth`, `payments`, `rates`,
`wallet`, `webhooks`, `trongrid`, `metrics`, and per network
`supervisor:<network>`, `watcher:<network>`, `confirmer:<network>`,
`tron-watcher:<network>`, `tron-confirmer:<network>`.

Roughly what lives where:

| Level | Contents |
| --- | --- |
| `trace` | SQL statements, individual TronGrid calls, backfill chunks, cache hits |
| `debug` | Address derivation, worker ticks, HTTP requests, deposits skipped for a known reason |
| `info` | Payment created, transfer seen, deposit recorded/confirmed, **PAID**, expiry, webhook delivered |
| `warn` | Underpayment, late deposit, deposit against a terminal payment, reorg unwind, rate degradation, auth rejection, 4xx |
| `error` | Dead-lettered webhook, refusing to quote, unreachable RPC, 5xx |
| `fatal` | Missing required configuration at boot |

## Traces

Each HTTP request and each worker tick opens a trace context
(`AsyncLocalStorage`), so everything logged downstream carries the same
`trace_id` without any function signature changing. Responses carry it back as
`x-trace-id`, and an inbound W3C `traceparent` is adopted rather than replaced —
so a merchant's own tracing joins up with these logs. Outbound webhooks carry
`traceparent` on for the same reason.

To follow one payment end to end, search the trace id, or just the payment id:
`payment.id` is attached to the context as soon as it is known, including inside
the watcher → `registerDeposit` → `confirmDeposit` chain.

## Secrets

Every record passes through `redact()` before it reaches a sink. Two layers:

1. **Literal** — every secret-looking value in the environment (anything named
   `*SECRET*`, `*PASSWORD*`, `*MNEMONIC*`, `*API_KEY*`, plus the `DATABASE_URL`
   password) is replaced wherever it appears, including inside a third-party
   error string. This is the layer that catches the leaks nobody wrote: viem
   quotes the full request URL, and Alchemy carries the key as a path segment.
2. **Shape** — `Authorization` headers, credentials in URLs, `?api_key=`, and
   attribute keys that are credentials by name (`*.secret`, `*.signature`,
   `*.api_key`). Note `token.address` and `token.decimals` are ERC-20 metadata
   and are *not* masked.

Things that must stay correlatable but not usable are fingerprinted instead:
an API key is logged as `client.api_key_hash_prefix`, a webhook HMAC as
`webhook.signature_fingerprint` (`a1b2…f9c0`).

Query parameters are logged; SQL statement **parameters** are not.

## Operator endpoints

Both sit behind the console's operator sign-in with the rest of `/admin/api`.

`GET /admin/api/logs` — the process's own log tail from an in-memory ring
(`LOG_BUFFER`, default 500). Testing a payment means following it across an HTTP
request, a chain watcher and a confirmer, and the terminal holding that output is
usually not the one you are testing from — a deployed container has none at all.

```
?level=warn      minimum severity
?scope=watcher   scope prefix
?q=test_06dcfb   substring over body, scope and attribute values
?since=1234      only records after this sequence number (polling)
?limit=200
```

`GET /admin/api/diagnostics` — the configuration in force, counters and timings
since boot, the pricing caches, per-network enabled state, and where logs are
being exported. Answers "is the watcher actually running", "how many provider
calls did that test cost", "which rate is frozen in the cache" without reading
the deployment's environment.

`GET /health` stays deliberately thin: it is public and the platform hits it
constantly.

## Counters

`count()`, `gauge()` and `observe()` (`src/observability/metrics.ts`) are cheap
enough for hot paths and are what the heartbeat prints once a minute, as deltas:

```
INFO metrics heartbeat  uptime_s=312 process.memory.rss_mb=94.2 chain.height=8123456
                        since_last={"rpc.calls{network=eth-sepolia,method=eth_getLogs}":6,"db.queries":41}
```

Totals live at `/admin/api/diagnostics`. Series worth knowing: `payments.created`,
`payments.status{to=…}`, `deposits.registered|confirmed|ignored{reason=…}|unwound`,
`rpc.calls{network,method}`, `http.server.requests{route,status}`,
`webhooks.delivered|failed|dead`, `rates.cache{result=…}`, `rates.degraded{source=…}`,
`db.queries`.

`deposits.ignored{reason=…}` is the one to check first when a transfer visibly
landed on-chain but nothing happened: `unknown_address`, `duplicate`,
`terminal_payment`, `late`.

## Exporting

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 bun run dev
```

Records batch and POST as OTLP/HTTP JSON to `<endpoint>/v1/logs` every
`OTEL_BSP_SCHEDULE_DELAY` ms (default 5000). Auth headers go in
`OTEL_EXPORTER_OTLP_HEADERS` as `key=value,key2=value2`. A batch that fails to
export is **dropped**, not retried — retrying against a collector that is down is
how a logging pipeline becomes the outage. Drops are counted and reported at
`/admin/api/diagnostics`.

## Test scripts

`scripts/quiet.ts` drops the service log to `warn` in the standalone scripts, so
their `ok/FAIL` lines stay readable. It must be the first import in a script
(ES modules evaluate in import order, and the logger reads `LOG_LEVEL` once when
it loads). An explicit `LOG_LEVEL` still wins:

```bash
LOG_LEVEL=debug bun run scripts/smoke-test.ts   # watch the state machine work
```

## Adding a log line

- Get a scoped logger at module top level; use `child()`/`getLogger(scope, attrs)`
  for a per-network variant.
- Put the *facts* in attributes, not in the message. `body` should be stable text
  you can grep for; the numbers belong beside it.
- Log the decision **and its inputs**, especially when the decision is "do
  nothing". A deposit that changes no state is the case that looks like a bug
  from outside.
- `log.time("…")` returns a finisher that adds `duration_ms`; `log.span()` wraps
  an async unit of work in its own span.
- Use `log.repeat(key, level, body, attrs)` for anything that can fire on every
  tick — it reports once, then again only when the message changes or five
  minutes pass, and says how many it swallowed. `log.resolved(key)` announces
  recovery.
- Guard expensive attribute building with `log.enabled("debug")`.
