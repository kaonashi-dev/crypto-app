import { createEffect, For, Show, Switch, Match, type JSX } from "solid-js";
import { Link, useParams } from "@tanstack/solid-router";
import { useQuery } from "@tanstack/solid-query";
import { now, refreshInterval } from "./console";
import {
  fetchPaymentDetail,
  fmtCop,
  fmtRate,
  fmtRelative,
  fmtTime,
  fmtUnits,
  paidPct,
  type PaymentDetail,
} from "./api";
import {
  Empty,
  Field,
  Hash,
  LifecycleRail,
  Meter,
  Panel,
  StatusBadge,
  STATUS_META,
} from "./ui";

/** Section heading inside a panel body, for the three explanatory tables. */
function TableHead(props: { cols: Array<{ label: string; align?: "right" }> }) {
  return (
    <thead>
      <tr class="border-b border-hairline text-[0.66rem] tracking-[0.12em] text-ink-3 uppercase">
        <For each={props.cols}>
          {(c) => (
            <th
              class={`px-4 py-2.5 font-medium ${
                c.align === "right" ? "text-right" : "text-left"
              }`}
            >
              {c.label}
            </th>
          )}
        </For>
      </tr>
    </thead>
  );
}

function ConfirmState(props: { confirmed: boolean }) {
  return (
    <Show
      when={props.confirmed}
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
        <span class="inline-block h-[9px] w-[9px] rounded-full bg-ok" aria-hidden />
        confirmed
      </span>
    </Show>
  );
}

