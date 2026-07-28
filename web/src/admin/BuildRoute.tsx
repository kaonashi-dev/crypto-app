import { createEffect, createMemo, createSignal, Match, Show, Switch } from "solid-js";
import { Link, useNavigate, useSearch } from "@tanstack/solid-router";
import { useQuery } from "@tanstack/solid-query";
import {
  createPaymentAsMerchant,
  createPaymentAsOperator,
  fetchClients,
  fetchStats,
  fetchStatusAsMerchant,
  fetchStatusAsOperator,
  fmtUnits,
  type PaymentRequestBody,
  type RawResponse,
} from "./api";
import { apiKeyFor, forgetApiKey, maskKey, rememberApiKey } from "./credentials";
import { refreshInterval } from "./console";
import {
  Button,
  Callout,
  CopyButton,
  Empty,
  Panel,
  SegmentedControl,
  Select,
  TextArea,
  TextInput,
} from "./ui";

/**
 * Build — compose a real payment request, send it, and read what came back.
 *
 * The point is that this is not a shortcut around the API but the API itself.
 * In **merchant** mode the browser posts to `/api/payments` with an `X-Api-Key`,
 * exactly as an integration would: same route, same auth middleware, same
 * validation, same response. The console session cookie is scoped to `/admin`, so
 * it is not even attached to that call — there is no ambient authority making it
 * work that a merchant would not have.
 *
 * **Operator** mode exists because a key is shown once and never recoverable, so
 * for an existing merchant there is usually no key to paste. It posts to
 * `/admin/api/payments`, which calls the same `createPayment()` service and builds
 * the checkout URL the same way, and writes an audit row naming the operator.
 *
 * The request preview is the other half of the value: it is the actual request,
 * copyable as curl, which makes this page double as the integration
 * documentation for the two endpoints it exercises.
 */

/** The request preview shows the key masked; the clipboard gets the real one. */
function headerLines(headers: Record<string, string>, maskApiKey: boolean): string[] {
  return Object.entries(headers).map(([k, v]) =>
    maskApiKey && k.toLowerCase() === "x-api-key" ? `${k}: ${maskKey(v)}` : `${k}: ${v}`
  );
}

function curlFor(method: string, url: string, headers: Record<string, string>, body?: string) {
  const origin = window.location.origin;
  const parts = [`curl -X ${method} '${origin}${url}'`];
  for (const [k, v] of Object.entries(headers)) parts.push(`  -H '${k}: ${v}'`);
  if (body) parts.push(`  -d '${body}'`);
  return parts.join(" \\\n");
}

function ResponsePanel(props: { response: RawResponse; label: string }) {
  const tone = () =>
    props.response.ok ? "text-ok" : props.response.status >= 500 ? "text-critical" : "text-warn";

  return (
    <div class="space-y-2">
      <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span class="text-[0.66rem] tracking-[0.12em] text-ink-3 uppercase">{props.label}</span>
        <span class={`font-mono text-[0.8rem] ${tone()}`}>{props.response.status}</span>
        <Show when={props.response.trace_id}>
          {(trace) => (
            <span
              class="font-mono text-[0.68rem] text-ink-3"
              title="Search this in the log tail to see everything the request did"
            >
              trace {trace().slice(0, 16)}
            </span>
          )}
        </Show>
      </div>
      <pre class="max-h-80 overflow-auto rounded border border-hairline bg-plane px-3 py-2 font-mono text-[0.72rem] leading-relaxed text-ink-2">
        {JSON.stringify(props.response.body, null, 2)}
      </pre>
    </div>
  );
}

