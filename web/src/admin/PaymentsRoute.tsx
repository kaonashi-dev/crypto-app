import { createEffect, createSignal, For, onCleanup, Show, Switch, Match } from "solid-js";
import { Link, useNavigate, useSearch } from "@tanstack/solid-router";
import { useQuery } from "@tanstack/solid-query";
import type { PaymentStatus } from "../lib/status";
import { now, refreshInterval } from "./console";
import {
  fetchClients,
  fetchPayments,
  fetchStats,
  fmtCop,
  fmtRelative,
  fmtTime,
  fmtUnits,
  paidPct,
  type PaymentRow,
} from "./api";
import {
  Empty,
  Meter,
  PageButton,
  Panel,
  SearchInput,
  Select,
  StatTile,
  StatusBadge,
  StatusMark,
  STATUS_META,
} from "./ui";

const PAGE = 50;

/**
 * Status mix across every payment, as one bar.
 *
 * Doubles as the status filter: the segments and the legend below them are the
 * same control, so the overview and the way you drill into it are one element
 * rather than two. Segments carry a 2px surface gap so adjacent fills stay
 * separable, and each is labelled in the legend — never colour alone.
 */
function StatusBar(props: {
  byStatus: Record<PaymentStatus, number>;
  total: number;
  active: string;
  onPick: (status: string | undefined) => void;
}) {
  const statuses = () => Object.keys(props.byStatus) as PaymentStatus[];
  const present = () => statuses().filter((st) => props.byStatus[st] > 0);

  return (
    <div class="px-4 py-3.5">
      <div class="flex h-[7px] gap-[2px] overflow-hidden rounded-[4px] bg-baseline">
        <Show when={props.total > 0} fallback={<span class="w-full" />}>
          <For each={present()}>
            {(st) => (
              <button
                type="button"
                onClick={() => props.onPick(props.active === st ? undefined : st)}
                aria-label={`Filter by ${STATUS_META[st].label} (${props.byStatus[st]})`}
                title={`${STATUS_META[st].label}: ${props.byStatus[st]} of ${props.total}`}
                class={`h-full min-w-[4px] cursor-pointer rounded-[3px] transition-opacity ${
                  STATUS_META[st].bg
                } ${
                  props.active && props.active !== st ? "opacity-25" : "hover:opacity-80"
                } focus-visible:ring-2 focus-visible:ring-ink-2 focus-visible:outline-none`}
                style={{ "flex-grow": props.byStatus[st] }}
              />
            )}
          </For>
        </Show>
      </div>

      <div class="mt-3 flex flex-wrap gap-x-5 gap-y-2">
        <For each={statuses()}>
          {(st) => (
            <button
              type="button"
              onClick={() => props.onPick(props.active === st ? undefined : st)}
              aria-pressed={props.active === st}
              class={`flex cursor-pointer items-center gap-2 rounded px-1 text-[0.75rem] transition-colors focus-visible:ring-2 focus-visible:ring-ink-2 focus-visible:outline-none ${
                props.active === st
                  ? "text-ink"
                  : props.byStatus[st] > 0
                    ? "text-ink-2 hover:text-ink"
                    : "text-ink-3/50"
              }`}
            >
              <StatusMark status={st} size={8} />
              <span>{STATUS_META[st].label}</span>
              <span class="tabular-nums">{props.byStatus[st]}</span>
            </button>
          )}
        </For>
      </div>
    </div>
  );
}

/** Which clock a row is running against, and how long is left on it. */
function deadlineCell(p: PaymentRow, at: number) {
  if (p.status === "paid") {
    return { label: "settled", value: fmtRelative(p.paid_at, at), tone: "text-ok" };
  }
  if (p.status === "expired" || p.status === "underpaid_expired") {
    return { label: "closed", value: "—", tone: "text-ink-3" };
  }
  const target = p.grace_expires_at ?? p.quote_expires_at;
  return {
    label: p.grace_expires_at ? "grace" : "quote",
    value: fmtRelative(target, at),
    tone: new Date(target).getTime() < at ? "text-critical" : "text-ink-2",
  };
}

