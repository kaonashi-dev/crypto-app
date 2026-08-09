# Errors

Every error body has the shape `{ "error": "<code>" }`, sometimes with a
`details` field. There is no envelope beyond that — the top-level JSON object
*is* the error. A `500` additionally carries `trace_id`, matching the
`x-trace-id` response header, so a failure is findable in
`GET /admin/api/logs`.

## 400 — Bad request

| `error` | Where | `details` |
|---|---|---|
| `bad_request` | `POST /api/payments`, `POST /admin/api/payments`, `POST /admin/api/clients`, `PATCH /admin/api/clients/:id` | `"invalid JSON body"`, or the Zod issue array from a schema failure, or a webhook-URL policy string (e.g. `"webhook_url must be https:// in production"`) |
| `cannot_create_payment` | `POST /api/payments`, `POST /admin/api/payments` | `createPayment`'s rejection message — `"Unsupported asset/network combination"` or `"Minimum amount: 1,000 COP"` |

## 401 — Unauthorized / unauthenticated

| `error` | Where | Meaning |
|---|---|---|
| `missing_api_key` | any `/api/*` route | no `X-Api-Key` header |
| `invalid_api_key` | any `/api/*` route | key not recognised, or belongs to a deactivated merchant (both answers are identical on purpose) |
| `unauthenticated` | any `/admin/api/*` route | no live console session (only reachable when `ADMIN_PASSWORD` is set) |
| `invalid_credentials` | `POST /admin/api/auth/login` | unknown operator, wrong password, or deactivated (the response never says which) |

## 403 — Forbidden

| `error` | Where | Meaning |
|---|---|---|
| `auth_required_for_mutation` | any console write route | the console is running open (no `ADMIN_PASSWORD`) — a change nobody can be attributed to is refused, not just unauthenticated |

## 404 — Not found

`{ "error": "not_found" }`, uniformly, for:

- an unknown route (Hono's `app.notFound`)
- a `publicId` that doesn't exist, on any payment-lookup route
- a merchant-scoped lookup (`/api/payments/:publicId[/status]`) for a
  `publicId` that exists but belongs to a different client — deliberately the
  same answer as "doesn't exist", so the endpoint can't be used to enumerate
  other merchants' ids
- a missing `client_id` on console client/payment routes

## 409 — Conflict

| `error` | Where | `details` |
|---|---|---|
| `auth_disabled` | `POST /admin/api/auth/login` | no `ADMIN_PASSWORD` — there is no account to sign in to |
| `merchant_inactive` | `POST /admin/api/payments` | the target merchant is deactivated |
| `merchant_in_use` | `DELETE /admin/api/clients/:id?hard=true` | `"Deactivate it instead — deleting would remove settlement history."`, plus a `counts` object (`payments`, `ledger_entries`, `webhook_jobs`) |

## 415 — Unsupported media type

`{ "error": "unsupported_media_type" }` — a console write's body was not
`Content-Type: application/json`.

## 429 — Too many requests

`{ "error": "too_many_attempts", "retry_after_s": N }` — console login
throttled per (IP, username) and per IP, after 10 failures in 15 minutes. The
response also sets a `Retry-After` header.

## 500 — Internal error

`{ "error": "internal_error", "trace_id": "..." }` — anything unhandled.
Logged with the full exception; the body deliberately carries nothing else
that could leak internals.

## What is *not* an error

`GET /health` never fails on a database problem — it reports only that the
process is serving. `POST /public/payments/:publicId/check` never surfaces a
scan failure as an HTTP error: if the on-demand chain read throws, the
response still returns the current stored status with `"checked": false`.
