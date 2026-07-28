/**
 * Treasury sweeping — candidate selection and policy.
 *
 * Implements §6 and §7 of docs/SWEEPING-PLAN.md. Execution (signing,
 * broadcasting, confirming) lives in workers/sweeper.ts; everything here is
 * either a database read or a pure decision, so the policy can be tested
 * without a chain, a signer or a treasury.
 *
 * The invariant this module depends on, and must not break:
 *
 *   **Settlement is event-sourced, never balance-based.** `registerDeposit` and
 *   `confirmDeposit` accumulate `confirmed_raw` from Transfer log data and from
 *   block bodies. There is no `balanceOf`, no `eth_getBalance` and no
 *   `readContract` anywhere in the payment path. Sweeping a deposit address at
 *   any moment therefore cannot change what a payment settles at — including
 *   mid-grace on a `partially_paid` one, where a later top-up produces a new
 *   Transfer to the same (now empty) address and is still credited.
 *
 * That is what lets this be a fully independent subsystem: it never coordinates
 * with the payment state machine, and it can never race it.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "../db";
import {
  NETWORKS,
  assetFor,
  env,
  gasCoinFor,
  sweepFor,
  type NetworkId,
  type SweepVia,
} from "../config";
import { getRateCopE6, copToRaw, getUsdCopRate } from "./rates";
import { isTronAddress } from "./tron";
import { getLogger, count } from "../observability";

const log = getLogger("sweeper");

/** Statuses that occupy the partial unique index — one live sweep per pairing. */
export const LIVE_STATUSES = ["planned", "authorized", "broadcast"] as const;

/** Why a candidate was not swept. Recorded on the row and used as a metric label. */
export type SkipReason =
  | "below_floor"
  | "fee_too_high"
  | "gas_ceiling"
  | "no_treasury"
  | "unpriceable"
  | "unimplemented";

/**
 * Mechanisms this build can actually carry out.
 *
 * Separate from the registry's `sweep` field, which says what a *contract*
 * supports. A pairing the registry marks `delegate` is correctly marked — Tron
 * TRC-20 really does need delegated energy — but the code that delegates is
 * Phase 3, so the pairing is deferred with a reason rather than planned into a
 * row nothing will ever pick up. Adding a phase means adding to this set.
 */
export const EXECUTABLE_VIA = new Set<SweepVia["via"]>(["eip3009", "native"]);

export type Candidate = {
  network: NetworkId;
  address: string;
  derivationIndex: number;
  asset: string;
  decimals: number;
  /** Confirmed on-chain value at this address, minus what has already been swept. */
  amountRaw: bigint;
  via: SweepVia["via"];
};

export type Decision =
  | { sweep: true; candidate: Candidate }
  | { sweep: false; candidate: Candidate; reason: SkipReason };

// -- Treasury ----------------------------------------------------------

/**
 * Where sweeps on this network land, or null when the family has no usable
 * treasury configured.
 *
 * The preflight already refuses to boot on a missing or malformed address, so
 * reaching null here means either sweeping was switched on after boot or — the
 * case the preflight cannot cover — a Base58Check address whose *checksum* is
 * wrong. The codec lives with the Tron client, which config.ts may not import,
 * so the strict check happens here instead and disables the family rather than
 * sending value to an address nobody controls.
 */
export function treasuryFor(network: NetworkId): string | null {
  if (NETWORKS[network].family === "tron") {
    const address = env.treasuryTron;
    if (!address) return null;
    if (!isTronAddress(address)) {
      log.repeat("bad-tron-treasury", "error", "TREASURY_ADDRESS_TRON fails Base58Check — Tron sweeps disabled", {
        "sweep.treasury": address,
      });
      return null;
    }
    return address;
  }
  return env.treasuryEvm;
}

// -- Candidate selection -----------------------------------------------

type LedgerRow = {
  address: string;
  derivation_index: number;
  asset: string;
  confirmed_raw: string;
  swept_raw: string;
};

/**
 * Confirmed-but-unswept value per (address, asset) on a network.
 *
 * Summed from `deposits`, not from `payments.confirmed_raw`, and the difference
 * is the whole point: a deposit in an asset its payment never quoted is marked
 * confirmed and contributes *nothing* to `payments.confirmed_raw` (see the
 * mismatch guard in payments.ts), yet it is real value sitting at a real address
 * of ours. Those are precisely the funds most likely to be stranded, and summing
 * the payment column instead would make them invisible to the sweeper forever.
 *
 * `deposits.confirmed` is the same flag the confirmer sets after the network's
 * confirmation depth, and the same one it clears by deleting the row when a
 * reorg unwinds a transfer — so unconfirmed and reorged value is excluded here
 * without this module owning a second definition of "final".
 *
 * Subtracts sweeps that are already confirmed *or still live*: an in-flight
 * broadcast has not moved the money yet, but planning a second sweep for it
 * would double-count.
 */
