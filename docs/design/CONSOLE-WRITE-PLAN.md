# Console Write Plan — payment builder and merchant CRUD

Status: **implemented.** Kept as the design record — the rationale below is why the
code looks the way it does, and §9 lists the documentation this change had to move.
Scope: `/admin` gains its first mutations — a payment request builder and merchant
(client) CRUD — plus one new merchant-API endpoint, `GET /api/payments/:publicId/status`.

**Departures from the plan as written**, all discovered while building:

- **`src/services/merchants.ts` was added** (not in the plan). The key-minting and
  key-hashing functions had to be shared with `src/api/auth.ts`: a drift between the
  hash written at issue time and the one computed at verify time is not a visible bug,
  it is every request from that merchant failing to authenticate for no stated reason.
- **`primeRateCache()` was added to `src/services/rates.ts`.** `POST /admin/api/payments`
  had to be tested through the real `createPayment()` — the point of the route is that it
  is the same code path — but the test scripts must keep running offline, without
  credentials or a provider. Narrow, documented, called from nothing in `src/`.
- **The foreign-key check walks the `cause` chain.** drizzle re-throws the driver error
  wrapped in its own, so the `23503` SQLSTATE is not on the error it hands you. Checking
  only the top level made a correct refusal answer `500` instead of `409`.
- **`requireOperator` is attached per route, not with `use("*")`.** Both routers mount at
  `/admin/api`, and a wildcard middleware matches by path rather than by which router
  answers — so it would have sat in front of the read routes too and refused them
  whenever the console runs open.
- **`SecretReveal` takes a list of credentials**, not one string. Creating a merchant
  returns two, and joining them with a newline rendered them on one line: HTML collapses
  whitespace, so each needs its own labelled row and copy button.
- **The merchant detail panel renders above the list.** Below it, a selection on an
  instance with a few hundred merchants scrolls to somewhere the operator never sees —
  clicking a row appeared to do nothing.

---

## 1. Objective

Give an operator a **Build** section in the console that composes and sends a real
`POST /api/payments` request, shows the response, and polls the resulting payment
through `GET /api/payments/:publicId/status`; and a **Merchants** section that
creates, edits, rotates credentials for, deactivates and (when unused) deletes the
rows in `clients`.

Today both jobs require a shell: `bun run scripts/seed.ts` for a merchant,
`bun run scripts/create-payment.ts` for a payment. Neither is reachable on a Railway
deployment, and `seed.ts` prints the API key but never the webhook secret — so a
merchant provisioned by this repo has **no way to learn the secret its webhook
signatures are computed with**. That gap is closed here.

### 1.1 Non-objectives

- **Operator (`admin_users`) CRUD.** The audit model built in Phase 0 is its
  precondition, but creating accounts from a browser is a separate change.
- **Balance adjustments, refunds, resolving `underpaid_expired`.** These mutate
  money, not configuration. They need a reversal model, not just an audit row.
- **Re-queueing dead webhooks**, and **manual sweeps** (`SWEEPING-PLAN.md` §2.2).
  Both become *possible* once Phase 0 lands; neither is in scope.
- **Deleting or editing a payment.** A payment is ledger state. The console may
  create one; it may never remove one.

---

## 2. The blocker: `/admin` is read-only by invariant

Four places in this repository state it, and all four are load-bearing:

| Where | What it says |
|---|---|
| `AGENTS.md` §Architecture | "do not add console-driven user management **or any other mutation** without an audit model to go with it" |
| `src/api/admin.ts` header | "Every route is a SELECT. Nothing here mutates the payment state machine" |
| `docs/design/SWEEPING-PLAN.md` §2.2, §13.1 | manual sweeps deferred "until an audit model exists" |
| `README.md` *Pending for production* | operator management and `underpaid_expired` resolution "wait on the audit model below" |

So the audit model is not a nice-to-have bolted onto this feature — it is the thing
that unblocks it, and it ships first.

---

## 3. Constraints this design is shaped by