function PaymentsTable(props: { rows: PaymentRow[] }) {
  return (
    <div class="overflow-x-auto">
      <table class="w-full min-w-[980px] border-collapse text-left">
        <thead>
          <tr class="border-b border-hairline text-[0.66rem] tracking-[0.12em] text-ink-3 uppercase">
            <th class="px-4 py-2.5 font-medium">Created</th>
            <th class="px-4 py-2.5 font-medium">Payment</th>
            <th class="px-4 py-2.5 font-medium">Merchant</th>
            <th class="px-4 py-2.5 font-medium">Status</th>
            <th class="px-4 py-2.5 text-right font-medium">Amount</th>
            <th class="w-[168px] px-4 py-2.5 font-medium">Received</th>
            <th class="px-4 py-2.5 font-medium">Chain</th>
            <th class="px-4 py-2.5 text-right font-medium">Deadline</th>
          </tr>
        </thead>
        <tbody>
          <For each={props.rows}>
            {(p) => {
              const pct = () => paidPct(p.confirmed_raw, p.amount_crypto_raw);
              const order = () => (p.metadata as { order_id?: string } | null)?.order_id;
              const deadline = () => deadlineCell(p, now());
              return (
                <tr class="border-b border-hairline/70 transition-colors hover:bg-plane/60">
                  <td class="px-4 py-3 align-top whitespace-nowrap">
                    <span class="text-[0.78rem] text-ink-2" title={fmtTime(p.created_at)}>
                      {fmtRelative(p.created_at, now())}
                    </span>
                  </td>

                  <td class="px-4 py-3 align-top">
                    <Link
                      to="/admin/p/$publicId"
                      params={{ publicId: p.id }}
                      class="font-mono text-[0.8rem] text-ink underline decoration-hairline underline-offset-3 transition-colors hover:decoration-ink-2 focus-visible:ring-2 focus-visible:ring-ink-2 focus-visible:outline-none"
                    >
                      {p.id}
                    </Link>
                    <Show when={order()}>
                      <p class="mt-0.5 text-[0.7rem] text-ink-3">{order()}</p>
                    </Show>
                  </td>

                  <td class="max-w-[150px] truncate px-4 py-3 align-top text-[0.78rem] text-ink-2">
                    {p.client_name}
                  </td>

                  <td class="px-4 py-3 align-top">
                    <StatusBadge status={p.status} />
                  </td>

                  <td class="px-4 py-3 text-right align-top whitespace-nowrap">
                    <span class="text-[0.82rem] text-ink tabular-nums">
                      ${fmtCop(p.amount_cop)}
                    </span>
                    <p class="mt-0.5 font-mono text-[0.7rem] text-ink-3 tabular-nums">
                      {fmtUnits(p.amount_crypto_raw, p.decimals)} {p.asset}
                    </p>
                  </td>

                  <td class="px-4 py-3 align-top">
                    <Meter
                      pct={pct()}
                      status={p.status}
                      title={`${fmtUnits(p.confirmed_raw, p.decimals)} of ${fmtUnits(
                        p.amount_crypto_raw,
                        p.decimals
                      )} ${p.asset} confirmed`}
                    />
                    <p class="mt-1.5 font-mono text-[0.7rem] text-ink-3 tabular-nums">
                      {pct().toFixed(1)}%
                      <Show when={BigInt(p.pending_raw) > 0n}>
                        <span class="text-warn">
                          {" "}
                          +{fmtUnits(p.pending_raw, p.decimals)} pending
                        </span>
                      </Show>
                    </p>
                  </td>

                  <td class="px-4 py-3 align-top whitespace-nowrap">
                    <span class="text-[0.76rem] text-ink-2">{p.network}</span>
                    <p class="mt-0.5 text-[0.7rem] text-ink-3">
                      {p.deposits} {p.deposits === 1 ? "deposit" : "deposits"}
                    </p>
                  </td>

                  <td class="px-4 py-3 text-right align-top whitespace-nowrap">
                    <span class={`text-[0.78rem] ${deadline().tone}`}>{deadline().value}</span>
                    <p class="mt-0.5 text-[0.68rem] tracking-wide text-ink-3">
                      {deadline().label}
                    </p>
                  </td>
                </tr>
              );
            }}
          </For>
        </tbody>
      </table>
    </div>
  );
}

