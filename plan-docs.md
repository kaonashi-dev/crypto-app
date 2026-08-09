# Documentation plan — crypto-gateway

> Executed. The VitePress site under `docs/`, the README/AGENTS demotion, and the
> drift fixes land with this plan; verification gates are in the closing section.

## Context

`crypto-app` (package `crypto-gateway`) is a single-package Bun/TypeScript crypto payment
gateway: a Hono API plus in-process chain workers in `src/`, a SolidJS SPA in `web/` that
serves both the payer checkout and the operator console, Postgres via Drizzle, and no CI,
no test runner, and no docs tooling.

The documentation today is **7 markdown files, ~2,650 lines**, and it has drifted. `README.md`
(654 lines) is doing the job of a manual, an API reference, a deploy guide and a roadmap at
once — and it now contradicts the code in at least six places. The two most recent features
(treasury sweeping, console writes) landed with design documents but no reference
documentation: **`README.md` and `AGENTS.md` contain zero mention of sweeping**, while
`README.md:542` still asserts *"Funds accumulate at per-payment HD addresses. Nothing here
moves them"* — false since commit `0ff2466`. There is also a link to `docs/HTTPIE.md`, a file
that has never existed.

The outcome we want: a single **VitePress** documentation site sourced from `docs/`, with two
clearly separated tracks — an **integration guide + API reference** for merchants, and an
**architecture/operations** set for contributors and operators — with the confirmed drift
fixed and `README.md`/`AGENTS.md` demoted to short, accurate entry points.

Decisions already taken (confirmed with the user): audience = both integrators and
internal; language = **English** throughout; format = **static docs site**; approach =
**restructure and fix drift**, not additive-only.

---

## Tooling: VitePress, installed in isolation

**Why VitePress over Docusaurus/Starlight:** `srcDir` can point straight at `docs/`, so pages
stay ordinary markdown at ordinary paths. That matters concretely — **16 source-code comments
reference doc paths by name** (`src/services/sweeper.ts:4` cites "§6 and §7 of
docs/SWEEPING-PLAN.md", `src/db/schema.ts:219`, `src/config.ts:394`, `scripts/sweep-probe.ts:2`,
`src/observability/index.ts:12`, …). Starlight would force everything under
`src/content/docs/`; Docusaurus drags in React alongside the app's Solid.

**Install it in an isolated `docs/package.json`,** not the root manifest. The app is on
bleeding-edge `vite@^8.1.5` and `typescript@^7.0.2`; VitePress pins its own Vite and a peer
conflict must not be able to break `bun run build:web`. A nested manifest is inert in this repo
(no workspaces), and `.dockerignore` already excludes `docs/`. If VitePress turns out to install
cleanly against the root tree, collapsing it into the root manifest later is a one-line change.

```
docs/package.json      { "scripts": { "dev": "vitepress dev", "build": "vitepress build" } }
                       deps: vitepress, mermaid, vitepress-plugin-mermaid
docs/.vitepress/config.ts   srcDir ".", per-section sidebars, local (minisearch) search,
                            mermaid plugin, ignoreDeadLinks: false
```

Root `package.json` gets two pass-through scripts only: `docs:dev` and `docs:build`
(`cd docs && bun run dev|build`). Add `docs/node_modules/`, `docs/.vitepress/cache/`,
`docs/.vitepress/dist/` to `.gitignore`.

Root `tsconfig.json` needs no change — `include` is already `["src","scripts","drizzle.config.ts"]`,
so `bun run typecheck` will not see the VitePress config.

**Not deployed publicly in this plan.** The site is `bun run docs:dev` locally and a build
artifact. The operations track names env vars and describes internals; publishing it is a
separate decision. Leave a `docs/.vitepress/config.ts` `base` comment noting what to set for
GitHub Pages later.

Diagrams are Mermaid in fenced blocks — they render in the site *and* on GitHub, so the raw
files stay useful.

---

## Target structure

`docs/` becomes the site root. **Bold = new prose.** Everything else is a move or an adaptation
of text that already exists in `README.md` / the design docs / module docblocks.