function Deposits(props: { d: PaymentDetail }) {
  const payment = () => props.d.payment;
  return (
    <Panel
      title={`On-chain deposits · ${props.d.deposits.length}`}
      aside={
        <span class="text-[0.68rem] text-ink-3">
          {props.d.network?.confirmations ?? 0} confirmations required on {payment().network}
        </span>
      }
    >
      <Show
        when={props.d.deposits.length > 0}
        fallback={
          <Empty>
            No transfer recorded yet. The watcher writes a row here the moment it sees one.
          </Empty>
        }
      >
        <div class="overflow-x-auto">
          <table class="w-full min-w-[760px] border-collapse text-left">
            <TableHead
              cols={[
                { label: "Seen" },
                { label: "Transaction" },
                { label: "Log" },
                { label: "From" },
                { label: "Amount", align: "right" },
                { label: "Block", align: "right" },
                { label: "State", align: "right" },
              ]}
            />
            <tbody>
              <For each={props.d.deposits}>
                {(dep) => (
                  <tr class="border-b border-hairline/70">
                    <td
                      class="px-4 py-3 text-[0.76rem] whitespace-nowrap text-ink-2"
                      title={fmtTime(dep.created_at)}
                    >
                      {fmtRelative(dep.created_at, now())}
                    </td>
                    <td class="max-w-[220px] px-4 py-3">
                      <Hash
                        value={dep.tx_hash}
                        explorer={props.d.network?.explorer.tx}
                        kind="transaction"
                      />
                    </td>
                    <td class="px-4 py-3 font-mono text-[0.76rem] text-ink-3 tabular-nums">
                      {dep.log_index}
                    </td>
                    <td class="max-w-[180px] px-4 py-3">
                      <Hash
                        value={dep.from_address}
                        explorer={props.d.network?.explorer.address}
                        kind="address"
                        head={8}
                        tail={6}
                      />
                    </td>
                    <td class="px-4 py-3 text-right font-mono text-[0.78rem] whitespace-nowrap text-ink tabular-nums">
                      {fmtUnits(dep.amount_raw, payment().decimals)} {payment().asset}
                    </td>
                    <td class="px-4 py-3 text-right font-mono text-[0.76rem] text-ink-2 tabular-nums">
                      {BigInt(dep.block_number).toLocaleString("en-US")}
                    </td>
                    <td class="px-4 py-3 text-right whitespace-nowrap">
                      <ConfirmState confirmed={dep.confirmed} />
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
    </Panel>
  );
}

function Webhooks(props: { d: PaymentDetail }) {
  return (
    <Panel
      title={`Webhook deliveries · ${props.d.webhooks.length}`}
      aside={
        <span class="truncate font-mono text-[0.68rem] text-ink-3">
          {props.d.client.webhook_url ?? "no endpoint configured"}
        </span>
      }
    >
      <Show
        when={props.d.webhooks.length > 0}
        fallback={<Empty>No events enqueued for this payment yet.</Empty>}
      >
        <div class="overflow-x-auto">
          <table class="w-full min-w-[620px] border-collapse text-left">
            <TableHead
              cols={[
                { label: "Event" },
                { label: "Queued" },
                { label: "Attempts", align: "right" },
                { label: "Outcome", align: "right" },
              ]}
            />
            <tbody>
              <For each={props.d.webhooks}>
                {(w) => {
                  // deliverPendingWebhooks stops retrying at 8 attempts.
                  const gaveUp = () => !w.delivered_at && w.attempts >= 8;
                  return (
                    <tr class="border-b border-hairline/70">
                      <td class="px-4 py-3 font-mono text-[0.78rem] text-ink">{w.event}</td>
                      <td
                        class="px-4 py-3 text-[0.76rem] whitespace-nowrap text-ink-2"
                        title={fmtTime(w.created_at)}
                      >
                        {fmtRelative(w.created_at, now())}
                      </td>
                      <td class="px-4 py-3 text-right font-mono text-[0.76rem] text-ink-2 tabular-nums">
                        {w.attempts}
                      </td>
                      <td class="px-4 py-3 text-right text-[0.76rem] whitespace-nowrap">
                        <Switch>
                          <Match when={w.delivered_at}>
                            <span class="text-ok" title={fmtTime(w.delivered_at)}>
                              delivered {fmtRelative(w.delivered_at, now())}
                            </span>
                          </Match>
                          <Match when={gaveUp()}>
                            <span class="text-critical">gave up after 8 attempts</span>
                          </Match>
                          <Match when={!w.delivered_at}>
                            <span class="text-warn" title={fmtTime(w.next_attempt_at)}>
                              retries {fmtRelative(w.next_attempt_at, now())}
                            </span>
                          </Match>
                        </Switch>
                      </td>
                    </tr>
                  );
                }}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
    </Panel>
  );
}

function Ledger(props: { d: PaymentDetail }) {
  return (
    <Panel
      title={`Ledger · ${props.d.ledger.length}`}
      aside={
        <span class="text-[0.68rem] text-ink-3">
          {props.d.client.name} balance ${fmtCop(props.d.client.balance_cop)} COP
        </span>
      }
    >
      <Show
        when={props.d.ledger.length > 0}
        fallback={
          <Empty>No COP credited for this payment. Only a settled payment writes here.</Empty>
        }
      >
        <div class="overflow-x-auto">
          <table class="w-full min-w-[420px] border-collapse text-left">
            <TableHead
              cols={[
                { label: "Type" },
                { label: "When" },
                { label: "Amount COP", align: "right" },
              ]}
            />
            <tbody>
              <For each={props.d.ledger}>
                {(l) => (
                  <tr class="border-b border-hairline/70">
                    <td class="px-4 py-3 font-mono text-[0.78rem] text-ink">{l.type}</td>
                    <td class="px-4 py-3 text-[0.76rem] text-ink-2" title={fmtTime(l.created_at)}>
                      {fmtRelative(l.created_at, now())}
                    </td>
                    <td class="px-4 py-3 text-right font-mono text-[0.8rem] text-ok tabular-nums">
                      +{fmtCop(l.amount_cop)}
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
    </Panel>
  );
}

function BackLink(): JSX.Element {
  return (
    <Link
      to="/admin"
      class="mb-3 inline-block text-[0.78rem] text-ink-3 transition-colors hover:text-ink focus-visible:ring-2 focus-visible:ring-ink-2 focus-visible:outline-none"
    >
      ← All payments
    </Link>
  );
}

export function PaymentDetailRoute() {
  const params = useParams({ from: "/admin/p/$publicId" });
  const publicId = () => params().publicId;

  const detail = useQuery(() => ({
    queryKey: ["payment", publicId()],
    queryFn: () => fetchPaymentDetail(publicId()),
    refetchInterval: refreshInterval(),
  }));

  createEffect(() => {
    document.title = `${publicId()} · console`;
  });

  return (
    <>
      <BackLink />
      <Switch>
        <Match when={detail.isError}>
          <Panel>
            <Empty>
              Could not load {publicId()}: {String(detail.error?.message ?? "")}
            </Empty>
          </Panel>
        </Match>
        <Match when={detail.isPending}>
          <Panel>
            <Empty>Loading…</Empty>
          </Panel>
        </Match>
        <Match when={detail.data === null}>
          <Panel>
            <Empty>
              No payment with id <span class="font-mono text-ink-2">{publicId()}</span>.
            </Empty>
          </Panel>
        </Match>
        <Match when={detail.data}>{(d) => <Detail d={d()} />}</Match>
      </Switch>
    </>
  );
}

function Detail(props: { d: PaymentDetail }) {
  const p = () => props.d.payment;
  const meta = () => STATUS_META[p().status];

  const required = () => BigInt(p().amount_crypto_raw);
  const confirmed = () => BigInt(p().confirmed_raw);
  const remaining = () => (required() > confirmed() ? required() - confirmed() : 0n);
  const pct = () => paidPct(p().confirmed_raw, p().amount_crypto_raw);

  // Only a live payment is running against a clock, and it runs against exactly
  // one: the grace window once a deposit opened it, the quote until then.
  const clock = () => {
    const status = p().status;
    if (status === "paid" || status === "expired" || status === "underpaid_expired") return null;
    const grace = p().grace_expires_at;
    return {
      label: grace ? "Grace window closes" : "Quote expires",
      at: grace ?? p().quote_expires_at,
    };
  };

  return (
    <div class="space-y-4">
      {/* Hero: the state machine, and where this payment sits on it. */}
      <Panel>
        <div class="flex flex-wrap items-start justify-between gap-4 px-4 pt-4">
          <div class="min-w-0">
            <p class="text-[0.66rem] tracking-[0.14em] text-ink-3 uppercase">Payment</p>
            <h1 class="mt-1 font-mono text-2xl text-ink">{p().id}</h1>
            <p class="mt-1.5 text-[0.78rem] text-ink-2">
              {props.d.client.name} · created {fmtRelative(p().created_at, now())}
              <span class="text-ink-3"> ({fmtTime(p().created_at)})</span>
            </p>
          </div>
          <div class="text-right">
            <StatusBadge status={p().status} />
            <p class="mt-1.5 max-w-[22rem] text-[0.72rem] leading-relaxed text-ink-3">
              {meta().note}
            </p>
            <Show when={clock()}>
              {(c) => (
                <p class="mt-2 text-[0.78rem]" title={fmtTime(c().at)}>
                  <span class="text-ink-3">{c().label} </span>
                  <span
                    class={`font-mono tabular-nums ${
                      new Date(c().at).getTime() < now() ? "text-critical" : "text-ink"
                    }`}
                  >
                    {fmtRelative(c().at, now())}
                  </span>
                </p>
              )}
            </Show>
          </div>
        </div>

        <div class="px-4 pt-6 pb-2 sm:px-8">
          <LifecycleRail status={p().status} confirmedRaw={p().confirmed_raw} />
        </div>

        <div class="mt-4 border-t border-hairline px-4 py-4 sm:px-8">
          <div class="flex items-baseline justify-between gap-4">
            <p class="font-mono text-[0.82rem] text-ink tabular-nums">
              {fmtUnits(p().confirmed_raw, p().decimals)}{" "}
              <span class="text-ink-3">
                / {fmtUnits(p().amount_crypto_raw, p().decimals)} {p().asset} confirmed
              </span>
            </p>
            <p class={`font-mono text-[0.82rem] tabular-nums ${meta().text}`}>
              {pct().toFixed(2)}%
            </p>
          </div>
          <div class="mt-2">
            <Meter pct={pct()} status={p().status} />
          </div>
          <div class="mt-2 flex flex-wrap justify-between gap-x-6 gap-y-1 text-[0.72rem] text-ink-3">
            <span>
              Settles at {fmtUnits(p().threshold_raw, p().decimals)} {p().asset} — the required
              amount less the dust tolerance
            </span>
            <Show when={remaining() > 0n}>
              <span class="text-ink-2 tabular-nums">
                {fmtUnits(remaining().toString(), p().decimals)} {p().asset} outstanding
              </span>
            </Show>
          </div>
        </div>
      </Panel>

      <div class="grid gap-4 lg:grid-cols-2">
        <Panel title="Amounts">
          <dl class="grid grid-cols-2 gap-x-6 gap-y-4 px-4 py-4">
            <Field label="Charged">
              <span class="tabular-nums">${fmtCop(p().amount_cop)} COP</span>
            </Field>
            <Field label="Frozen rate" hint="market + spread, fixed at creation">
              <span class="font-mono text-[0.78rem] tabular-nums">
                {fmtRate(p().rate_cop_per_unit_e6, p().asset)}
              </span>
            </Field>
            <Field label="Required" hint={`${p().amount_crypto_raw} raw`}>
              <span class="font-mono tabular-nums">
                {fmtUnits(p().amount_crypto_raw, p().decimals)} {p().asset}
              </span>
            </Field>
            <Field label="Confirmed" hint={`${p().confirmed_raw} raw`}>
              <span class="font-mono tabular-nums">
                {fmtUnits(p().confirmed_raw, p().decimals)} {p().asset}
              </span>
            </Field>
            <Field label="Pending" hint="seen on-chain, not yet confirmed">
              <span
                class={`font-mono tabular-nums ${BigInt(p().pending_raw) > 0n ? "text-warn" : ""}`}
              >
                {fmtUnits(p().pending_raw, p().decimals)} {p().asset}
              </span>
            </Field>
            <Field label="Overpaid">
              <span
                class={`font-mono tabular-nums ${
                  BigInt(p().overpaid_raw) > 0n ? "text-serious" : ""
                }`}
              >
                {fmtUnits(p().overpaid_raw, p().decimals)} {p().asset}
              </span>
            </Field>
          </dl>
        </Panel>

        <Panel title="Destination & timing">
          <dl class="grid grid-cols-2 gap-x-6 gap-y-4 px-4 py-4">
            <Field label="Address" hint={`HD index ${p().derivation_index}`}>
              <Hash
                value={p().address}
                explorer={props.d.network?.explorer.address}
                kind="address"
                head={12}
                tail={8}
              />
            </Field>
            <Field
              label="Network"
              hint={
                props.d.network
                  ? `${props.d.network.family}${
                      props.d.network.chain_id ? ` · chain ${props.d.network.chain_id}` : ""
                    } · ${props.d.network.confirmations} confirmations`
                  : undefined
              }
            >
              {p().network}
            </Field>
            <Field
              label="Token"
              hint={props.d.token ? `${props.d.token.decimals} decimals` : undefined}
            >
              <Show
                when={props.d.token}
                fallback={<span class="text-ink-3">unknown</span>}
              >
                {(token) => (
                  <Hash
                    value={token().address}
                    explorer={props.d.network?.explorer.address}
                    kind="address"
                    head={10}
                    tail={6}
                  />
                )}
              </Show>
            </Field>
            <Field label="Quote expires" hint="rate frozen until this moment">
              <span class="text-[0.78rem]" title={fmtRelative(p().quote_expires_at, now())}>
                {fmtTime(p().quote_expires_at)}
              </span>
            </Field>
            <Field
              label="Grace window"
              hint={
                p().grace_expires_at ? "opened by the first deposit" : "opens on the first deposit"
              }
            >
              <Show
                when={p().grace_expires_at}
                fallback={<span class="text-[0.78rem] text-ink-3">not opened</span>}
              >
                {(grace) => (
                  <span class="text-[0.78rem]" title={fmtRelative(grace(), now())}>
                    {fmtTime(grace())}
                  </span>
                )}
              </Show>
            </Field>
            <Field label={p().paid_at ? "Paid at" : "Last updated"}>
              <span class="text-[0.78rem]">{fmtTime(p().paid_at ?? p().updated_at)}</span>
            </Field>
          </dl>
        </Panel>
      </div>

      <Deposits d={props.d} />
      <Webhooks d={props.d} />
      <Ledger d={props.d} />

      <Show when={p().metadata != null}>
        <Panel title="Merchant metadata">
          <pre class="overflow-x-auto px-4 py-4 font-mono text-[0.76rem] leading-relaxed text-ink-2">
            {JSON.stringify(p().metadata, null, 2)}
          </pre>
        </Panel>
      </Show>
    </div>
  );
}
