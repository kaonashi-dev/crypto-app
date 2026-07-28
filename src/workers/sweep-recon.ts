/**
 * Reconciliation — §9 of docs/SWEEPING-PLAN.md.
 *
 * Reads what each deposit address actually holds and compares it with what the
 * ledger says it should hold:
 *
 *     on-chain balance  vs  (Σ confirmed deposits − Σ confirmed sweeps)
 *
 * Without this, criterion S4 is unprovable and the whole subsystem is
 * unauditable. It also does something the sweeper cannot: it surfaces value that
 * arrived where no watcher was looking. Because the same BIP-32 key produces the
 * same address on every EVM chain, a deposit address is live on *every* EVM
 * chain at once — including mainnets this gateway does not serve — so value can
 * land somewhere nothing will ever detect it. A drift reported here is how that
 * becomes visible within the hour instead of by manual investigation.
 *
 * **This is the one place `balanceOf`/`getBalance` is legitimate.** Settlement is
 * event-sourced from Transfer logs and must stay that way; these reads are for
 * auditing and never feed `registerDeposit`, `confirmDeposit`, or any payment
 * column. Nothing in this file writes to `payments`, `deposits` or `sweeps`.
 *
 * Read-only, so it runs independently of `SWEEP_ENABLED` — auditing is useful
 * long before sweeping is switched on.
 */
import { sql } from "drizzle-orm";
import { erc20Abi, type Hex } from "viem";
import { db, schema } from "../db";
import { NETWORKS, assetFor, env, type EvmNetworkDef, type NetworkId } from "../config";
import { clientFor } from "../services/evm-sweep";
import { clearRpcError, logRpcError } from "./rpc-log";
import { getLogger, withContext, count, gauge } from "../observability";

type Expected = {
  address: string;
  asset: string;
  decimals: number;
  /** Confirmed in minus swept out — what should still be sitting there. */
  expectedRaw: bigint;
};

/**
 * What the ledger says each address still holds, per asset.
 *
 * Includes assets whose expectation is zero (already swept), because a *zero*
 * expectation that reads non-zero on-chain is the most interesting result this
 * job can produce — it is money nobody has accounted for.
 */
async function expectations(network: NetworkId): Promise<Expected[]> {
  const rows = await db.execute(sql`
    SELECT p.address                        AS address,
           d.asset                          AS asset,
           SUM(d.amount_raw)::numeric(78,0) AS confirmed_raw,
           COALESCE((
             SELECT SUM(s.amount_raw) FROM ${schema.sweeps} s
              -- The bound parameter rather than p.network, for the reason
              -- documented on the same subquery in services/sweeper.ts.
              WHERE s.network = ${network} AND s.address = p.address
                AND s.asset = d.asset AND s.status = 'confirmed'
           ), 0)::numeric(78,0)             AS swept_raw
      FROM ${schema.deposits} d
      JOIN ${schema.payments} p ON p.id = d.payment_id
     WHERE d.network = ${network} AND d.confirmed = true
     GROUP BY p.address, d.asset
     ORDER BY p.address
  `);

  const out: Expected[] = [];
  for (const row of rows as unknown as Array<{
    address: string;
    asset: string;
    confirmed_raw: string;
    swept_raw: string;
  }>) {
    const asset = assetFor(network, row.asset);
    if (!asset) continue;
    out.push({
      address: row.address,
      asset: row.asset,
      decimals: asset.decimals,
      expectedRaw: BigInt(row.confirmed_raw) - BigInt(row.swept_raw),
    });
  }
  return out;
}

/**
 * Value that is in flight or deliberately deferred, so drift can be classified
 * rather than alarmed on.
 *
 * §9 names two benign cases: a sweep that is signed or broadcast but not yet
 * confirmed, and value sitting below the floor waiting to accumulate. Both show
 * up as an on-chain balance the confirmed-sweep arithmetic has not yet removed.
 */
async function inFlight(network: NetworkId): Promise<Map<string, bigint>> {
  const rows = await db.execute(sql`
    SELECT address, asset, SUM(amount_raw)::numeric(78,0) AS raw
      FROM ${schema.sweeps}
     WHERE network = ${network} AND status IN ('planned','authorized','broadcast')
     GROUP BY address, asset
  `);
  return new Map(
    (rows as unknown as Array<{ address: string; asset: string; raw: string }>).map((r) => [
      `${r.address}/${r.asset}`,
      BigInt(r.raw),
    ])
  );
}

/**
 * On-chain balances for a batch of (address, asset) pairs, in one call where
 * possible.
 *
 * Every chain in the registry has Multicall3 deployed, which collapses N
 * `balanceOf` reads into a single `eth_call` — the difference between an
 * affordable hourly audit and one that spends the provider quota the payment
 * path needs. Falls back to individual reads on a chain without it.
 */