| Constraint (source) | Effect |
|---|---|
| `src/config.ts` is authoritative for networks/assets (`AGENTS.md`) | The builder's asset and network pickers are derived from `GET /admin/api/stats` → `networks[]` filtered on `offered`. No hardcoded lists in the SPA. |
| Decimals are a property of the (network, asset) pair, never the symbol | The builder never formats an amount from a symbol; it reads `decimals` off the response. |
| Money is `bigint`; API JSON serializes amounts as strings | Every new response field goes through the existing `s()` helper or `.toString()`. |
| Nothing in `src/` calls `console` directly (`AGENTS.md`) | Audit writes emit a scoped-logger record with `audit.*` attributes as well as the row. |
| Redaction happens at the sink, but do not paste secrets into message bodies | An API key is returned in exactly one HTTP response and written to *nothing* — not the audit `detail`, not a log attribute. Hash prefix only, matching `src/api/auth.ts`. |
| Frontend data access is TanStack Query, never a bare `useEffect` (`AGENTS.md`) | Mutations are `useMutation` + `queryClient.invalidateQueries`. |
| `bun run typecheck:web` rejects unused symbols | Every helper added to `ui.tsx` must actually be used. |
| Schema changes start in `src/db/schema.ts`, migration generated and committed | Phase 0 produces `drizzle/0005_*.sql` via `bun run db:generate`. |

---

## 4. Phase 0 — the audit model

### 4.1 Table (`src/db/schema.ts`)

```ts
export const adminAuditLog = pgTable("admin_audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Set null on operator delete rather than cascade: removing an account must
  // never remove the record of what it did.
  operatorId: uuid("operator_id").references(() => adminUsers.id, { onDelete: "set null" }),
  // Snapshotted, so the trail stays readable after a rename or a deletion.
  operatorUsername: text("operator_username").notNull(),
  action: text("action").notNull(),       // 'merchant.create' | 'merchant.update' | …
  targetType: text("target_type").notNull(),
  targetId: text("target_id"),
  detail: text("detail"),                 // JSON: hand-built allow-list, never a spread row
  outcome: text("outcome").notNull(),     // 'ok' | 'denied' | 'error'
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  traceId: text("trace_id"),              // joins this row to /admin/api/logs
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("admin_audit_created_idx").on(t.createdAt),
  index("admin_audit_target_idx").on(t.targetType, t.targetId),
  index("admin_audit_operator_idx").on(t.operatorId),
]);
```

Actions: `merchant.create`, `merchant.update`, `merchant.deactivate`,
`merchant.delete`, `merchant.api_key.rotate`, `merchant.webhook_secret.rotate`,
`payment.create`.

### 4.2 Invariants

1. **Append-only.** No route updates or deletes a row. Enforced by there being no
   such handler, and stated in the file header so a later one is a visible choice.
2. **Same transaction as the mutation.** `recordAudit(tx, …)` takes the caller's
   transaction handle. An audit row that can be absent while the mutation
   succeeded is not an audit trail.
3. **`detail` is hand-built per route** from an explicit field list. Never
   `{...row}` — a `clients` row carries `apiKeyHash` and `webhookSecret`.
4. **No secret is ever written.** Keys and webhook secrets appear in one HTTP
   response body and nowhere else. Logs get `client.api_key_hash_prefix` (first 12
   hex chars), the same handle `src/api/auth.ts` already logs on a rejected key.
5. **`traceId`** comes from the observability context, so any audited action can be
   expanded into its full request trace in the existing `/admin/api/logs` tail.

### 4.3 Service (`src/services/audit.ts`)

`recordAudit(tx, entry)` inserts the row and emits
`log.info("console mutation", { "audit.action": …, "audit.target_type": …, "operator.id": … })`.
`auditTrail({ action?, targetType?, targetId?, limit, offset })` reads it back.

New attribute namespace `audit.*` — add it to `docs/architecture/observability.md` alongside the
existing ones.

### 4.4 Mutation guard (`src/api/admin-auth.ts`, exported)

`requireOperator` sits in front of every write route and does two things:

- **Refuses when the console is running open.** With no `ADMIN_PASSWORD` there is
  no identity, so a mutation cannot be attributed, so it is not permitted:
  `403 { error: "auth_required_for_mutation" }` with a hint naming the variable.
  Reads stay open in development exactly as they are today. Production can never
  reach this branch — `preflight()` already refuses to boot without the variable.
  **Consequence: developing this feature locally requires setting `ADMIN_PASSWORD`
  in `.env`.** That is the intended trade; an unattributable write is worse.
- **Requires `Content-Type: application/json`** on any request with a body,
  answering `415` otherwise. The session cookie is `SameSite=Lax`, which already
  keeps it off cross-site POSTs, and a cross-site HTML form cannot send that
  content type — so the two together preserve the "no CSRF-able state change"
  property that `admin-auth.ts` currently claims in its header. That header comment
  is amended to describe the guard rather than the absence of writes.

---

## 5. Phase 1 — `GET /api/payments/:publicId/status`

Merchant API, `apiKeyAuth`, scoped to the caller's own payments (404 otherwise —
same shape as the existing detail route, so it is not an existence oracle).

