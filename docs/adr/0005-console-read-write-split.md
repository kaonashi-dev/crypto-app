# 0005 — Console read/write router split

**Status:** Accepted

## Context

`/admin` started as a strictly read-only console: every route a `SELECT`, which
made "the console cannot corrupt a payment no matter what it is asked to
render" a true, checkable statement. Adding merchant provisioning and
operator-issued payments (`docs/design/CONSOLE-WRITE-PLAN.md`) introduced the
console's first mutations. Adding `POST`/`PATCH`/`DELETE` handlers directly into
the file that had opened with that promise would make the promise unverifiable
by inspection — a reviewer would have to re-audit the whole file on every future
change instead of trusting its header.

## Decision

Keep two Hono routers mounted at the same `/admin/api` prefix:
`src/api/admin.ts` for every read, whose header still promises every route in
it is a `SELECT`; `src/api/admin-write.ts` for every mutation (merchant CRUD,
credential rotation, operator-issued payments), guarded by its own
`requireOperator` middleware attached per route rather than with a router-wide
`use("*")`. Both mount in `src/api/routes.ts`; a wildcard guard on one file would
otherwise sit in front of the other router's routes too, since Hono matches by
path across both.

## Consequences

- `admin.ts`'s file header stays a checkable claim rather than an aspiration —
  a mutation added "just here" would be a visible violation of the file's own
  stated contract, not a silent one.
- A new mutation always requires deciding where it belongs, which is a small
  but real cost — the split does not remove judgment, it makes the wrong
  judgment visible in review.
- The guard being named on each write route rather than applied once means it
  is impossible to add a mutation that *forgets* `requireOperator` without that
  omission being a one-line diff to spot, at the cost of one repeated import
  per route.

*Source: `src/api/admin.ts:1-24` and `src/api/admin-write.ts:1-27` (module
docblocks); `docs/design/CONSOLE-WRITE-PLAN.md` §2, §6.*
