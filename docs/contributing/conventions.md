# Conventions

Concrete rules a diff is checked against, beyond what a typechecker catches.

## No `console.*` in `src/`

Every module gets a scoped logger from `src/observability`:

```ts
import { getLogger } from "../observability";
const log = getLogger("payments");
log.info("payment created", { "payment.id": p.publicId });
```

This single rule is what makes level control, secret redaction, trace
correlation, the `/admin/api/logs` tail and OTLP export possible at all — a
stray `console.log` bypasses every one of them, including redaction. `scripts/`
is the one exception: standalone scripts print directly, and import
`./quiet` first to keep the service log at `warn` so their `ok/FAIL` lines stay
readable. See [Observability](../architecture/observability.md).

## No bare `useEffect` fetch in `web/src/`

All frontend data access goes through TanStack Query. There is no
`createEffect` that calls `fetch` directly and stashes the result in a signal —
that pattern has no cache, no dedup, and no refetch policy, and this codebase
standardises polling behaviour precisely because both surfaces need different
policies:

- The checkout's status query stops polling itself on a terminal status and
  refetches on window focus (a payer returning from their wallet app should see
  the result of what they just did).
- Every console query takes its interval from `refreshInterval()` in
  `web/src/admin/console.ts`, so the auto-refresh preference lives in one place
  rather than being reimplemented per view.

Console filters belong in the URL via `validateSearch` on the TanStack route, not
in component state — a filtered view is the thing an operator pastes into an
incident thread, and Back should undo a filter the way it undoes a navigation.

## Money is `bigint`, always

- COP has no decimals; crypto amounts are raw smallest-unit integers.
- **Decimals are a property of the (network, asset) pairing, never the
  symbol.** USDC is 6 decimals on Polygon and 18 on BSC. Read decimals from the
  registry (`assetFor`/`tokenFor` in `src/config.ts`) at every point of use;
  never hardcode 6.
- COP→crypto conversion (`copToRaw`) always rounds up — never under-collect.
- API and admin JSON serialize every bigint amount as a **string**. `JSON.stringify`
  throws on a raw bigint; every response builder in `src/api/` goes through an
  `s()` helper that does this conversion explicitly.
- Raw amounts are stored in `numeric(78, 0)` columns, not `bigint` — `int8` tops
  out at ~9.22e18 and an 18-decimal asset passes that at everyday amounts, where
  Postgres raises rather than rounds. See
  [ADR-0001](../adr/0001-numeric-78-as-bigint.md).

## Docblocks

59 of 63 TypeScript files in `src/` open with a rationale header — what the
module is for and why it is shaped the way it is, not a restatement of its
exports. New modules are expected to do the same: a docblock here is load-bearing
documentation, not decoration, and several pages in this docs site (especially
the [ADRs](../adr/index.md)) are mined directly from these headers rather than
re-derived. Write the header before the implementation reads as obvious in
hindsight — that is usually the moment the rationale is clearest.

## Logging attributes, not interpolated strings

```ts
// Wrong: the fact is buried in a string template.
log.info(`payment ${p.publicId} moved to ${status}`);

// Right: body is stable, greppable text; the numbers are attributes.
log.info("payment status changed", {
  "payment.id": p.publicId,
  "payment.status": status,
});
```

Attribute names follow OTel semantic conventions where one exists
(`http.request.method`, `db.system`) and a domain namespace where none does
(`payment.*`, `deposit.*`, `chain.*`, `sweep.*`, `audit.*`). `docs/architecture/observability.md`
is the full reference, including which level a line belongs at and the redaction
rules that make secret-shaped attribute keys and environment-literal values safe
to log at all — a rule that only holds if the fact is an attribute the sink can
inspect, not a string it cannot parse.

## Read/write console split

`src/api/admin.ts` opens by promising every route in it is a `SELECT`; mutations
live only in `src/api/admin-write.ts`, mounted at the same prefix behind its own
`requireOperator` guard. A handler that mutates state does not belong in
`admin.ts` even when the read it pairs with lives there — see
[ADR-0005](../adr/0005-console-read-write-split.md) and
[ADR-0006](../adr/0006-operator-audit-on-mutation.md) for the reasoning, and
[Console](../architecture/console.md) for the full read/write route list.