async function balances(network: NetworkId, batch: Expected[]): Promise<(bigint | null)[]> {
  const client = clientFor(network);
  const net = NETWORKS[network] as EvmNetworkDef;

  const calls = batch.map((item) => {
    const asset = assetFor(network, item.asset)!;
    return { item, asset };
  });

  if (net.chain.contracts?.multicall3) {
    // Native-coin rows have no contract to call, so they are read separately;
    // in practice a network quotes at most one native asset.
    const tokenCalls = calls.filter((c) => c.asset.kind === "token");
    const results = tokenCalls.length
      ? await client.multicall({
          allowFailure: true,
          contracts: tokenCalls.map((c) => ({
            address: (c.asset as { address: string }).address as Hex,
            abi: erc20Abi,
            functionName: "balanceOf" as const,
            args: [c.item.address as Hex],
          })),
        })
      : [];
    count("rpc.calls", { network, method: "eth_call:multicall" });

    const byIndex = new Map<number, bigint | null>();
    tokenCalls.forEach((c, i) => {
      const r = results[i];
      byIndex.set(calls.indexOf(c), r && r.status === "success" ? (r.result as bigint) : null);
    });

    return Promise.all(
      calls.map(async (c, i) => {
        if (c.asset.kind === "token") return byIndex.get(i) ?? null;
        const balance = await client.getBalance({ address: c.item.address as Hex }).catch(() => null);
        count("rpc.calls", { network, method: "eth_getBalance" });
        return balance;
      })
    );
  }

  return Promise.all(
    calls.map(async (c) => {
      if (c.asset.kind === "native") {
        return client.getBalance({ address: c.item.address as Hex }).catch(() => null);
      }
      return client
        .readContract({
          address: (c.asset as { address: string }).address as Hex,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [c.item.address as Hex],
        })
        .catch(() => null);
    })
  );
}

export function startSweepRecon(network: NetworkId) {
  const net = NETWORKS[network];
  const log = getLogger(`sweep-recon:${network}`, { "chain.network": network });

  if (!env.sweepReconEnabled && !env.sweepEnabled) return;
  if (net.family !== "evm") {
    log.debug("reconciliation not started — no balance reader for this family yet", {
      "chain.family": net.family,
    });
    return;
  }

  // Rotates across ticks so a deployment with more addresses than the per-tick
  // cap still covers all of them, just over a longer cycle.
  let cursor = 0;

  log.info("sweep reconciliation started", {
    "worker.interval_s": env.sweepReconIntervalSec,
    "sweep.recon_max_addresses": env.sweepReconMaxAddresses,
  });

  async function reconcile() {
    const all = await expectations(network);
    if (all.length === 0) {
      log.trace("nothing to reconcile");
      return;
    }

    const cap = env.sweepReconMaxAddresses;
    if (cursor >= all.length) cursor = 0;
    const batch = all.slice(cursor, cursor + cap);
    const covered = cursor + batch.length;
    cursor = covered >= all.length ? 0 : covered;

    const [live, onChain] = await Promise.all([inFlight(network), balances(network, batch)]);
    clearRpcError(`sweep-recon:${network}`);

    let drifting = 0;
    let unreadable = 0;
    const unswept = new Map<string, bigint>();

    for (const [i, item] of batch.entries()) {
      const balance = onChain[i];
      if (balance === null || balance === undefined) {
        unreadable++;
        continue;
      }

      unswept.set(item.asset, (unswept.get(item.asset) ?? 0n) + balance);

      const pending = live.get(`${item.address}/${item.asset}`) ?? 0n;
      const drift = balance - item.expectedRaw;
      if (drift === 0n) continue;

      // A balance still covered by an in-flight sweep is expected, not drift.
      if (drift < 0n && -drift <= pending) continue;

      drifting++;
      const surplus = drift > 0n;
      log.warn(
        surplus
          ? "reconciliation drift — the address holds more than the ledger accounts for"
          : "reconciliation drift — the address holds less than the ledger expects",
        {
          "sweep.address": item.address,
          "sweep.asset": item.asset,
          "sweep.balance_raw": balance,
          "sweep.expected_raw": item.expectedRaw,
          "sweep.drift_raw": drift,
          "sweep.in_flight_raw": pending,
          "token.decimals": item.decimals,
          hint: surplus
            ? "value arrived without a matching confirmed deposit — a transfer no watcher saw, " +
              "possibly on a chain this gateway does not serve"
            : "value left without a matching confirmed sweep",
        }
      );
    }

    for (const [asset, raw] of unswept) {
      gauge("sweeps.unswept_value_raw", Number(raw), { network, asset });
    }
    count("sweeps.recon_drift", { network }, drifting);

    log.info("reconciliation complete", {
      "sweep.recon_addresses": batch.length,
      "sweep.recon_total": all.length,
      // Named rather than implied: a capped tick covered a subset, and reporting
      // the remainder is what stops a bounded audit from reading as a full one.
      "sweep.recon_deferred": Math.max(0, all.length - batch.length),
      "sweep.recon_drifting": drifting,
      "sweep.recon_unreadable": unreadable,
    });
  }

  const tick = () =>
    withContext(
      { attributes: { "chain.network": network, "worker.name": "sweep-recon" } },
      async () => {
        try {
          await reconcile();
        } catch (e) {
          logRpcError(`sweep-recon:${network}`, e);
        }
      }
    );

  void tick();
  setInterval(tick, env.sweepReconIntervalSec * 1000);
}