```
GET /api/payments/a7k2m9x3wq5tzn/status
X-Api-Key: gk_test_…

200
{
  "id": "a7k2m9x3wq5tzn",
  "status": "partially_paid",
  "terminal": false,
  "asset": "USDC",
  "network": "base-sepolia",
  "decimals": 6,
  "amount_cop": "50000",
  "amount_crypto_raw": "12500000",
  "confirmed_raw": "4000000",
  "pending_raw": "2000000",
  "overpaid_raw": "0",
  "quote_expires_at": "2026-07-28T…",
  "grace_expires_at": "2026-07-28T…",
  "paid_at": null
}
```

Notes:

- **`/:publicId/status`, not `/payments/status`.** A static `/payments/status`
  segment registered after `/payments/:publicId` would be swallowed by the param
  route — Hono matches in registration order. The nested form has no such hazard.
- `decimals` comes from `assetFor(network, asset)`, never from the symbol.
- `terminal` is derived (`paid` / `expired` / `underpaid_expired`) so a poller can
  stop without hardcoding the enum.
- **`publicPaymentView()` is not touched.** It is also the webhook payload shape;
  editing it would silently change a contract merchants verify signatures over.
- Logged at `debug`, like every other polling path in `routes.ts`.

### 5.1 Shared contract module (`src/api/http.ts`)

`publicOrigin()` and the `createSchema` zod object currently live inside
`routes.ts` and are not exported. Phase 2 needs both. They move to a new
`src/api/http.ts` (exported as `publicOrigin` and `createPaymentSchema`), imported
by both `routes.ts` and the write router — a shared import rather than
`admin-write.ts → routes.ts`, which would be a cycle. The point is that the two
creation paths cannot drift apart in what they accept or what URL they hand back.

---

## 6. Phase 2 — console write API (`src/api/admin-write.ts`)

A **new file**, not an addition to `admin.ts`. That file's header promises every
route in it is a SELECT, and that promise is worth more than co-location. Mounted
alongside it in `routes.ts`, already inside the session guard:

```ts
app.route("/admin/api", adminApi);       // reads  (unchanged, still all SELECT)
app.route("/admin/api", adminWriteApi);  // writes (requireOperator + audit)
```

| Method | Path | Effect |
|---|---|---|
| `POST` | `/admin/api/payments` | Create a payment acting as a merchant |
| `POST` | `/admin/api/clients` | Create a merchant; returns key + secret **once** |
| `PATCH` | `/admin/api/clients/:id` | `name`, `webhook_url`, `is_active` |
| `POST` | `/admin/api/clients/:id/api-key` | Rotate; returns the new key **once** |
| `POST` | `/admin/api/clients/:id/webhook-secret` | Rotate; returns it **once** |
| `DELETE` | `/admin/api/clients/:id` | Deactivate, or hard-delete when unreferenced |

Two reads join the existing `admin.ts`: `GET /admin/api/clients/:id` (merchant
detail — counts, balance, `api_key_hash_prefix`, never the secret) and
`GET /admin/api/audit` (the trail, filterable and paginated).

### 6.1 `POST /admin/api/payments`

Body is `createPaymentSchema` plus `client_id`. Resolves the merchant, refuses an
inactive one (`409` — a deactivated merchant should not receive new orders), calls
`createPayment()` from `services/payments.ts` **unchanged**, records the audit row,
and returns `{ ...publicPaymentView(p), checkout_url }` — byte-identical in shape to
`POST /api/payments`, so the console renders one response panel for both modes.

Two consequences to state rather than discover:

- This is the first `/admin/api/*` route that **reaches a paid provider** —
  `createPayment` calls `getRateCopE6`, which is CoinGecko behind a cache. The
  README's claim that nothing in the console does so is amended.
- Each created payment **permanently consumes an HD derivation index**, and there
  is no delete. Misclicking the button costs an index, not money.

### 6.2 Merchant create and credential rotation

Key generation mirrors `scripts/seed.ts`: `gk_` + `test`/`live` (on `env.isProduction`)
+ `_` + 24 random bytes hex; stored as SHA-256 in `apiKeyHash`. Webhook secret is
`whsec_` + 24 random bytes hex, stored as-is because HMAC signing needs the plaintext.

Both are returned **only** in the response to the call that generated them. The
merchant detail read exposes `api_key_hash_prefix` and nothing else. Rotation is
immediate with no grace window — the previous key stops authenticating on the next
request. A dual-key overlap is the obvious follow-up and is not built here.

**Rotating a webhook secret re-signs already-queued jobs.** `deliverPendingWebhooks`
joins `clients` and reads the secret at delivery time, so undelivered jobs are signed
with the *new* secret. The console must say so at the point of rotation; the
alternative (snapshotting the secret onto `webhook_jobs`) is a schema change and is
out of scope.