```
docs/
  index.md                     ** home: what this is, two entry paths, network matrix at a glance
  guides/                      — INTEGRATOR TRACK
    quickstart.md              ** the missing docs/HTTPIE.md: key → payment → pay → webhook, runnable
    authentication.md          ** X-Api-Key, gk_test_/gk_live_, one-time exposure, rotation
    payments.md                   from README "API" + createPaymentSchema
    checkout.md                ** hosted checkout, EIP-681 QR, POST /check, quote vs grace window
    webhooks.md                   from README "Webhooks" + ** signature-verification snippets
    networks-and-assets.md        from README matrix + ** decimals-per-pairing, native-vs-token
    testing.md                 ** faucets, scripts/wallets.ts, scripts/create-payment.ts, Postman
  api/                         — REFERENCE
    index.md                   ** conventions: money as strings, ids, errors, idempotency
    merchant.md                   4 routes, src/api/routes.ts:161-272
    public.md                     4 routes incl. /health, routes.ts:156-360
    console.md                    12 read (src/api/admin.ts) + 6 write (src/api/admin-write.ts)
    errors.md                  ** status codes and error shapes
  architecture/                — INTERNAL TRACK
    overview.md                   rewrite of the stale docs/OVERVIEW.md + boot sequence diagram
    data-model.md              ** every table in src/db/schema.ts, enums, indexes, numeric(78,0)
    payment-lifecycle.md       ** the spine, as a Mermaid state + sequence diagram
    workers.md                 ** supervisor, 2 watchers, 2 confirmers, expirer — cadence table
    pricing.md                 ** CoinGecko + separate USD→COP FX leg, spread, TTLs, fallbacks
    wallets-and-keys.md        ** HD derivation, accounts 0/1, seed fingerprint, signer boundary
    sweeping.md                ** what exists today; links to the canonical design doc
    console.md                 ** read/write router split, operator auth, audit model
    observability.md              moved from docs/LOGGING.md (already current)
    invariants.md              ** the load-bearing rules on one page
  operations/                  — RUNBOOKS
    configuration.md           ** every env var: default, meaning, preflight rule
    local-development.md          from README "Getting started"
    database.md                ** generate vs migrate vs deploy, the two apply paths
    deployment.md                 from README "Deploying to Railway"
    mainnet-checklist.md          from README "Mainnets" + the remote-signer gate
    sweeping-runbook.md        ** probe → dry-run → enable → reconcile → what to watch
    troubleshooting.md         ** RPC backoff, Alchemy getLogs cap, CoinGecko COP, seed mismatch
  contributing/
    index.md                      from AGENTS.md
    conventions.md             ** no console.*, no bare useEffect fetching, bigint money, docblocks
    verification.md               2 typechecks + 5 scripts, and what each one actually proves
  adr/
    index.md                   ** ~9 records mined from existing code comments (see below)
    0001-…md … 0009-…md
  design/                      — canonical design docs, moved, content unchanged
    SWEEPING-PLAN.md
    CONSOLE-WRITE-PLAN.md
    TESTING-REPORT.md          with a dated "archived snapshot, 2026-07-22" banner
  crypto-gateway.postman_collection.json   (stays)
```

`docs/OVERVIEW.md` and `docs/LOGGING.md` do not survive as filenames; their content moves to
`architecture/overview.md` and `architecture/observability.md`.

### ADRs to mine (rationale already written, just not as decisions)

`numeric(78,0)`-as-bigint (`schema.ts:7-21`) · event-sourced settlement, never `balanceOf`
(`sweeper.ts:9-20`) · decimals per (network, asset) pairing, not per symbol · no queue —
in-process workers over Postgres tables · read/write console router split · operator identity +
in-transaction audit row for every mutation · the `signer.ts` key boundary and the remote-signer
seam · sweeps table with no FK to payments (`schema.ts:229-244`) · capability gated on
`scripts/sweep-probe.ts` before a pairing is swept.

---

## Drift to fix (all confirmed against the code)

| # | Where | Problem |
|---|---|---|
| 1 | `README.md:542` | *"Nothing here moves them"* — the sweeper has existed since `0ff2466` |
| 2 | `README.md:624` | lists "cold sweeping" as pending; phases 0/1/2/4 are done |
| 3 | `README.md:143` | links `docs/HTTPIE.md`, which does not exist → becomes `guides/quickstart.md` |
| 4 | `README.md:207` | *"Every route is a `SELECT`, so nothing in the console can mutate a payment"* — `POST /admin/api/payments` exists |
| 5 | `README.md` API table | missing `/admin/api/{logs,diagnostics,wallets,sweeps,deposits}` |
| 6 | `README.md:333-392` | Structure block omits all of `src/observability/`, 7 services, 2 workers, 8 `web/src/admin/` files, 7 scripts |
| 7 | `README.md:192+` | "Six views"; the router has 7 plus `WalletsPanel` |
| 8 | `docs/OVERVIEW.md` | claims EVM-only, Sepolia + Base only, "USDC today" — reality is 5 served networks incl. `tron-nile`, USDT live, native BNB/POL/TRX live |
| 9 | `AGENTS.md` | zero occurrences of "sweep": no treasury, relayer, or signer-boundary rule |
| 10 | `docs/TESTING-REPORT.md` | undated point-in-time snapshot read as current state |

Both `README.md` and `AGENTS.md` are **already modified in the working tree** (console-write
documentation, uncommitted). Rebase this work on top of those edits; do not revert them.

### What `README.md` and `AGENTS.md` become

- **`README.md` → ~120 lines.** What it is, the network/asset matrix, five-command quickstart,
  and a linked table of contents into `docs/`. Everything else moves out.
- **`AGENTS.md` stays** as the agent-facing invariant sheet — it is doing its job well. Add the
  missing sweeping/signer/treasury bullets, point "Sources of truth" at the new `docs/` layout,
  and keep it short.

---

## Execution phases