export function PaymentsRoute() {
  const search = useSearch({ from: "/admin/" });
  const navigate = useNavigate();

  const offset = () => search().offset ?? 0;
  const filters = () => ({
    status: search().status,
    network: search().network,
    client_id: search().client,
    q: search().q,
  });

  /** Changing a filter always returns to the first page; paging keeps the filters. */
  const filterBy = (patch: Record<string, string | undefined>) =>
    navigate({
      to: "/admin",
      search: (prev) => ({ ...prev, ...patch, offset: undefined }),
    });

  const goToOffset = (next: number) =>
    navigate({ to: "/admin", search: (prev) => ({ ...prev, offset: next || undefined }) });

  // The search box writes to the URL, but not on every keystroke: each one would
  // be a query against payments, deposits and metadata.
  const [draft, setDraft] = createSignal(search().q ?? "");
  createEffect(() => setDraft(search().q ?? ""));

  let debounce: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(debounce));
  const onSearch = (value: string) => {
    setDraft(value);
    clearTimeout(debounce);
    debounce = setTimeout(
      () =>
        navigate({
          to: "/admin",
          search: (prev) => ({ ...prev, q: value || undefined, offset: undefined }),
          // Typing is not navigation: it should not bury the previous page in history.
          replace: true,
        }),
      300
    );
  };

  const stats = useQuery(() => ({
    queryKey: ["stats"],
    queryFn: fetchStats,
    refetchInterval: refreshInterval(),
  }));

  // Merchant list changes rarely; the filter dropdown does not need refreshing.
  const clients = useQuery(() => ({
    queryKey: ["clients"],
    queryFn: fetchClients,
    staleTime: 5 * 60_000,
  }));

  const payments = useQuery(() => ({
    queryKey: ["payments", filters(), offset()],
    queryFn: () => fetchPayments(filters(), PAGE, offset()),
    // Keep the previous page on screen while the next one loads: a table that
    // blanks out on every filter change makes the console feel slower than it is.
    placeholderData: (previous) => previous,
    refetchInterval: refreshInterval(),
  }));

  createEffect(() => {
    document.title = "Gateway console";
  });

  const statusOptions = () => [
    { value: "", label: "All statuses" },
    ...(stats.data?.statuses ?? []).map((st) => ({ value: st, label: STATUS_META[st].label })),
  ];
  const networkOptions = () => [
    { value: "", label: "All networks" },
    ...(stats.data?.networks ?? []).map((n) => ({ value: n.id, label: n.id })),
  ];
  // Re-running the seed and test scripts creates several merchants with the same
  // name, so a bare name list is unpickable. Busiest first, and only the
  // colliding names carry an id fragment to tell them apart.
  const clientOptions = () => {
    const rows = clients.data?.clients ?? [];
    const nameCounts = rows.reduce<Record<string, number>>((acc, cl) => {
      acc[cl.name] = (acc[cl.name] ?? 0) + 1;
      return acc;
    }, {});
    return [
      { value: "", label: "All merchants" },
      ...[...rows]
        .sort((a, b) => b.payments - a.payments)
        .map((cl) => ({
          value: cl.id,
          label: `${cl.name} · ${cl.payments}${
            (nameCounts[cl.name] ?? 0) > 1 ? ` · ${cl.id.slice(0, 8)}` : ""
          }`,
        })),
    ];
  };

  return (
    <div class="space-y-4">
      <Show when={stats.data}>
        {(st) => (
          <Panel
            title="Gateway"
            aside={
              <span class="hidden font-mono text-[0.68rem] text-ink-3 sm:block">
                quote {st().config.quote_ttl_min}m · grace {st().config.grace_ttl_min}m · spread{" "}
                {(st().config.spread_bps / 100).toFixed(2)}% · dust{" "}
                {(st().config.dust_bps / 100).toFixed(2)}%
              </span>
            }
          >
            <div class="grid grid-cols-2 divide-x divide-y divide-hairline sm:grid-cols-3 lg:grid-cols-5 lg:divide-y-0">
              <StatTile
                label="Payments"
                value={st().payments.total}
                sub={`${st().clients} ${st().clients === 1 ? "merchant" : "merchants"}`}
              />
              <StatTile
                label="Credited"
                value={`$${fmtCop(st().payments.paid_cop)}`}
                sub={`COP · ${st().payments.by_status.paid} paid`}
                tone="text-ok"
              />
              <StatTile
                label="Needs attention"
                value={st().payments.by_status.underpaid_expired}
                sub="underpaid, grace lapsed"
                tone={
                  st().payments.by_status.underpaid_expired > 0
                    ? "text-critical"
                    : "text-ink-3"
                }
              />
              <StatTile
                label="Deposits"
                value={st().deposits.total}
                sub={`${st().deposits.unconfirmed} awaiting confirmations`}
              />
              <StatTile
                label="Webhooks"
                value={st().webhooks.pending}
                sub={
                  st().webhooks.dead > 0
                    ? `queued · ${st().webhooks.dead} gave up`
                    : `queued · ${st().webhooks.delivered} delivered`
                }
                tone={st().webhooks.dead > 0 ? "text-critical" : "text-ink"}
              />
            </div>
            <div class="border-t border-hairline">
              <StatusBar
                byStatus={st().payments.by_status}
                total={st().payments.total}
                active={search().status ?? ""}
                onPick={(status) => filterBy({ status })}
              />
            </div>
          </Panel>
        )}
      </Show>

      <Panel
        title={`Payments${payments.data?.total ? ` · ${payments.data.total}` : ""}`}
        aside={
          <div class="flex flex-wrap items-center gap-2">
            <SearchInput
              value={draft()}
              onInput={onSearch}
              placeholder="id, address, tx hash, order_id"
            />
            <Select
              label="Status"
              value={search().status ?? ""}
              onChange={(status) => filterBy({ status: status || undefined })}
              options={statusOptions()}
            />
            <Select
              label="Network"
              value={search().network ?? ""}
              onChange={(network) => filterBy({ network: network || undefined })}
              options={networkOptions()}
            />
            <Select
              label="Merchant"
              value={search().client ?? ""}
              onChange={(client) => filterBy({ client: client || undefined })}
              options={clientOptions()}
            />
          </div>
        }
      >
        <Switch>
          <Match when={payments.isError}>
            <Empty>Could not load payments: {String(payments.error?.message ?? "")}</Empty>
          </Match>
          <Match when={!payments.data}>
            <Empty>Loading…</Empty>
          </Match>
          <Match when={payments.data!.payments.length === 0}>
            <Empty>
              No payments match these filters. Create one with{" "}
              <span class="font-mono text-ink-2">bun run scripts/create-payment.ts</span>.
            </Empty>
          </Match>
          <Match when={payments.data}>
            {(data) => (
              <>
                <PaymentsTable rows={data().payments} />
                <Show when={data().total > PAGE}>
                  <footer class="flex items-center justify-between border-t border-hairline px-4 py-2.5 text-[0.75rem] text-ink-3">
                    <span class="tabular-nums">
                      {offset() + 1}–{Math.min(offset() + PAGE, data().total)} of {data().total}
                    </span>
                    <span class="flex gap-2">
                      <PageButton
                        disabled={offset() === 0}
                        onClick={() => goToOffset(Math.max(offset() - PAGE, 0))}
                      >
                        Newer
                      </PageButton>
                      <PageButton
                        disabled={offset() + PAGE >= data().total}
                        onClick={() => goToOffset(offset() + PAGE)}
                      >
                        Older
                      </PageButton>
                    </span>
                  </footer>
                </Show>
              </>
            )}
          </Match>
        </Switch>
      </Panel>
    </div>
  );
}