**Deactivating is not freezing.** `is_active: false` makes `apiKeyAuth` reject the
merchant's calls, and it does *not* stop the watchers from settling payments already
on-chain or from crediting `balance_cop`. Settlement is driven by Transfer logs, not
by merchant state. The UI states this next to the toggle.

### 6.3 Delete semantics

`DELETE` deactivates. `DELETE ?hard=true` attempts a real delete, which is permitted
only for a merchant with no `payments`, `ledger_entries` or `webhook_jobs` — the
mistyped-name case.

The counts are read for the confirmation dialog, but the **guarantee is the foreign
key**: the delete runs inside a transaction and a `23503` violation is translated to
`409 { error: "merchant_in_use", counts: {…} }`. Counting alone races against a
watcher inserting a deposit mid-request.

### 6.4 Validation, and one new attack surface

`name` 1–120 chars trimmed. `webhook_url` must be an absolute `http(s)` URL or null.

Setting a webhook URL from a browser is **new SSRF reach**: `deliverPendingWebhooks`
POSTs merchant-controlled JSON to whatever host is stored, and until now only a shell
script could set it. Recommended guard, in the validator:

- require `https` when `env.isProduction`;
- reject hosts resolving to loopback, link-local (`169.254.0.0/16` — cloud instance
  metadata), and RFC-1918 ranges, with an env escape hatch for local development
  against `http://localhost:…`.

If that is judged too strict for the operator model, the decision should be recorded
explicitly rather than left as an unnoticed consequence of adding a text field.

---

## 7. Phase 3 — console UI

Two new routes in `web/src/router.tsx`, two new nav entries.

**Gotcha:** `AdminLayout.tsx` computes the Payments tab as
`!onDeposits() && !onSweeps() && !onUsers()`. Adding routes without extending that
expression leaves Payments highlighted on the new pages.

### 7.1 `/admin/build` — "Build"

`web/src/admin/BuildRoute.tsx`.

```
┌ Request ─────────────────────────────┐ ┌ Response ──────────────────┐
│ Merchant   ▾ Cliente Demo            │ │ 201 Created   x-trace-id … │
│ Amount COP [ 50000 ]  Asset ▾ USDC   │ │ {                          │
│ Network    ▾ base-sepolia            │ │   "id": "a7k2m9x3wq5tzn",  │
│ Metadata   { "order_id": "ORD-1" }   │ │   "address": "0x…",        │
│                                      │ │   "amount_crypto_raw": …   │
│ Send as  (•) operator  ( ) API key   │ │ }                          │
│                                      │ │                            │
│ POST /api/payments                   │ │ → open /admin/p/a7k2m…     │
│ X-Api-Key: gk_test_••••••  [change]  │ │ → checkout /pay/a7k2m…     │
│ { "amount_cop": 50000, … }           │ │                            │
│                        [copy as curl]│ │ Status  [ poll ]  pending  │
│              [ Send request ]        │ │ GET /api/payments/…/status │
└──────────────────────────────────────┘ └────────────────────────────┘
```

- **Two send modes.** *API key* posts from the browser straight to `/api/payments`
  with `X-Api-Key` — the genuine documented integration path, same origin, and the
  console's `Path=/admin` cookie is not attached, so there is no ambient authority
  in the call. *Operator* posts to `/admin/api/payments` with the session cookie, for
  the common case where the merchant's key is not recoverable (it is shown once).
  A merchant just created in the Merchants view arrives here with its key in hand.
- **Key handling** (`web/src/admin/credentials.ts`): `sessionStorage`, keyed by
  merchant id, displayed masked, with an explicit **Forget key** control, cleared on
  sign-out (extend `signOut` in `AdminLayout`, which already calls
  `queryClient.clear()`). Never `localStorage`. The panel says plainly that pasting a
  key into a browser is a choice being made.
- **Asset/network options** come from the `stats` query's `networks[]`, filtered on
  `offered`, with `tokens[] + native` per network — so the picker cannot offer a pair
  `createPayment` will reject.
- The request preview is the teaching surface: it is the real request, copyable as
  `curl`, which makes this section double as integration documentation.
- **Status strip** calls `GET /api/payments/:publicId/status` on the created payment,
  through the same mode toggle, stopping on `terminal` — mirroring how the checkout's
  own status query stops itself.

### 7.2 `/admin/merchants` — "Merchants"

`web/src/admin/MerchantsRoute.tsx`. Table over the existing `GET /admin/api/clients`
(name, id, balance, payments count, webhook URL, active), row opens a detail panel:

