import { For, Show } from "solid-js";
import { useQuery } from "@tanstack/solid-query";
import { refreshInterval } from "./console";
import { fetchStats, fetchWallets, fmtUnits, type NetworkWallets, type WalletInfo } from "./api";
import { Empty, Hash, Panel } from "./ui";

/**
 * What the gateway's own wallets hold, read from the chain.
 *
 * Two addresses that no table can show, and that between them answer most of
 * "why has nothing swept":
 *
 *  - the **treasury**, where swept value lands. The gateway holds no key for it,
 *    so this is the one place its balance is visible at all — the `sweeps`
 *    ledger asserts the money arrived, and only this proves it.
 *  - the **relayer**, which pays gas for sweeps out of deposit addresses that
 *    hold no native balance of their own. An empty relayer plans sweeps forever
 *    and broadcasts none of them, and nothing in the database hints at it.
 *
 * The only console view that costs metered RPC calls, so readings are cached
 * server-side for 30s and the panel says how stale they are rather than
 * pretending to be live.
 */

/** Unknown and zero must never look the same here — that is the whole point. */
function Balances(props: { wallet: WalletInfo; needsGas: boolean }) {
  return (
    <Show
      when={props.wallet.balances.length > 0}
      fallback={
        <span class="text-[0.76rem] text-ink-3">{props.wallet.note ?? "no balances read"}</span>
      }
    >
      <div class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <For each={props.wallet.balances}>
          {(b) => {
            const empty = () => BigInt(b.raw) === 0n;
            // An empty relayer is the actionable case: it is not "a wallet with
            // nothing in it", it is "sweeps cannot be broadcast".
            const alarming = () => props.needsGas && b.is_fee_currency && empty();
            return (
              <span
                class={`font-mono text-[0.78rem] tabular-nums ${
                  alarming() ? "text-critical" : empty() ? "text-ink-3" : "text-ink"
                }`}
              >
                {fmtUnits(b.raw, b.decimals)}{" "}
                <span class="text-ink-2">{b.asset}</span>
                <Show when={alarming()}>
                  <span class="ml-1.5 font-sans text-[0.7rem]">· needs gas</span>
                </Show>
              </span>
            );
          }}
        </For>
      </div>
    </Show>
  );
}

function NetworkRow(props: { net: NetworkWallets; explorer?: string; live: boolean }) {
  return (
    <div class="border-b border-hairline/70 px-4 py-3 last:border-b-0">
      <div class="flex items-baseline gap-2">
        <span class="font-mono text-[0.78rem] text-ink">{props.net.network}</span>
        <Show when={!props.net.reachable}>
          <span class="text-[0.7rem] text-warn">· {props.net.error}</span>
        </Show>
      </div>

      <div class="mt-2 grid gap-2 sm:grid-cols-[6rem_minmax(0,14rem)_1fr] sm:items-baseline sm:gap-x-4">
        <For each={props.net.wallets}>
          {(w) => (
            <>
              <span class="text-[0.66rem] tracking-[0.12em] text-ink-3 uppercase">{w.role}</span>
              <span class="min-w-0">
                <Show
                  when={w.address}
                  fallback={<span class="text-[0.76rem] text-ink-3">—</span>}
                >
                  <Hash
                    value={w.address!}
                    explorer={props.explorer}
                    kind="address"
                    head={10}
                    tail={8}
                  />
                </Show>
              </span>
              <span class="min-w-0">
                <Balances
                  wallet={w}
                  needsGas={props.live && w.role === "relayer" && props.net.reachable}
                />
                <Show when={w.address && w.note && w.balances.length > 0}>
                  <p class="mt-0.5 text-[0.68rem] text-ink-3">{w.note}</p>
                </Show>
              </span>
            </>
          )}
        </For>
      </div>
    </div>
  );
}

export function WalletsPanel() {
  const wallets = useQuery(() => ({
    queryKey: ["wallets"],
    queryFn: fetchWallets,
    placeholderData: (previous) => previous,
    // The server caches for 30s regardless, so a faster console cadence would
    // only re-serve the same reading.
    refetchInterval: Math.max(refreshInterval() || 0, 30_000),
  }));

  const stats = useQuery(() => ({
    queryKey: ["stats"],
    queryFn: fetchStats,
    refetchInterval: refreshInterval(),
  }));

  const explorerFor = (id: string) =>
    stats.data?.networks.find((n) => n.id === id)?.explorer.address;

  // Only when sweeping can actually broadcast is an empty relayer a problem;
  // in dry run nothing is ever signed, so it holding no gas is expected.
  const live = () => Boolean(wallets.data?.sweep.enabled && !wallets.data.sweep.dry_run);

  return (
    <Panel
      title="Wallets"
      aside={
        <Show when={wallets.data}>
          {(w) => (
            <span class="hidden font-mono text-[0.68rem] text-ink-3 sm:block">
              read {w().age_s}s ago · cached {w().cache_ttl_s}s · signer {w().sweep.signer}
            </span>
          )}
        </Show>
      }
    >
      <Show
        when={wallets.data}
        fallback={
          <Empty>
            {wallets.isError
              ? `Could not read wallet balances: ${String(wallets.error?.message ?? "")}`
              : "Reading balances…"}
          </Empty>
        }
      >
        <For each={wallets.data!.networks}>
          {(net) => (
            <NetworkRow net={net} explorer={explorerFor(net.network)} live={live()} />
          )}
        </For>
      </Show>
    </Panel>
  );
}