async function unsweptLedger(network: NetworkId): Promise<LedgerRow[]> {
  const rows = await db.execute(sql`
    SELECT p.address                                  AS address,
           p.derivation_index                         AS derivation_index,
           d.asset                                    AS asset,
           SUM(d.amount_raw)::numeric(78,0)           AS confirmed_raw,
           COALESCE((
             SELECT SUM(s.amount_raw)
               FROM ${schema.sweeps} s
              -- The bound parameter, not p.network: a correlated subquery may
              -- only reference columns the outer GROUP BY produced, and the
              -- network is already pinned by the WHERE clause below.
              WHERE s.network = ${network}
                AND s.address = p.address
                AND s.asset   = d.asset
                AND s.status IN ('planned','authorized','broadcast','confirmed')
           ), 0)::numeric(78,0)                       AS swept_raw
      FROM ${schema.deposits} d
      JOIN ${schema.payments} p ON p.id = d.payment_id
     WHERE d.network = ${network}
       AND d.confirmed = true
     GROUP BY p.address, p.derivation_index, d.asset
  `);
  return rows as unknown as LedgerRow[];
}

/**
 * Everything on this network with unswept value and a mechanism to move it.
 *
 * A pairing with no `sweep` entry in the registry is skipped silently and by
 * design — that is the registry gate from §4.5, and it is what stops a newly
 * added network from inheriting another one's assumption.
 */
export async function candidates(network: NetworkId): Promise<Candidate[]> {
  const rows = await unsweptLedger(network);
  const out: Candidate[] = [];

  for (const row of rows) {
    const amountRaw = BigInt(row.confirmed_raw) - BigInt(row.swept_raw);
    if (amountRaw <= 0n) continue;

    const how = sweepFor(network, row.asset);
    if (!how) {
      log.trace("pairing has no sweep mechanism — leaving it", {
        "chain.network": network,
        "sweep.asset": row.asset,
      });
      continue;
    }

    const asset = assetFor(network, row.asset);
    if (!asset) continue; // an asset the registry no longer defines

    out.push({
      network,
      address: row.address,
      derivationIndex: row.derivation_index,
      asset: row.asset,
      decimals: asset.decimals,
      amountRaw,
      via: how.via,
    });
  }
  return out;
}

// -- Policy ------------------------------------------------------------

/**
 * The economic inputs a decision needs, resolved once per network per tick.
 *
 * Kept as a parameter rather than fetched inside `decide()` so the policy stays
 * pure: the tests drive it with fixed numbers and no rate service, exactly as
 * the other scripts in this repo drive the payment path with a frozen rate.
 */
export type Economics = {
  /** Floor in raw units of the swept asset, from SWEEP_MIN_USD. */
  minRaw: bigint;
  /** Estimated fee for one sweep, in the *fee* currency's smallest unit. */
  feeRaw: bigint;
  /** COP per whole unit of the swept asset, x1e6. */
  assetRateE6: bigint;
  /** COP per whole unit of the fee currency, x1e6. */
  feeRateE6: bigint;
  feeDecimals: number;
  /** Current gas price in gwei, and the ceiling above which we defer. */
  gasPriceGwei: number;
  gasCeilingGwei: number | null;
  treasury: string | null;
};

/** COP value of a raw amount, rounded down. */
function toCop(amountRaw: bigint, rateE6: bigint, decimals: number): bigint {
  return (amountRaw * rateE6) / (10n ** BigInt(decimals) * 1_000_000n);
}

/**
 * Pure. Whether to sweep this candidate, and why not when the answer is no.
 *
 * All four tests are deferrals rather than failures: value that is too small or
 * too expensive to move today keeps accumulating at the address and is
 * re-evaluated next tick, which is the correct behaviour for small tickets. A
 * `skipped` row records the reason so the console can show it.
 */
export function decide(candidate: Candidate, economics: Economics): Decision {
  const no = (reason: SkipReason): Decision => ({ sweep: false, candidate, reason });

  if (!EXECUTABLE_VIA.has(candidate.via)) return no("unimplemented");
  if (!economics.treasury) return no("no_treasury");
  if (candidate.amountRaw < economics.minRaw) return no("below_floor");

  if (
    economics.gasCeilingGwei !== null &&
    economics.gasPriceGwei > economics.gasCeilingGwei
  ) {
    return no("gas_ceiling");
  }

  // The fee and the swept value are in different currencies, so the economic
  // test is run in COP — the one unit both sides can be expressed in, using the
  // same rate service that prices a quote. A pairing that cannot be priced is
  // deferred rather than swept blind.
  if (economics.assetRateE6 <= 0n || economics.feeRateE6 <= 0n) return no("unpriceable");

  const valueCop = toCop(candidate.amountRaw, economics.assetRateE6, candidate.decimals);
  const feeCop = toCop(economics.feeRaw, economics.feeRateE6, economics.feeDecimals);
  if (valueCop <= 0n) return no("below_floor");
  if (feeCop * 10_000n > valueCop * env.sweepMaxCostBps) return no("fee_too_high");

  return { sweep: true, candidate };
}

/**
 * Resolves `Economics` for a (network, asset) from the live rate service.
 *
 * On a testnet the prices are real-world prices for valueless coins, so the
 * arithmetic below is fictional in absolute terms — but it is the same
 * arithmetic mainnet would run, which is the point of exercising it here.
 */