- edit `name` / `webhook_url` / `is_active`;
- **Rotate API key** and **Rotate webhook secret**, each behind an inline confirm
  that states the blast radius (immediate invalidation; re-signed pending jobs);
- **Delete**, showing the reference counts, offering deactivate when hard delete is
  refused;
- a **one-time credential panel** — full value, copy button, an explicit "this is
  shown once and is not recoverable" line, dismissed by hand rather than on
  navigation;
- recent audit entries for that merchant, from `GET /admin/api/audit`.

No `window.confirm()` anywhere — a modal dialog blocks the page, and the console
already avoids them.

### 7.3 Shared pieces

`web/src/admin/api.ts` gains `post`/`patch`/`del` beside `get` (each routing 401
through the existing `noteUnauthorized`, so session expiry keeps being handled in one
place), the merchant-API caller, and wire types. `ui.tsx` gains `TextInput`,
`TextArea`, `Button` (default/danger), `Callout` and `InlineConfirm`, all built from
the existing `CONTROL` class and the palette tokens in `web/src/index.css` — no new
colours, and status marks keep coming from `lib/status.ts`.

---

## 8. Verification

`bun run typecheck` · `bun run typecheck:web` · `bun run build:web` before the HTTP
scripts. New cases extend `scripts/admin-test.ts` (which already has the `signIn()`
cookie helper) and `scripts/api-test.ts`:

1. `/api/payments/:id/status`: 200 for own payment, 404 for another merchant's, 401
   with no key, and every amount is a JSON **string**.
2. Every write route: 401 with no cookie; 415 with `Content-Type: text/plain`.
3. Write routes answer 403 when `ADMIN_PASSWORD` is unset (run the script once
   without it).
4. `POST /admin/api/clients` → 201; SHA-256 of the returned key equals the stored
   `api_key_hash`; no later read returns it.
5. The new key authenticates `GET /api/me`.
6. `PATCH` writes an audit row whose `detail` carries before/after.
7. Rotate → old key 401, new key 200.
8. `DELETE` on a merchant with payments → 409 with counts; on a fresh one → gone.
9. `POST /admin/api/payments` → 201, appears in `GET /admin/api/payments`, audit row
   present, and 409 for an inactive merchant.
10. **No secret leaks:** the plaintext key returned in (4) is not a substring of any
    row in `admin_audit_log`, nor of any record in the `/admin/api/logs` tail.

Tests append rows and do not clean up (`AGENTS.md`) — a disposable development
database, as always.

---

## 9. Documentation that goes stale and must move with the code

- `AGENTS.md` — the `/admin` bullet: read-only becomes *read-mostly; mutations
  require an authenticated operator and write an `admin_audit_log` row*.
- `README.md` — the console section says "Four views", "read-only", and "None of this
  reaches a paid provider"; all three change. Move operator management and
  `underpaid_expired` off *Pending for production*'s blocked-on-audit list, since the
  blocker is gone even though the work is not done.
- `src/api/admin-auth.ts` header — the CSRF note now describes the guard.
- `web/src/admin/AdminLayout.tsx` footer and `UsersRoute.tsx` footer — both currently
  tell the reader the console cannot mutate anything.
- `docs/architecture/observability.md` — the `audit.*` namespace.
- `docs/design/SWEEPING-PLAN.md` §2.2 / §13.1 — a manual sweep stays out of scope, but its
  stated reason ("until an audit model exists") is no longer the reason.
- `.env.example` — a line noting `ADMIN_PASSWORD` is now required for console writes
  in development too.

---

## 10. Order of work

| # | Deliverable | Verified by |
|---|---|---|
| 0 | `admin_audit_log` + `recordAudit` + `requireOperator`, `bun run db:generate` → `drizzle/0005_*` committed | typecheck; migration applies |
| 1 | `src/api/http.ts` extraction; `GET /api/payments/:publicId/status` | `api-test.ts` cases 1 |
| 2 | `admin-write.ts`: merchant CRUD + rotation + delete; `GET /admin/api/clients/:id`, `GET /admin/api/audit` | `admin-test.ts` cases 2–8, 10 |
| 3 | `POST /admin/api/payments` | `admin-test.ts` case 9 |
| 4 | `/admin/merchants` view | `typecheck:web`, manual |
| 5 | `/admin/build` view | `typecheck:web`, manual |
| 6 | Documentation sweep (§9) | read-through |

Phases 0–3 are backend and independently shippable; 4–5 are the SPA; 6 is not
optional, because this repository treats `AGENTS.md` and `README.md` as sources of
truth and both currently assert the opposite of what will be true.
