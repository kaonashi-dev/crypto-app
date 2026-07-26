import { createEffect, createSignal, For, onCleanup, Show, Switch, Match } from "solid-js";
import { Link, useNavigate, useSearch } from "@tanstack/solid-router";
import { useQuery } from "@tanstack/solid-query";
import { now, refreshInterval } from "./console";
import { fetchDeposits, fetchStats, fmtRelative, fmtTime, fmtUnits } from "./api";
import { Empty, Hash, Panel, SearchInput, Select, StatusBadge } from "./ui";

/**
 * Every Transfer the watchers have recorded, newest first.
 *
 * This is the view that answers "did the watcher see my transfer at all?" — a
 * deposit can be recorded with no effect on its payment (it landed after the
 * grace window, or in a terminal state), which the payments list alone would
 * never reveal.
 */
export function DepositsRoute() {
  const search = useSearch({ from: "/admin/deposits" });
  const navigate = useNavigate();

  const filterBy = (patch: Record<string, string | undefined>, replace = false) =>
    navigate({ to: "/admin/deposits", search: (prev) => ({ ...prev, ...patch }), replace });

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

  const deposits = useQuery(() => ({
    queryKey: ["deposits", search()],
    queryFn: () =>
      fetchDeposits({
        network: search().network,
        confirmed: search().confirmed,
        q: search().q,
      }),
    placeholderData: (previous) => previous,
    refetchInterval: refreshInterval(),
  }));

  createEffect(() => {
    document.title = "Deposits · console";
  });

  const explorerFor = (id: string) => stats.data?.networks.find((n) => n.id === id)?.explorer;

  return (
    <Panel
      title={`On-chain deposits${deposits.data ? ` · ${deposits.data.deposits.length}` : ""}`}
      aside={
        <div class="flex flex-wrap items-center gap-2">
          <SearchInput
            value={draft()}
            onInput={onSearch}
            placeholder="tx hash, sender, payment id"
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
            label="Confirmation state"
            value={search().confirmed ?? ""}
            onChange={(confirmed) => filterBy({ confirmed: confirmed || undefined })}
            options={[
              { value: "", label: "Any state" },
              { value: "false", label: "Confirming" },
              { value: "true", label: "Confirmed" },
            ]}
          />
        </div>
      }
    >
      <Switch>
        <Match when={deposits.isError}>
          <Empty>Could not load deposits: {String(deposits.error?.message ?? "")}</Empty>
        </Match>
        <Match when={!deposits.data}>
          <Empty>Loading…</Empty>
        </Match>
        <Match when={deposits.data!.deposits.length === 0}>
          <Empty>
            Nothing recorded yet. The watcher writes a row the moment it sees a Transfer to one
            of our addresses.
          </Empty>
        </Match>
        <Match when={deposits.data}>
          <div class="overflow-x-auto">
            <table class="w-full min-w-[900px] border-collapse text-left">
              <thead>
                <tr class="border-b border-hairline text-[0.66rem] tracking-[0.12em] text-ink-3 uppercase">
                  <th class="px-4 py-2.5 font-medium">Seen</th>
                  <th class="px-4 py-2.5 font-medium">Transaction</th>
                  <th class="px-4 py-2.5 font-medium">From</th>
                  <th class="px-4 py-2.5 text-right font-medium">Amount</th>
                  <th class="px-4 py-2.5 font-medium">Payment</th>
                  <th class="px-4 py-2.5 font-medium">Payment status</th>
                  <th class="px-4 py-2.5 text-right font-medium">Block</th>
                  <th class="px-4 py-2.5 text-right font-medium">State</th>
                </tr>
              </thead>
              <tbody>
                <For each={deposits.data!.deposits}>
                  {(d) => (
                    <tr class="border-b border-hairline/70 transition-colors hover:bg-plane/60">
                      <td
                        class="px-4 py-3 text-[0.76rem] whitespace-nowrap text-ink-2"
                        title={fmtTime(d.created_at)}
                      >
                        {fmtRelative(d.created_at, now())}
                      </td>
                      <td class="max-w-[210px] px-4 py-3">
                        <Hash
                          value={d.tx_hash}
                          explorer={explorerFor(d.network)?.tx}
                          kind="transaction"
                        />
                        <p class="mt-0.5 text-[0.68rem] text-ink-3">
                          {d.network} · log {d.log_index}
                        </p>
                      </td>
                      <td class="max-w-[170px] px-4 py-3">
                        <Hash
                          value={d.from_address}
                          explorer={explorerFor(d.network)?.address}
                          kind="address"
                          head={8}
                          tail={6}
                        />
                      </td>
                      <td class="px-4 py-3 text-right font-mono text-[0.78rem] whitespace-nowrap text-ink tabular-nums">
                        {fmtUnits(d.amount_raw, d.decimals)} {d.asset}
                      </td>
                      <td class="px-4 py-3">
                        <Link
                          to="/admin/p/$publicId"
                          params={{ publicId: d.payment_id }}
                          class="font-mono text-[0.78rem] text-ink underline decoration-hairline underline-offset-3 transition-colors hover:decoration-ink-2 focus-visible:ring-2 focus-visible:ring-ink-2 focus-visible:outline-none"
                        >
                          {d.payment_id}
                        </Link>
                      </td>
                      <td class="px-4 py-3">
                        <StatusBadge status={d.payment_status} />
                      </td>
                      <td class="px-4 py-3 text-right font-mono text-[0.76rem] text-ink-2 tabular-nums">
                        {BigInt(d.block_number).toLocaleString("en-US")}
                      </td>
                      <td class="px-4 py-3 text-right whitespace-nowrap">
                        <Show
                          when={d.confirmed}
                          fallback={
                            <span class="inline-flex items-center gap-1.5 text-[0.76rem] text-warn">
                              <span
                                class="inline-block h-[9px] w-[9px] rounded-full border-[1.5px] border-warn"
                                aria-hidden
                              />
                              confirming
                            </span>
                          }
                        >
                          <span class="inline-flex items-center gap-1.5 text-[0.76rem] text-ok">
                            <span
                              class="inline-block h-[9px] w-[9px] rounded-full bg-ok"
                              aria-hidden
                            />
                            confirmed
                          </span>
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
  );
}
