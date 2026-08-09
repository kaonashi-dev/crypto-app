# Troubleshooting

## "Nothing is being detected" on an EVM network

1. Check `GET /admin/api/diagnostics` → `networks[].enabled` /
   `missing_credential`. `enabled: false` with a `missing_credential` value means
   the Alchemy key for that network is unset — the network still accepts
   payments and derives addresses, it just has nothing watching them.
2. If the key is set and it is still not enabled, the network may be **withheld**
   (`offered: false`) — a mainnet with `ENABLE_MAINNETS` unset. See the
   [mainnet checklist](./mainnet-checklist.md).
3. If `enabled: true` and a payment still is not detected, check `GET
   /admin/api/deposits` for the transaction hash. A deposit that is present but
   not affecting the payment (`settles: false`) means it arrived in a different
   asset than the one quoted, or after the payment reached a terminal state —
   both are recorded for reconciliation and intentionally never credited.

## RPC backoff and "network disabled" warnings

Workers start per network only once its RPC answers a liveness probe, retrying
every 60s with exponential backoff capped at 15 minutes. `log.repeat()` throttles
a persistently failing check to one line every 5 minutes rather than one per
tick — a burst of retries in the log is not itself the problem; a `resolved`
line confirms recovery. `rpc-log.ts` centralises this so every watcher/confirmer
reports the same way.

## Alchemy `eth_getLogs` and the 10-block cap

Alchemy's free tier caps `getLogs` at a 10-block range per call
(`LOG_RANGE_BLOCKS`). The EVM token backfill walks its full window
(`BACKFILL_BLOCKS`, default 50) in chunks of that size — raising `BACKFILL_BLOCKS`
without raising `LOG_RANGE_BLOCKS` (or a paid Alchemy tier) only increases the
number of chunked calls per backfill tick, not the range each one covers.
`getLogs` is also the single most expensive RPC method Alchemy meters — see the
cost table in [Configuration](./configuration.md#tron-and-evm-cost-dials) — so
this is the first dial to reach for when a cost bill runs high. Native coins
(BNB, POL) are not events and cannot use `getLogs` at all — the native watcher
reads whole blocks instead, which is structurally more expensive per open
payment (roughly one `eth_getBlockByNumber` per block).

## CoinGecko and the COP cross-rate

**COP is not a CoinGecko `vs_currency`** — it returns HTTP 200 with an empty
object rather than an error, which looks like success until you check the body.
The rate service therefore never asks CoinGecko for COP directly: it crosses
asset→USD from CoinGecko with USD→COP from an FX provider
(`open.er-api.com`, falling back to `cdn.jsdelivr.net`). If every provider is
unreachable and no cached rate is fresh enough, quoting is refused rather than
guessed — unless `FALLBACK_USD_COP` is set, which supplies a last-resort rate.
Check `GET /admin/api/diagnostics` → `rates` for the cache state and which
source last answered.

## Seed fingerprint mismatch

`hd_counter.seed_fingerprint` binds the database to one BIP-32 tree. Swapping
`HD_MNEMONIC` without also resetting the database fails **at boot** and at the
next `reserveDerivationIndex` call, rather than quietly continuing the derivation
sequence into addresses the previous seed owns. To rotate intentionally:

- **Production / real value**: provision a fresh database. Addresses already
  handed to payers keep deriving from the old mnemonic either way — that is what
  makes this a decision and not a setting.
- **Testnet only**, where the orphaned addresses hold nothing worth recovering:
  `UPDATE hd_counter SET seed_fingerprint = NULL WHERE id = 1` before the first
  boot on the new seed.

## Missing web build → 503

`/pay/:publicId` and every path under `/admin` return `503 Web UI not built. Run
bun run build:web.` until the SPA exists at `web/dist`. `smoke-test.ts` does not
need this build; `api-test.ts` and `admin-test.ts` assert it directly, so run
`bun run build:web` before either.

## `ADMIN_PASSWORD` and console writes

- **No `ADMIN_PASSWORD` set** — the console runs open for *reads*. Every write
  route (`requireOperator`) refuses with `403 auth_required_for_mutation`: there
  is no operator identity to attribute the change to. This is the expected local
  default; set `ADMIN_PASSWORD` in `.env` to develop the Merchants or Build
  views.
- **Production** — `preflight()` refuses to boot without it at all, since a
  deployed console can never be both unauthenticated for reads and impossible to
  write to safely.
- **A write returns `415 unsupported_media_type`** — the request body was not
  `application/json`. This is deliberate defense-in-depth alongside
  `SameSite=Lax`, not a bug: a cross-site form cannot send that content type.
- **Rotating a credential and an in-flight webhook** — rotating a webhook secret
  re-signs deliveries still queued, since the signer reads the secret at
  delivery time, not at enqueue time. A merchant mid-retry needs the new secret
  immediately, not the one it verified against a minute ago.
