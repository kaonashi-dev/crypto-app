# 0006 — Operator identity and an audit row on every mutation

**Status:** Accepted

## Context

`/admin` is cross-merchant: a signed-in session sees every merchant's payments
and can, once writes exist, create merchants, rotate their credentials, and
issue payments on their behalf. A console that can do all of that with no
record of *who* asked for a given change would make the write surface strictly
worse than not having one — a mutation nobody can be attributed for is not an
efficiency gain, it is a liability with no compensating audit trail.

## Decision

Two mechanisms, both mandatory rather than best-effort:

1. **A named operator, or no write at all.** `requireOperator`
   (`src/api/admin-auth.ts`) refuses every mutation with
   `403 auth_required_for_mutation` when no `ADMIN_PASSWORD` is configured —
   an open console has no account, so it has no identity to attribute a change
   to. It also rejects a non-JSON body, which together with the session
   cookie's `SameSite=Lax` is what keeps the write surface from being
   CSRF-able.
2. **An audit row in the mutation's own transaction.** `recordAudit`
   (`src/services/audit.ts`) inserts into `admin_audit_log` using the caller's
   transaction handle, so a committed change cannot exist without its record.
   `detail` is hand-built per route from an explicit field list — never a
   spread of a database row, which would leak `apiKeyHash`/`webhookSecret` into
   a table nothing ever deletes from — and scrubbed again on the way in.
   `recordDetachedAudit` is the one documented exception, used only where the
   mutation (`createPayment()`) owns its own transaction and threading one
   through would couple a core settlement service to a console concern.

## Consequences

- Every operator-visible change has a "who, what, before/after, when" row,
  joinable to its full request trace via `trace_id` — `/admin/api/logs?q=<trace>`
  expands any audit row into the request that produced it.
- Developing the console's write surface locally requires setting
  `ADMIN_PASSWORD` — there is no way to exercise a mutation without an
  attributable identity, in development or in production.
- The one gap is named rather than hidden: `POST /admin/api/payments`'s audit
  row is written outside the payment's own transaction, so a crash between the
  two can leave a payment that exists with no audit row for it — logged at
  `error` when it happens, and stated explicitly in `recordDetachedAudit`'s own
  docblock.

*Source: `src/api/admin-auth.ts` (`requireOperator`); `src/services/audit.ts`
(module docblock); `docs/design/CONSOLE-WRITE-PLAN.md` §4; `AGENTS.md`.*