export async function economicsFor(
  network: NetworkId,
  asset: string,
  decimals: number,
  feeRaw: bigint,
  gasPriceGwei: number
): Promise<Economics> {
  const gasCoin = gasCoinFor(network);
  const net = NETWORKS[network];

  // A rate lookup can fail (both providers down, no fresh cache). That must
  // defer the sweep, never abort the tick, so a zero rate flows through to
  // `unpriceable` rather than throwing.
  const rate = (symbol: string) =>
    getRateCopE6(symbol).catch((e) => {
      log.repeat(`rate:${symbol}`, "warn", "sweep deferred — asset is unpriceable", {
        "sweep.asset": symbol,
        err: e,
      });
      return 0n;
    });

  const [assetRateE6, feeRateE6, usdCop] = await Promise.all([
    rate(asset),
    gasCoin.symbol === asset ? rate(asset) : rate(gasCoin.symbol),
    getUsdCopRate().catch(() => 0),
  ]);

  // SWEEP_MIN_USD is a value, and the column holds raw units — so the floor goes
  // through the same USD -> COP -> raw path a quote does.
  const minCop = BigInt(Math.round(env.sweepMinUsd * usdCop));
  const minRaw =
    minCop > 0n && assetRateE6 > 0n ? copToRaw(minCop, assetRateE6, decimals) : 0n;

  return {
    minRaw,
    feeRaw,
    assetRateE6,
    feeRateE6,
    feeDecimals: gasCoin.decimals,
    gasPriceGwei,
    gasCeilingGwei:
      env.sweepGasCeilingGwei ??
      (net.family === "evm" ? net.sweepGasCeilingGwei ?? null : null),
    treasury: treasuryFor(network),
  };
}

// -- Persistence -------------------------------------------------------

/**
 * Records a decision, and returns the row when one was written.
 *
 * The insert is the concurrency control: `sweeps_live_idx` permits at most one
 * planned/authorized/broadcast row per (network, address, asset), so two ticks
 * racing on the same candidate produce one row and one `undefined`. Nothing
 * downstream needs a lock.
 *
 * A `skipped` row is outside that index on purpose — the reason should be
 * visible without blocking the sweep that becomes viable next tick — so it is
 * written once per tick only when nothing live already covers the pairing.
 */
export async function record(
  decision: Decision,
  treasury: string
): Promise<typeof schema.sweeps.$inferSelect | undefined> {
  const c = decision.candidate;
  const status = decision.sweep ? "planned" : "skipped";

  if (decision.sweep) {
    // A pairing that was deferred and has now become viable must not keep its
    // stale reason on display beside the sweep that is about to move it.
    await clearSkip(c.network, c.address, c.asset);
  } else {
    // Deferrals are noisy by nature — the common case is "5 USD of dust, every
    // two minutes, forever" — so only the first one per pairing is stored, and
    // it is refreshed rather than duplicated.
    const [existing] = await db
      .select()
      .from(schema.sweeps)
      .where(
        and(
          eq(schema.sweeps.network, c.network),
          eq(schema.sweeps.address, c.address),
          eq(schema.sweeps.asset, c.asset),
          eq(schema.sweeps.status, "skipped")
        )
      )
      .limit(1);

    if (existing) {
      await db
        .update(schema.sweeps)
        .set({ amountRaw: c.amountRaw, reason: decision.reason, updatedAt: new Date() })
        .where(eq(schema.sweeps.id, existing.id));
      return undefined;
    }
  }

  const [row] = await db
    .insert(schema.sweeps)
    .values({
      network: c.network,
      address: c.address,
      derivationIndex: c.derivationIndex,
      asset: c.asset,
      amountRaw: c.amountRaw,
      toAddress: treasury,
      via: c.via,
      status,
      reason: decision.sweep ? null : decision.reason,
    })
    .onConflictDoNothing()
    .returning();

  if (row) {
    count(decision.sweep ? "sweeps.planned" : "sweeps.skipped", {
      network: c.network,
      ...(decision.sweep ? {} : { reason: decision.reason }),
    });
  }
  return row;
}

/**
 * Clears the `skipped` marker for a pairing that has become sweepable.
 *
 * Without this a pairing that was once below the floor keeps a stale reason on
 * display after it starts sweeping normally.
 */
export async function clearSkip(network: NetworkId, address: string, asset: string) {
  await db
    .delete(schema.sweeps)
    .where(
      and(
        eq(schema.sweeps.network, network),
        eq(schema.sweeps.address, address),
        eq(schema.sweeps.asset, asset),
        eq(schema.sweeps.status, "skipped")
      )
    );
}

/** Sweeps on a network that still need work, oldest first. */
export async function dueSweeps(network: NetworkId, limit = 50) {
  return db
    .select()
    .from(schema.sweeps)
    .where(
      and(
        eq(schema.sweeps.network, network),
        inArray(schema.sweeps.status, [...LIVE_STATUSES]),
        sql`${schema.sweeps.nextAttemptAt} <= now()`
      )
    )
    .orderBy(schema.sweeps.createdAt)
    .limit(limit);
}
