# Console API

The `/admin/api/*` surface behind the `/admin` backoffice. Cross-merchant by
design — an operator who signs in sees every merchant's payments plus
internals the merchant API hides (derivation index, frozen rate, webhook
delivery attempts, ledger entries). There is no per-merchant scoping.

Reads and writes are two routers at one prefix, and the split is a documented
promise: every route in `src/api/admin.ts` is a plain `SELECT` — nothing
there can mutate a payment no matter what it's asked to render. The write
surface (merchant CRUD, credential rotation, operator-issued payments) lives
in `src/api/admin-write.ts` behind its own additional guard.

## Session authentication

Sign-in is a named operator against `admin_users`, not `X-Api-Key`. A
successful login sets an `HttpOnly`, `SameSite=Lax` cookie
(`gw_console_session`) scoped to `Path=/admin`, `Secure` whenever the request
arrived over TLS. `adminSessionGuard` covers every route below except
`POST /admin/api/auth/login`.

**Console running open.** With no `ADMIN_PASSWORD` set, no operator account
exists and every read route answers without a session — this is local
development only; a production boot refuses to start without the variable
(`preflight()` in `src/config.ts`). Writes are refused regardless (see
below).

### Auth routes (3)

| Method | Path | Notes |
|---|---|---|
| `POST` | `/admin/api/auth/login` | `{ username, password }` → sets the session cookie. Throttled per (IP, username) and per IP (10 failures / 15 min). |
| `POST` | `/admin/api/auth/logout` | Deletes the session row; always attributable, so it's guarded like the rest. |
| `GET` | `/admin/api/auth/me` | The console's first call: `401` here is the signal to render the login screen. |

`POST /admin/api/auth/login` responses:

- `200` — `{ "user": { "id", "username", "is_active", "last_login_at", "created_at" }, "session_expires_at" }`
- `401 { "error": "invalid_credentials" }` — unknown operator, wrong password, or deactivated (the *reason* is only in the log, not the response)
- `409 { "error": "auth_disabled" }` — no `ADMIN_PASSWORD`, so there's no account to sign in to
- `429 { "error": "too_many_attempts", "retry_after_s": N }` — throttled (also sets `Retry-After`)

`GET /admin/api/auth/me` responses:

```json
{ "authenticated": true, "mode": "session", "user": { "id": "...", "username": "samuel" }, "session_ttl_hours": 12 }
```

`mode` is `"open"` when the console has no `ADMIN_PASSWORD` configured
(`user` is then `null`).

## Read routes (12) — `src/api/admin.ts`

All plain SELECTs; none consume a provider call except `/wallets`.

| Method | Path | Returns |
|---|---|---|
| `GET` | `/admin/api/stats` | Header readout: payment counts by status/network, deposit and webhook queue health, sweep counts, live business parameters (quote/grace TTL, spread, dust bps), and per-network metadata |
| `GET` | `/admin/api/clients` | Every merchant: balance, webhook URL, active flag, payment count |
| `GET` | `/admin/api/clients/:id` | One merchant: payment mix by status, ledger totals, webhook totals, reference counts, `deletable`, `api_key_hash_prefix`, recent audit rows |
| `GET` | `/admin/api/audit` | The console's own change trail — filters: `action`, `target_type`, `target_id`, `operator_id`, `limit`, `offset` |
| `GET` | `/admin/api/payments` | Payment list — filters: `status`, `network`, `asset`, `client_id`, `q` (public id / address / metadata / tx hash), `limit`, `offset` |
| `GET` | `/admin/api/payments/:publicId` | One payment plus its deposits, webhook attempts, and ledger entries |
| `GET` | `/admin/api/users` | Console operators: last sign-in, active session counts |
| `GET` | `/admin/api/logs` | The process's own in-memory log tail — filters: `level`, `scope`, `q`, `since`, `limit` |
| `GET` | `/admin/api/diagnostics` | Running config (`configSummary()`), process stats, per-network enabled/credential state, logging/OTLP status, rate cache, metrics snapshot |
| `GET` | `/admin/api/wallets` | The gateway's own wallet balances, read live from each chain (cached 30s server-side) — the only console read that is not a database query |
| `GET` | `/admin/api/sweeps` | Consolidation attempts, newest first — filters: `network`, `status`, `asset`, `q` |
| `GET` | `/admin/api/deposits` | Flat feed of every recorded on-chain transfer — filters: `network`, `confirmed`, `q` |

## Write routes (6) — `src/api/admin-write.ts`

Every write requires a signed-in operator (`requireOperator`) and a JSON
body, and writes an `admin_audit_log` row **inside the same transaction** as
the change.

| Method | Path | Notes |
|---|---|---|
| `POST` | `/admin/api/clients` | Creates a merchant. `{ name, webhook_url? }` → `201` with `{ client, api_key, webhook_secret }` — the only response that ever carries those two values for this merchant |
| `PATCH` | `/admin/api/clients/:id` | `{ name?, webhook_url?, is_active? }` — `webhook_url: null` clears it; at least one field required |
| `POST` | `/admin/api/clients/:id/api-key` | Rotates the API key. `200` with `{ client, api_key }`. The previous key stops authenticating immediately — no overlap window |
| `POST` | `/admin/api/clients/:id/webhook-secret` | Rotates the signing secret. `200` with `{ client, webhook_secret }`. Re-signs deliveries still queued, since the signer reads the secret at delivery time |
| `DELETE` | `/admin/api/clients/:id` | Deactivates by default (`{ client, deleted: false }`); with `?hard=true` and nothing referencing it, deletes outright (`{ deleted: true, id }`) — `409 merchant_in_use` with reference counts otherwise |
| `POST` | `/admin/api/payments` | Creates a payment for `client_id` via the same `createPayment()` the merchant API uses. Body is `createPaymentSchema` (see [Merchant API](/api/merchant)) plus `client_id` (uuid). Consumes an HD derivation index permanently — a misclick costs an index, not money |

**Why a write can be refused before it even reaches its own logic:**

- `403 { "error": "auth_required_for_mutation", "details": "..." }` — the
  console is running open (no `ADMIN_PASSWORD`); an unattributable mutation is
  refused outright.
- `415 { "error": "unsupported_media_type" }` — the request body isn't
  `application/json`. Combined with the cookie's `SameSite=Lax`, this is what
  keeps console mutations from being CSRF-able.

Both are on `requireOperator`, so they apply to all six routes above.

`POST /admin/api/payments` also answers `404 { "error": "not_found" }` (no
such merchant) and `409 { "error": "merchant_inactive" }` (the merchant is
deactivated) before it ever calls `createPayment`.

## Errors

Full status-code reference across the whole API, console included:
[Errors](/api/errors).