export function BuildRoute() {
  const search = useSearch({ from: "/admin/build" });
  const navigate = useNavigate();

  const [mode, setMode] = createSignal<"operator" | "merchant">("operator");
  const [amount, setAmount] = createSignal("50000");
  const [network, setNetwork] = createSignal("");
  const [asset, setAsset] = createSignal("");
  const [metadata, setMetadata] = createSignal('{ "order_id": "ORD-001" }');
  const [keyDraft, setKeyDraft] = createSignal("");
  const [editingKey, setEditingKey] = createSignal(false);
  const [response, setResponse] = createSignal<RawResponse | null>(null);
  const [statusResponse, setStatusResponse] = createSignal<RawResponse | null>(null);
  const [sending, setSending] = createSignal(false);
  const [checking, setChecking] = createSignal(false);

  const clientId = () => search().client;
  const setClient = (id: string) =>
    navigate({ to: "/admin/build", search: () => ({ client: id || undefined }) });

  const stats = useQuery(() => ({
    queryKey: ["stats"],
    queryFn: fetchStats,
    refetchInterval: refreshInterval(),
  }));

  const clients = useQuery(() => ({
    queryKey: ["clients"],
    queryFn: fetchClients,
    refetchInterval: refreshInterval(),
  }));

  createEffect(() => {
    document.title = "Build · console";
  });

  /**
   * Only networks the gateway still offers.
   *
   * `src/config.ts` is authoritative for what exists, and `offered` is the subset
   * taking new payments — a withheld mainnet keeps its definition so historical
   * payments render, but quoting one would be refused by the service anyway.
   */
  const networks = createMemo(() => (stats.data?.networks ?? []).filter((n) => n.offered));

  const assetsFor = (id: string) => {
    const net = networks().find((n) => n.id === id);
    if (!net) return [];
    return [...net.tokens, ...(net.native ? [net.native] : [])];
  };

  // Seed the pickers once the registry lands, and keep the asset legal for the
  // chosen network — the pairing, not the symbol, is what has to exist.
  createEffect(() => {
    const available = networks();
    if (available.length === 0) return;
    if (!available.some((n) => n.id === network())) setNetwork(available[0]!.id);
  });
  createEffect(() => {
    const options = assetsFor(network());
    if (options.length > 0 && !options.includes(asset())) setAsset(options[0]!);
  });

  // Default the merchant to the first active one, unless a link named it.
  createEffect(() => {
    const list = clients.data?.clients ?? [];
    if (list.length === 0 || clientId()) return;
    const first = list.find((c) => c.is_active) ?? list[0]!;
    setClient(first.id);
  });

  const selectedClient = () => clients.data?.clients.find((c) => c.id === clientId());
  const heldKey = () => (clientId() ? apiKeyFor(clientId()!) : null);

  const metadataError = createMemo(() => {
    const text = metadata().trim();
    if (!text) return null;
    try {
      JSON.parse(text);
      return null;
    } catch {
      return "metadata is not valid JSON";
    }
  });

  const requestBody = createMemo((): PaymentRequestBody & { client_id?: string } => {
    const text = metadata().trim();
    const body: PaymentRequestBody & { client_id?: string } = {
      amount_cop: amount().trim(),
      asset: asset(),
      network: network(),
    };
    if (text && !metadataError()) body.metadata = JSON.parse(text);
    if (mode() === "operator") body.client_id = clientId();
    return body;
  });

  const preview = createMemo(() => {
    const merchantMode = mode() === "merchant";
    const url = merchantMode ? "/api/payments" : "/admin/api/payments";
    const key = heldKey();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (merchantMode && key) headers["X-Api-Key"] = key;
    const body = JSON.stringify(requestBody(), null, 2);
    return { url, headers, body, merchantMode };
  });

  const blocked = createMemo(() => {
    if (!clientId()) return "Pick a merchant first.";
    if (metadataError()) return metadataError();
    if (!/^\d+$/.test(amount().trim())) return "Amount must be a whole number of COP.";
    if (BigInt(amount().trim() || "0") < 1000n) return "The minimum the gateway accepts is 1,000 COP.";
    if (!network() || !asset()) return "Pick a network and an asset.";
    if (mode() === "merchant" && !heldKey()) return "Paste this merchant's API key, or send as operator.";
    return null;
  });

  const created = () => {
    const res = response();
    if (!res?.ok) return null;
    return res.body as { id: string; checkout_url: string; address: string; amount_crypto_raw: string };
  };

  const send = async () => {
    if (blocked()) return;
    setSending(true);
    setStatusResponse(null);
    try {
      const body = requestBody();
      const result =
        mode() === "merchant"
          ? await createPaymentAsMerchant(heldKey()!, body)
          : await createPaymentAsOperator(clientId()!, body);
      setResponse(result);
    } finally {
      setSending(false);
    }
  };

  const checkStatus = async () => {
    const payment = created();
    if (!payment) return;
    setChecking(true);
    try {
      const key = heldKey();
      setStatusResponse(
        mode() === "merchant" && key
          ? await fetchStatusAsMerchant(key, payment.id)
          : await fetchStatusAsOperator(payment.id)
      );
    } finally {
      setChecking(false);
    }
  };

  return (
    <Switch>
      <Match when={stats.isError || clients.isError}>
        <Panel title="Build">
          <Empty>Could not load the registry: {String(stats.error?.message ?? "")}</Empty>
        </Panel>
      </Match>
      <Match when={!stats.data || !clients.data}>
        <Panel title="Build">
          <Empty>Loading…</Empty>
        </Panel>
      </Match>
      <Match when={clients.data!.clients.length === 0}>
        <Panel title="Build">
          <Empty>
            No merchants exist yet. <Link to="/admin/merchants" class="underline">Create one</Link>{" "}
            to get an API key, then come back.
          </Empty>
        </Panel>
      </Match>
      <Match when={stats.data && clients.data}>
        <div class="grid gap-4 lg:grid-cols-2">
          {/* -- Request ------------------------------------------------ */}
          <Panel title="Request">
            <div class="space-y-4 px-4 py-4">
              <div class="grid gap-3 sm:grid-cols-2">
                <label class="block">
                  <span class="text-[0.68rem] tracking-[0.1em] text-ink-3 uppercase">Merchant</span>
                  <div class="mt-1">
                    <Select
                      label="Merchant"
                      value={clientId() ?? ""}
                      onChange={setClient}
                      options={clients.data!.clients.map((c) => ({
                        value: c.id,
                        label: c.is_active ? c.name : `${c.name} (disabled)`,
                      }))}
                    />
                  </div>
                </label>
                <label class="block">
                  <span class="text-[0.68rem] tracking-[0.1em] text-ink-3 uppercase">
                    Amount COP
                  </span>
                  <div class="mt-1">
                    <TextInput
                      label="Amount in COP"
                      value={amount()}
                      onInput={setAmount}
                      mono
                      placeholder="50000"
                    />
                  </div>
                </label>
                <label class="block">
                  <span class="text-[0.68rem] tracking-[0.1em] text-ink-3 uppercase">Network</span>
                  <div class="mt-1">
                    <Select
                      label="Network"
                      value={network()}
                      onChange={setNetwork}
                      options={networks().map((n) => ({
                        value: n.id,
                        label: n.testnet ? `${n.id} (testnet)` : n.id,
                      }))}
                    />
                  </div>
                </label>
                <label class="block">
                  <span class="text-[0.68rem] tracking-[0.1em] text-ink-3 uppercase">Asset</span>
                  <div class="mt-1">
                    <Select
                      label="Asset"
                      value={asset()}
                      onChange={setAsset}
                      options={assetsFor(network()).map((a) => ({ value: a, label: a }))}
                    />
                  </div>
                </label>
              </div>

              <label class="block">
                <span class="text-[0.68rem] tracking-[0.1em] text-ink-3 uppercase">
                  Metadata (JSON, optional)
                </span>
                <div class="mt-1">
                  <TextArea
                    label="Metadata JSON"
                    value={metadata()}
                    onInput={setMetadata}
                    rows={3}
                    invalid={Boolean(metadataError())}
                    placeholder='{ "order_id": "ORD-001" }'
                  />
                </div>
                <Show when={metadataError()}>
                  <p class="mt-1 text-[0.7rem] text-critical">{metadataError()}</p>
                </Show>
              </label>

              {/* -- Credential -------------------------------------- */}
              <div class="space-y-2 border-t border-hairline pt-4">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <span class="text-[0.68rem] tracking-[0.1em] text-ink-3 uppercase">Send as</span>
                  <SegmentedControl
                    label="Credential mode"
                    value={mode()}
                    onChange={setMode}
                    options={[
                      {
                        value: "operator",
                        label: "Operator",
                        title: "POST /admin/api/payments with your console session",
                      },
                      {
                        value: "merchant",
                        label: "API key",
                        title: "POST /api/payments with the merchant's own key",
                      },
                    ]}
                  />
                </div>

                <Show when={mode() === "merchant"}>
                  <Show
                    when={heldKey() && !editingKey()}
                    fallback={
                      <div class="flex flex-wrap items-center gap-2">
                        <div class="min-w-[16rem] flex-1">
                          <TextInput
                            label="Merchant API key"
                            value={keyDraft()}
                            onInput={setKeyDraft}
                            placeholder="gk_test_…"
                            mono
                            type="password"
                          />
                        </div>
                        <Button
                          tone="primary"
                          disabled={!keyDraft().trim() || !clientId()}
                          onClick={() => {
                            rememberApiKey(clientId()!, keyDraft().trim());
                            setKeyDraft("");
                            setEditingKey(false);
                          }}
                        >
                          Hold key
                        </Button>
                        <Show when={heldKey()}>
                          <Button onClick={() => setEditingKey(false)}>Cancel</Button>
                        </Show>
                      </div>
                    }
                  >
                    <div class="flex flex-wrap items-center gap-2">
                      <span class="font-mono text-[0.76rem] text-ink-2">{maskKey(heldKey()!)}</span>
                      <Button onClick={() => setEditingKey(true)}>Change</Button>
                      <Button onClick={() => forgetApiKey(clientId()!)}>Forget key</Button>
                    </div>
                  </Show>
                  <Callout tone="warn">
                    Held in this tab's <span class="font-mono">sessionStorage</span> and dropped
                    when you sign out or close the tab. This is still a live merchant credential
                    in a browser — the storage choice does not make that free.
                  </Callout>
                </Show>
                <Show when={mode() === "operator"}>
                  <Callout>
                    Posts to <span class="font-mono">/admin/api/payments</span> with your console
                    session and records an audit row naming you. Use this when the merchant's key
                    is not to hand — keys are shown once and cannot be recovered, only rotated.
                  </Callout>
                </Show>
              </div>

              {/* -- Preview ----------------------------------------- */}
              <div class="space-y-2 border-t border-hairline pt-4">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <span class="text-[0.68rem] tracking-[0.1em] text-ink-3 uppercase">
                    The request
                  </span>
                  <span class="flex items-center gap-2">
                    <span
                      class="text-[0.66rem] text-ink-3"
                      title="The copied command contains the real key; the preview above masks it."
                    >
                      copy as curl
                    </span>
                    <CopyButton
                      value={curlFor("POST", preview().url, preview().headers, preview().body)}
                      label="curl command"
                    />
                  </span>
                </div>
                <pre class="overflow-x-auto rounded border border-hairline bg-plane px-3 py-2 font-mono text-[0.72rem] leading-relaxed text-ink-2">
                  {`POST ${preview().url}\n${headerLines(preview().headers, true).join("\n")}\n\n${preview().body}`}
                </pre>
              </div>

              <div class="flex flex-wrap items-center gap-3">
                <Button
                  tone="primary"
                  disabled={Boolean(blocked()) || sending()}
                  onClick={() => void send()}
                >
                  {sending() ? "Sending…" : "Send request"}
                </Button>
                <Show when={blocked()}>
                  <span class="text-[0.72rem] text-ink-3">{blocked()}</span>
                </Show>
              </div>
            </div>
          </Panel>

          {/* -- Response ---------------------------------------------- */}
          <Panel title="Response">
            <div class="space-y-4 px-4 py-4">
              <Show
                when={response()}
                fallback={
                  <p class="text-[0.78rem] text-ink-3">
                    Nothing sent yet. The response appears here exactly as the API returned it,
                    including a rejection — seeing the real 400 is most of the point.
                  </p>
                }
              >
                {(res) => (
                  <>
                    {/* Labelled from the request that was actually sent, not
                        from the mode — the two routes are the whole point of
                        the toggle, so naming the wrong one would be a lie. */}
                    <ResponsePanel
                      response={res()}
                      label={`${res().sent.method} ${res().sent.url}`}
                    />

                    <Show when={created()}>
                      {(payment) => (
                        <div class="space-y-3 border-t border-hairline pt-4">
                          <div class="flex flex-wrap items-center gap-3">
                            <Link
                              to="/admin/p/$publicId"
                              params={{ publicId: payment().id }}
                              class="rounded border border-hairline px-2.5 py-1 text-[0.75rem] text-ink-2 transition-colors hover:border-baseline hover:text-ink focus-visible:ring-2 focus-visible:ring-ink-2 focus-visible:outline-none"
                            >
                              Open in console →
                            </Link>
                            <a
                              href={payment().checkout_url}
                              target="_blank"
                              rel="noreferrer"
                              class="rounded border border-hairline px-2.5 py-1 text-[0.75rem] text-ink-2 transition-colors hover:border-baseline hover:text-ink focus-visible:ring-2 focus-visible:ring-ink-2 focus-visible:outline-none"
                            >
                              Open checkout ↗
                            </a>
                          </div>

                          <dl class="grid gap-3 sm:grid-cols-2">
                            <div>
                              <dt class="text-[0.66rem] tracking-[0.1em] text-ink-3 uppercase">
                                Receiving address
                              </dt>
                              <dd class="mt-1 flex min-w-0 items-center gap-1.5">
                                <span class="truncate font-mono text-[0.74rem] text-ink">
                                  {payment().address}
                                </span>
                                <CopyButton value={payment().address} label="address" />
                              </dd>
                            </div>
                            <div>
                              <dt class="text-[0.66rem] tracking-[0.1em] text-ink-3 uppercase">
                                Amount to send
                              </dt>
                              <dd class="mt-1 font-mono text-[0.74rem] text-ink tabular-nums">
                                {/* The status call below reports decimals; until
                                    then show the raw integer rather than guess. */}
                                {payment().amount_crypto_raw} {asset()} (raw)
                              </dd>
                            </div>
                          </dl>

                          <div class="space-y-2 border-t border-hairline pt-3">
                            <div class="flex flex-wrap items-center gap-3">
                              <Button disabled={checking()} onClick={() => void checkStatus()}>
                                {checking() ? "Checking…" : "Check status"}
                              </Button>
                              <span class="font-mono text-[0.7rem] text-ink-3">
                                {mode() === "merchant" && heldKey()
                                  ? `GET /api/payments/${payment().id}/status`
                                  : `GET /admin/api/payments/${payment().id}`}
                              </span>
                            </div>
                            <Show when={statusResponse()}>
                              {(status) => (
                                <>
                                  <ResponsePanel
                                    response={status()}
                                    label={`${status().sent.method} ${status().sent.url}`}
                                  />
                                  <Show when={statusIsFormattable(status())}>
                                    {(readable) => (
                                      <p class="text-[0.74rem] text-ink-2">
                                        Confirmed{" "}
                                        <span class="font-mono tabular-nums">
                                          {fmtUnits(readable().confirmed_raw, readable().decimals)}
                                        </span>{" "}
                                        of{" "}
                                        <span class="font-mono tabular-nums">
                                          {fmtUnits(readable().amount_crypto_raw, readable().decimals)}
                                        </span>{" "}
                                        {readable().asset}.
                                      </p>
                                    )}
                                  </Show>
                                </>
                              )}
                            </Show>
                          </div>
                        </div>
                      )}
                    </Show>
                  </>
                )}
              </Show>

              <Show when={selectedClient() && !selectedClient()!.is_active}>
                <Callout tone="warn">
                  This merchant is deactivated. Both paths refuse to create a payment for it —
                  the operator route answers 409 and its API key no longer authenticates.
                </Callout>
              </Show>
            </div>
          </Panel>
        </div>
      </Match>
    </Switch>
  );
}

/**
 * The status body, when it is the one carrying `decimals`.
 *
 * Only `GET /api/payments/:id/status` reports decimals, so only its response can
 * be formatted into whole units — the console's own detail route is shown as raw
 * JSON instead of being guessed at.
 */
function statusIsFormattable(
  res: RawResponse
): { confirmed_raw: string; amount_crypto_raw: string; decimals: number; asset: string } | null {
  const body = res.body as any;
  if (!res.ok || typeof body?.decimals !== "number") return null;
  return body;
}
