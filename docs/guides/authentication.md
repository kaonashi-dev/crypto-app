# Authentication

## Merchant API: `X-Api-Key`

Every route under `/api/*` requires an `X-Api-Key` header (`src/api/auth.ts`):

```bash
curl -s http://localhost:3000/api/me -H "X-Api-Key: gk_test_..."
```

| Failure | Status | Body |
|---|---|---|
| Header missing | 401 | `{"error":"missing_api_key"}` |
| Key not recognised | 401 | `{"error":"invalid_api_key"}` |
| Key belongs to a deactivated merchant | 401 | `{"error":"invalid_api_key"}` |

The gateway stores only a SHA-256 hash of the key (`clients.api_key_hash`); a
presented key is hashed the same way and matched against it. A rejection is
logged with the *reason* (missing/unknown/deactivated) and the hash prefix —
never the key itself.

## Key format

Minted keys look like `gk_test_<48 hex chars>` or `gk_live_<48 hex chars>`
(`newApiKey()` in `src/services/merchants.ts`): the `test`/`live` marker
follows `NODE_ENV`, so a key pasted into the wrong environment is recognisable
before it is used. Webhook signing secrets look like `whsec_<48 hex chars>`.

## One-time plaintext exposure

An API key or webhook secret is returned in exactly **one** HTTP response —
the call that mints or rotates it — and stored nowhere in plaintext:

| Call | Returns |
|---|---|
| `bun run seed` | `api_key`, `webhook_secret` (printed to the console, once) |
| `POST /admin/api/clients` | `api_key`, `webhook_secret` |
| `POST /admin/api/clients/:id/api-key` | `api_key` (rotated) |
| `POST /admin/api/clients/:id/webhook-secret` | `webhook_secret` (rotated) |

Every other read — including `GET /admin/api/clients/:id` — exposes only
`api_key_hash_prefix`, the first 12 hex characters of the hash. It is enough
to match a rejected key in the log tail to the merchant it belongs to; it is
not usable to authenticate.

If a key or secret is lost, it is **rotated**, not recovered.

## Rotating credentials

Rotation happens through the `/admin` console (an operator session — see
[Console API](/api/console)), and is immediate with no overlap window: the
previous value stops working on the very next request.

- `POST /admin/api/clients/:id/api-key` — new API key; the old one stops authenticating at once.
- `POST /admin/api/clients/:id/webhook-secret` — new signing secret; it also
  re-signs any webhook deliveries still queued, since the signer reads the
  secret at delivery time, not at enqueue time.

Both require a signed-in operator and write an `admin_audit_log` row in the
same transaction (see [Console API](/api/console)).

## Console sign-in is separate

The `/admin` backoffice does not use `X-Api-Key` at all — it is a named
operator session with a cookie. See [Console API](/api/console) for
`POST /admin/api/auth/login` and the session guard.
