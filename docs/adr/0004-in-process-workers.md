# 0004 — In-process workers over a queue

**Status:** Accepted

## Context

The gateway needs several long-running jobs per network — watch for transfers,
confirm deposits, sweep deposit addresses, reconcile balances — plus two
global ones (expire stale quotes, deliver webhooks). A production system at
larger scale would typically run these as separate worker processes behind a
real job queue (e.g. pg-boss), coordinated so exactly one instance of each job
runs at a time.

## Decision

For this stage, every job is a `setInterval` loop inside the single API
process (`src/index.ts` starts them all together via `superviseNetwork()` per
network plus `startExpirer()`), reading Postgres directly rather than a queue.
`railway.json` pins `numReplicas: 1` to match: these loops have no leader
election, so a second replica would duplicate every provider call and every
poll rather than share the work.

The choice is bounded by two things that already exist and keep it safe at this
scale: **row locks** around every payment state transition, and **deposit
idempotency** by `(network, txHash, logIndex)` — both of which mean a second
process running the same loop would not corrupt data, it would only waste
provider quota. That headroom is what makes staying in-process an acceptable
trade for now rather than a risk being carried silently.

## Consequences

- No separate deployable, no queue broker, and no cross-process coordination to
  operate for the MVP — one container, one health check, one log stream.
- The ceiling is explicit: scaling beyond one replica, or adding a job that
  cannot tolerate concurrent execution without the existing locks/idempotency,
  requires splitting the workers out behind a real queue first. This is listed
  as a known limitation rather than deferred silently.
- A worker crash inside the process (an unhandled rejection from a flaky RPC,
  for instance) is caught at the process level (`process.on("unhandledRejection", …)`)
  and logged rather than taking the whole gateway down — necessary precisely
  because there is no supervisor process to restart an isolated worker.

*Source: `src/index.ts`, `src/workers/supervisor.ts`; `railway.json`
(`numReplicas: 1`); `AGENTS.md`.*
