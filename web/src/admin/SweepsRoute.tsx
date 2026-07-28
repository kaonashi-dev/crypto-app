import { createEffect, createSignal, For, onCleanup, Show, Switch, Match } from "solid-js";
import { useNavigate, useSearch } from "@tanstack/solid-router";
import { useQuery } from "@tanstack/solid-query";
import { now, refreshInterval } from "./console";
import {
  fetchStats,
  fetchSweeps,
  fmtRelative,
  fmtTime,
  fmtUnits,
  type SweepRow,
  type SweepStatus,
} from "./api";
import { Empty, Hash, Panel, SearchInput, Select, StatTile } from "./ui";
import { WalletsPanel } from "./WalletsPanel";

/**
 * Consolidation of deposit addresses into the treasury.
 *
 * Read-only, like the whole console. There is no "sweep now" button and that is
 * deliberate: /admin takes no mutation without an audit model behind it, and a
 * console control that moves money is the last place to make that exception.
 *
 * The column that matters most is `reason`. Most rows here are *deferrals* —
 * value below the floor, gas too expensive for what it would move, a mechanism
 * not yet implemented — and every one of them is normal operation rather than a
 * queue backing up. A sweep is retried until it works or dead-letters; a skip is
 * simply re-evaluated on the next tick.
 */

/**
 * Sweep status presentation. Deliberately not `STATUS_META` from ui.tsx: that
 * one is the *payment* lifecycle, and conflating the two vocabularies would let
 * a change to one silently restyle the other.
 */
const SWEEP_META: Record<SweepStatus, { label: string; text: string; border: string; solid: boolean }> = {
  planned: { label: "planned", text: "text-ink-3", border: "border-ink-3", solid: false },
  authorized: { label: "authorized", text: "text-warn", border: "border-warn", solid: false },
  broadcast: { label: "broadcast", text: "text-warn", border: "border-warn", solid: true },
  confirmed: { label: "confirmed", text: "text-ok", border: "border-ok", solid: true },
  failed: { label: "failed", text: "text-critical", border: "border-critical", solid: true },
  skipped: { label: "deferred", text: "text-ink-3", border: "border-ink-3", solid: false },
};

/** Deferral reasons, in operator language rather than enum language. */
const REASON_COPY: Record<string, string> = {
  below_floor: "below the sweep floor — accumulating",
  fee_too_high: "fee would exceed the cost ceiling",
  gas_ceiling: "gas price above the ceiling",
  no_treasury: "no treasury address configured",
  unpriceable: "no rate available — never swept blind",
  unimplemented: "mechanism not implemented yet",
  authorization_already_used: "settled by an earlier attempt",
};

function SweepBadge(props: { status: SweepStatus }) {
  const meta = () => SWEEP_META[props.status];
  return (
    <span class={`inline-flex items-center gap-2 whitespace-nowrap text-[0.8rem] ${meta().text}`}>
      <span
        aria-hidden
        class={`inline-block h-[9px] w-[9px] shrink-0 rounded-full border-[1.5px] ${meta().border} ${
          meta().solid ? "bg-current" : ""
        }`}
      />
      {meta().label}
    </span>
  );
}