**Phase 0 — scaffold and prove it doesn't break the app.**
Add `docs/package.json` + `docs/.vitepress/config.ts`, `.gitignore` entries, root `docs:dev`/
`docs:build` scripts. Gate: `bun install` at root unchanged, `bun run build:web`, `bun run
typecheck`, `bun run typecheck:web` all still pass.

**Phase 1 — move, don't write.** Relocate the six existing docs into the new tree. Update the
16 code comments referencing old paths in one mechanical pass over `src/`, `scripts/`
(`src/config.ts` ×4, `src/services/{sweeper,signer,evm-sweep,audit}.ts`, `src/workers/{sweeper,
sweep-recon}.ts`, `src/db/schema.ts:219`, `src/api/admin.ts:743`, `src/observability/index.ts:12`,
`scripts/{sweep-probe,sweep-test}.ts`). Gate: `grep -rn "docs/\(LOGGING\|OVERVIEW\|SWEEPING-PLAN\|CONSOLE-WRITE-PLAN\|TESTING-REPORT\|HTTPIE\)" src/ scripts/ web/src/ README.md AGENTS.md`
returns nothing.

**Phase 2 — integrator track** (`guides/`, `api/`). Highest external value, and it retires the
dead `HTTPIE.md` link. Derive the API pages route-by-route from `src/api/routes.ts`,
`admin.ts`, `admin-write.ts`, and field-by-field from `createPaymentSchema` in `src/api/http.ts`.

**Phase 3 — architecture track.** Lean hard on the existing module docblocks: 59 of 63 TS files
open with a rationale header and they are effectively pre-written prose. `payment-lifecycle.md`,
`workers.md` and `data-model.md` carry the Mermaid diagrams.

**Phase 4 — operations track + drift fixes.** `configuration.md` is generated by reading the
`env` object (`src/config.ts:9-137`) against `.env.example` and `preflight()`/`preflightSweeping()`
— any var in one and not the other is a bug to report, not to paper over. Then apply the ten
drift fixes and shrink `README.md`.

**Phase 5 — ADRs + contributing.** Mine the nine decision records; fold `AGENTS.md` prose into
`contributing/`.

---

## Reuse — do not re-derive these

| Need | Already exists at |
|---|---|
| Network/token/decimals matrix | `NETWORKS`, `src/config.ts:531-729` — generate tables from it, never retype |
| Env var semantics | `env` `src/config.ts:9-137`; `preflight()` :167; `preflightSweeping()` :267; `configSummary()` :322 |
| Sweeping design | `docs/SWEEPING-PLAN.md` §1-16 — `architecture/sweeping.md` summarises and links, never duplicates |
| Console-write design | `docs/CONSOLE-WRITE-PLAN.md` — fully executed; its §9 already predicted this drift |
| Logging contract | `docs/LOGGING.md` — current, includes the new sweep/audit scopes; move verbatim |
| Request/response shapes | `docs/crypto-gateway.postman_collection.json` |
| Payment state machine | `src/services/payments.ts:24,105,271,447` and the `payment_status` enum `schema.ts:23-30` |
| Per-module rationale | the docblock at the top of nearly every file in `src/` |

---

## Verification

1. **Build.** `bun run docs:build` succeeds with `ignoreDeadLinks: false` — this alone catches
   every broken internal link, including the class of bug that `docs/HTTPIE.md` was.
2. **App untouched.** `bun run typecheck`, `bun run typecheck:web`, `bun run build:web` pass.
3. **No stale doc paths in code.** The Phase 1 grep returns nothing.
4. **API reference matches the router.** Diff the route list in `api/*.md` against
   `grep -nE '\.(get|post|patch|delete)\(' src/api/routes.ts src/api/admin.ts src/api/admin-write.ts src/api/admin-auth.ts` — counts must match (expected: 4 merchant, 4 public, 12 console read, 6 console write, 3 auth).
5. **Env table matches config.** Every key in `configuration.md` appears in `src/config.ts`'s
   `env` object and in `.env.example`, and vice versa.
6. **Network matrix matches the registry.** Every row in `networks-and-assets.md` matches
   `NETWORKS`, including the awkward ones: USDT/USDC at **18** decimals on BSC, 64/128
   confirmations on Amoy/Polygon, `tron-nile` USDT at 6.
7. **Quickstart runs end to end.** Against a live local stack — `bun run db:up && bun run
   db:deploy && bun run seed && bun run dev` — execute every command in
   `guides/quickstart.md` verbatim: create a payment, open the checkout URL, poll
   `/api/payments/:publicId/status`, and confirm a `payment.paid` webhook fires
   (`scripts/create-payment.ts` and `scripts/wallets.ts` make this deterministic offline).
8. **Existing suites still green.** `bun run scripts/smoke-test.ts`, `api-test.ts`,
   `admin-test.ts` — proves the Phase 1 comment edits touched nothing but comments.

## Out of scope

OpenAPI/Swagger generation (no tooling in the repo today; the Postman collection stays the
machine-readable artifact), public hosting of the site, Spanish translation, and adding CI —
each is a reasonable follow-up but none is required to land the docs.
