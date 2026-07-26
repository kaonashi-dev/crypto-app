# Project Overview

## Summary

This project is a **minimum viable product (MVP) for a crypto payment gateway**. It
lets merchants price and account for sales in **Colombian pesos (COP)** while accepting
payment in **stablecoins** — **USDC** today, with USDT prepared — on EVM networks. The
entire MVP runs on **testnets** (Ethereum Sepolia and Base Sepolia), so it can be
exercised end-to-end with zero financial or regulatory risk.

## Objective

Enable a merchant to:

1. **Create a charge denominated in COP.**
2. **Receive an on-chain stablecoin payment** to a unique, per-payment address.
3. Have that payment **automatically detected, confirmed, and credited** to their COP
   balance, with a **signed webhook** notifying their backend.

The primary goal of the MVP is to prove the complete flow —
`quote → unique address → on-chain detection → confirmation → COP crediting` — together
with production-grade robustness patterns (idempotency, reorg handling, partial
payments), while deliberately **deferring** custody/key hardening and additional chains
to later phases.

## Context and motivation

- **Colombia context.** Many merchants want the price stability of accounting in COP,
  but the settlement benefits of stablecoins: fast cross-border acceptance, no
  chargebacks, 24/7 settlement, and a hedge against local banking friction.
- **Why stablecoins (USDC/USDT).** They track the US dollar, so the payer sends a
  dollar-stable asset while the merchant keeps thinking in pesos — no exposure to
  crypto volatility between checkout and settlement.
- **Why COP-denominated.** The merchant's books, catalog, and reconciliation stay in
  local currency. The gateway absorbs the FX conversion and short-term rate risk via a
  **frozen quote plus a spread**.
- **Why an EVM testnet MVP.** It validates the real mechanics — address derivation,
  event watching, confirmations, partial-payment UX — before touching mainnet, custody,
  and the Colombian regulatory surface (PSAV/DIAN).
- **Why a unique address per payment.** Reconciliation becomes trivial and unambiguous:
  every transfer to that address belongs to exactly one invoice.

## Problem it solves

Accepting crypto for a peso-priced sale bundles several hard sub-problems that this
gateway solves together:

- **Pricing** — locking a COP↔crypto rate long enough for the payer to pay, without ever
  under-collecting.
- **Detection** — knowing reliably when funds actually arrive on-chain, including across
  WebSocket reconnects and chain reorganizations.
- **Partial payments** — real payers often send the wrong amount or split a payment; the
  gateway offers a grace window to complete at the frozen rate.
- **Settlement & accounting** — crediting the merchant in COP with an auditable ledger
  and notifying them through signed, retried webhooks.

## How it works (high level)

1. **Quote & address.** On `POST /api/payments`, the gateway freezes a COP→USDC quote
   (market rate + spread, 15-minute TTL) and derives a unique HD address for the payment.
2. **Checkout.** `/pay/:publicId` serves a QR code (EIP-681), the address, a countdown,
   and 3-second status polling.
3. **Detection.** A WebSocket watcher (Alchemy), filtered by the indexed `to` topic,
   sees the ERC-20 `Transfer`. A `getLogs` backfill covers any WebSocket gaps.
4. **Confirmation.** A confirmer waits N confirmations per network (5 on Sepolia, 3 on
   Base Sepolia), re-checking the transaction receipt to defend against reorgs.
5. **Settlement.** Once the confirmed sum ≥ required amount (with a 0.5% dust tolerance),
   the payment becomes `paid`, the merchant's COP balance is credited, a ledger entry is
   written, and a `payment.paid` webhook is enqueued.
6. **Partial payments.** The first deposit opens a **90-minute grace window** to complete
   the amount at the frozen rate. If it lapses while still incomplete, the payment becomes
   `underpaid_expired` for manual resolution.

**State machine:** `pending → detecting → partially_paid → paid`, with branches `expired`
(quote lapsed with no funds) and `underpaid_expired` (grace lapsed while partial).

## Scope

**In scope (this MVP):**

- COP-denominated charges paid in USDC on Ethereum Sepolia and Base Sepolia.
- Unique HD address per payment; quote freezing with spread; partial payments with a
  grace window; dust tolerance; overpayment tracking.
- On-chain watcher / confirmer / expirer workers; HMAC-signed webhooks with retries; a
  COP balance plus an audit ledger.
- Merchant REST API (`X-Api-Key`) and a hosted checkout page.
- A **read-only internal backoffice console** (`/admin`) for inspecting transactions:
  payment list with filtering and transaction-hash search, per-payment drill-down into
  on-chain deposits / webhook attempts / ledger credits, and a flat deposit feed.

**Out of scope (deferred to later phases):**

- Mainnet and key-custody hardening (xpub-only derivation, cold-wallet sweeping,
  KMS/HSM).
- BTC (via BTCPay Server) and USDT TRC-20 (via TronGrid) — the watcher architecture is
  designed to plug these in as new watchers.
- Multi-source price medians, rate limiting, and API-key rotation.
- Authentication for the backoffice console, and the write actions it deliberately omits:
  resolving `underpaid_expired` payments (a refund or manual credit, so it moves balances)
  and re-queueing webhook jobs that exhausted their 8 attempts.
- Legal/regulatory evaluation (Colombia PSAV/DIAN) required before handling real
  third-party funds.

## Design principles

- **Money as integers.** All amounts are stored as `bigint` in the smallest unit — COP
  without decimals, tokens in raw units (e.g. USDC = 6 decimals). Never floats.
- **Freeze the quote.** The payer always pays at the rate shown, within the quote and
  grace windows.
- **Never under-collect.** COP→raw conversion always rounds up.
- **Idempotent and safe.** Deposits are deduplicated by `(network, txHash, logIndex)`;
  every state transition runs under `FOR UPDATE` locks; a guard prevents double-crediting
  when a deposit confirms after settlement.
- **Single process for the MVP.** The API and all workers run together; a production
  deployment would split them and use a real job queue.

## Roadmap (indicative)

| Phase | Deliverable |
|---|---|
| 1 | Scaffolding, schema, migrations, seed, create-payment with quote + HD address |
| 2 | Watcher + confirmer + expirer on Base Sepolia; full payment end-to-end |
| 3 | Checkout UI with QR, polling, and partial states; signed webhooks |
| 4 | Edge cases (partial→complete, partial→expired, overpay, simulated reorg); second network (Ethereum Sepolia) |
| 5+ | BTCPay (BTC), TronGrid (USDT TRC-20), and production hardening |

## Glossary

- **HD address** — an address derived from a single mnemonic (or xpub) at an incremental
  index, following BIP-32/44.
- **EIP-681** — a URI format that wallets read from a QR to pre-fill the token, recipient,
  and amount.
- **Dust tolerance** — a small threshold (0.5%) below the exact amount that is still
  treated as fully paid.
- **Grace window** — extra time (90 minutes) after the first deposit to complete a partial
  payment at the frozen rate.
- **Reorg** — a blockchain reorganization that can revert a previously observed block or
  transaction.