export function SweepsRoute() {
  const search = useSearch({ from: "/admin/sweeps" });
  const navigate = useNavigate();

  const filterBy = (patch: Record<string, string | undefined>, replace = false) =>
    navigate({ to: "/admin/sweeps", search: (prev) => ({ ...prev, ...patch }), replace });

  const [draft, setDraft] = createSignal(search().q ?? "");
  createEffect(() => setDraft(search().q ?? ""));

  let debounce: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(debounce));
  const onSearch = (value: string) => {
    setDraft(value);
    clearTimeout(debounce);
    debounce = setTimeout(() => filterBy({ q: value || undefined }, true), 300);
  };

  const stats = useQuery(() => ({
    queryKey: ["stats"],
    queryFn: fetchStats,
    refetchInterval: refreshInterval(),
  }));

  const sweeps = useQuery(() => ({
    queryKey: ["sweeps", search()],
    queryFn: () =>
      fetchSweeps({ network: search().network, status: search().status, q: search().q }),
    placeholderData: (previous) => previous,
    refetchInterval: refreshInterval(),
  }));

  createEffect(() => {
    document.title = "Sweeps · console";
  });

  const explorerFor = (id: string) => stats.data?.networks.find((n) => n.id === id)?.explorer;
  const config = () => stats.data?.config;
  const unswept = () => (stats.data?.sweeps.unswept ?? []).filter((r) => BigInt(r.unswept_raw) > 0n);

  const feeOf = (s: SweepRow) =>
    s.fee_raw ? `${fmtUnits(s.fee_raw, s.fee_decimals)} ${s.fee_asset}` : "—";

  return (
    <div class="flex flex-col gap-6">
      {/* What is still sitting at deposit addresses, per pairing. The number the
          whole subsystem exists to drive down. */}
      <Show when={unswept().length > 0}>
        <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
          <For each={unswept()}>
            {(row) => (
              <StatTile
                label={`unswept · ${row.network}`}
                value={`${fmtUnits(row.unswept_raw, row.decimals)} ${row.asset}`}
                sub={`${fmtUnits(row.swept_raw, row.decimals)} swept of ${fmtUnits(
                  row.confirmed_raw,
                  row.decimals
                )} confirmed`}
              />
            )}
          </For>
        </div>
      </Show>

      <Show when={config()}>
        {(cfg) => (
          <Show
            when={cfg().sweep_enabled}
            fallback={
              <p class="rounded-sm border border-hairline bg-plane/60 px-4 py-3 text-[0.8rem] text-ink-2">
                Sweeping is <span class="text-ink">off</span>. Nothing is planned, signed or
                broadcast, and funds accumulate at deposit addresses — which is how this gateway
                has always behaved. Set <code class="font-mono text-ink">SWEEP_ENABLED</code> to
                plan sweeps.
                <Show when={cfg().sweep_pairings.length === 0}>
                  {" "}
                  No pairing in the registry declares a sweep mechanism yet, so nothing would be
                  planned even then.
                </Show>
              </p>
            }
          >
            <p class="rounded-sm border border-hairline bg-plane/60 px-4 py-3 text-[0.8rem] text-ink-2">
              <Show
                when={cfg().sweep_dry_run}
                fallback={
                  <>
                    Sweeping is <span class="text-ok">live</span>.
                  </>
                }
              >
                <>
                  Sweeping is in <span class="text-warn">dry run</span> — candidates are planned
                  and recorded, never signed.
                </>
              </Show>{" "}
              Floor {cfg().sweep_min_usd} USD · fee ceiling{" "}
              {(cfg().sweep_max_cost_bps / 100).toFixed(2)}% of value ·{" "}
              {cfg().sweep_pairings.length
                ? cfg().sweep_pairings.join(", ")
                : "no sweepable pairings in the registry"}
            </p>
          </Show>
        )}
      </Show>

      {/* Where the money goes and who pays the gas — read from the chain, not
          from our own ledger, so it can corroborate it rather than repeat it. */}
      <WalletsPanel />

      <Panel
        title={`Treasury sweeps${sweeps.data ? ` · ${sweeps.data.total}` : ""}`}
        aside={
          <div class="flex flex-wrap items-center gap-2">
            <SearchInput
              value={draft()}
              onInput={onSearch}
              placeholder="address, tx hash, treasury"
            />
            <Select
              label="Network"
              value={search().network ?? ""}
              onChange={(network) => filterBy({ network: network || undefined })}
              options={[
                { value: "", label: "All networks" },
                ...(stats.data?.networks ?? []).map((n) => ({ value: n.id, label: n.id })),
              ]}
            />
            <Select
              label="Status"
              value={search().status ?? ""}
              onChange={(status) => filterBy({ status: status || undefined })}
              options={[
                { value: "", label: "Any status" },
                ...(sweeps.data?.statuses ?? []).map((st) => ({
                  value: st,
                  label: SWEEP_META[st].label,
                })),
              ]}
            />
          </div>
        }
      >
        <Switch>
          <Match when={sweeps.isError}>
            <Empty>Could not load sweeps: {String(sweeps.error?.message ?? "")}</Empty>
          </Match>
          <Match when={!sweeps.data}>
            <Empty>Loading…</Empty>
          </Match>
          <Match when={sweeps.data!.sweeps.length === 0}>
            <Empty>
              No sweeps recorded. A row appears here as soon as confirmed value at a deposit
              address clears the policy — or is deferred by it, with the reason.
            </Empty>
          </Match>
          <Match when={sweeps.data}>
            <div class="overflow-x-auto">
              <table class="w-full min-w-[980px] border-collapse text-left">
                <thead>
                  <tr class="border-b border-hairline text-[0.66rem] tracking-[0.12em] text-ink-3 uppercase">
                    <th class="px-4 py-2.5 font-medium">Updated</th>
                    <th class="px-4 py-2.5 font-medium">From</th>
                    <th class="px-4 py-2.5 text-right font-medium">Amount</th>
                    <th class="px-4 py-2.5 font-medium">To</th>
                    <th class="px-4 py-2.5 font-medium">Via</th>
                    <th class="px-4 py-2.5 font-medium">Transaction</th>
                    <th class="px-4 py-2.5 text-right font-medium">Fee</th>
                    <th class="px-4 py-2.5 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={sweeps.data!.sweeps}>
                    {(s) => (
                      <tr class="border-b border-hairline/70 transition-colors hover:bg-plane/60">
                        <td
                          class="px-4 py-3 text-[0.76rem] whitespace-nowrap text-ink-2"
                          title={fmtTime(s.updated_at)}
                        >
                          {fmtRelative(s.updated_at, now())}
                        </td>
                        <td class="max-w-[190px] px-4 py-3">
                          <Hash
                            value={s.address}
                            explorer={explorerFor(s.network)?.address}
                            kind="address"
                            head={8}
                            tail={6}
                          />
                          <p class="mt-0.5 text-[0.68rem] text-ink-3">
                            {s.network} · index {s.derivation_index}
                          </p>
                        </td>
                        <td class="px-4 py-3 text-right font-mono text-[0.78rem] whitespace-nowrap text-ink tabular-nums">
                          {fmtUnits(s.amount_raw, s.decimals)} {s.asset}
                        </td>
                        <td class="max-w-[170px] px-4 py-3">
                          <Hash
                            value={s.to_address}
                            explorer={explorerFor(s.network)?.address}
                            kind="address"
                            head={8}
                            tail={6}
                          />
                        </td>
                        <td class="px-4 py-3 font-mono text-[0.74rem] whitespace-nowrap text-ink-2">
                          {s.via}
                        </td>
                        <td class="max-w-[190px] px-4 py-3">
                          <Show
                            when={s.tx_hash}
                            fallback={<span class="text-[0.76rem] text-ink-3">—</span>}
                          >
                            <Hash
                              value={s.tx_hash!}
                              explorer={explorerFor(s.network)?.tx}
                              kind="transaction"
                            />
                          </Show>
                        </td>
                        <td class="px-4 py-3 text-right font-mono text-[0.74rem] whitespace-nowrap text-ink-2 tabular-nums">
                          {feeOf(s)}
                        </td>
                        <td class="px-4 py-3 whitespace-nowrap">
                          <SweepBadge status={s.status} />
                          <Show when={s.reason}>
                            <p class="mt-0.5 text-[0.68rem] text-ink-3">
                              {REASON_COPY[s.reason!] ?? s.reason}
                            </p>
                          </Show>
                          <Show when={s.attempts > 0}>
                            <p class="mt-0.5 text-[0.68rem] text-serious">
                              {s.attempts} attempt{s.attempts === 1 ? "" : "s"}
                              <Show when={s.last_error}> · {s.last_error}</Show>
                            </p>
                          </Show>
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </Match>
        </Switch>
      </Panel>
    </div>
  );
}
