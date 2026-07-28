import { createEffect, createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import { Link, useNavigate, useSearch } from "@tanstack/solid-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/solid-query";
import {
  ConsoleError,
  createMerchant,
  deleteMerchant,
  fetchClients,
  fetchMerchant,
  fmtCop,
  fmtRelative,
  fmtTime,
  rotateApiKey,
  rotateWebhookSecret,
  updateMerchant,
  type AuditEntry,
  type ClientRow,
} from "./api";
import { now, refreshInterval } from "./console";
import {
  Button,
  Callout,
  CopyButton,
  Empty,
  Field,
  InlineConfirm,
  Panel,
  SecretReveal,
  TextInput,
} from "./ui";

/**
 * Merchants — the console's first write surface.
 *
 * Everything here mutates, which is why it exists at all only now: each action
 * lands an `admin_audit_log` row, and that trail is the condition `AGENTS.md`
 * puts on the console being allowed to change anything. The audit strip at the
 * bottom of the detail panel is that trail, shown where the actions are, rather
 * than filed somewhere an operator would have to go looking for it.
 *
 * The two rotate actions and the two delete actions all state their blast radius
 * before they fire. That is not politeness: rotating a key breaks a live
 * integration in the time it takes to answer the request, and neither the console
 * nor the merchant can undo it.
 */

/** Credential returned by a mutation — the console's one chance to display it. */
type Revealed = { title: string; values: Array<{ label: string; value: string }>; note: string };

function CredentialNote(props: { children: string }) {
  return <span class="text-[0.7rem] text-ink-3">{props.children}</span>;
}

function AuditStrip(props: { entries: AuditEntry[] }) {
  return (
    <Show
      when={props.entries.length > 0}
      fallback={<p class="text-[0.72rem] text-ink-3">Nothing recorded against this merchant yet.</p>}
    >
      <ul class="space-y-1.5">
        <For each={props.entries}>
          {(e) => (
            <li class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[0.72rem]">
              <span
                class={`font-mono ${e.outcome === "ok" ? "text-ink-2" : "text-warn"}`}
                title={e.outcome === "ok" ? "applied" : e.outcome}
              >
                {e.action}
              </span>
              <span class="text-ink-3">by</span>
              <span class="font-mono text-ink-2">{e.operator_username}</span>
              <span class="text-ink-3" title={fmtTime(e.created_at)}>
                {fmtRelative(e.created_at, now())}
              </span>
              <Show when={e.trace_id}>
                {(trace) => (
                  <span
                    class="font-mono text-[0.66rem] text-ink-3"
                    title="Search the log tail for this to see the whole request"
                  >
                    {trace().slice(0, 12)}
                  </span>
                )}
              </Show>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}

function MerchantsTable(props: {
  rows: ClientRow[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
}) {
  return (
    <div class="overflow-x-auto">
      <table class="w-full min-w-[820px] border-collapse text-left">
        <thead>
          <tr class="border-b border-hairline text-[0.66rem] tracking-[0.12em] text-ink-3 uppercase">
            <th class="px-4 py-2.5 font-medium">Merchant</th>
            <th class="px-4 py-2.5 font-medium">Status</th>
            <th class="px-4 py-2.5 font-medium">Webhook</th>
            <th class="px-4 py-2.5 text-right font-medium">Payments</th>
            <th class="px-4 py-2.5 text-right font-medium">Balance COP</th>
            <th class="px-4 py-2.5 text-right font-medium">Created</th>
          </tr>
        </thead>
        <tbody>
          <For each={props.rows}>
            {(m) => (
              <tr
                onClick={() => props.onSelect(m.id)}
                class={`cursor-pointer border-b border-hairline/70 transition-colors hover:bg-plane/60 ${
                  props.selectedId === m.id ? "bg-plane/70" : ""
                }`}
              >
                <td class="px-4 py-3">
                  <span class="text-[0.82rem] text-ink">{m.name}</span>
                  <p class="mt-0.5 font-mono text-[0.66rem] text-ink-3">{m.id}</p>
                </td>
                <td class="px-4 py-3">
                  <span
                    class={`inline-flex items-center gap-2 text-[0.8rem] ${
                      m.is_active ? "text-ink-2" : "text-critical"
                    }`}
                  >
                    <span
                      aria-hidden
                      class={`inline-block h-[7px] w-[7px] rounded-full border-[1.5px] ${
                        m.is_active ? "border-ok bg-ok" : "border-critical"
                      }`}
                    />
                    {m.is_active ? "active" : "disabled"}
                  </span>
                </td>
                <td class="max-w-[240px] px-4 py-3">
                  <Show
                    when={m.webhook_url}
                    fallback={<span class="text-[0.76rem] text-ink-3">none</span>}
                  >
                    {(url) => (
                      <span class="block truncate font-mono text-[0.72rem] text-ink-2" title={url()}>
                        {url()}
                      </span>
                    )}
                  </Show>
                </td>
                <td class="px-4 py-3 text-right text-[0.82rem] text-ink-2 tabular-nums">
                  {m.payments}
                </td>
                <td class="px-4 py-3 text-right font-mono text-[0.8rem] text-ink tabular-nums">
                  {fmtCop(m.balance_cop)}
                </td>
                <td
                  class="px-4 py-3 text-right text-[0.76rem] whitespace-nowrap text-ink-3"
                  title={fmtTime(m.created_at)}
                >
                  {fmtRelative(m.created_at, now())}
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  );
}

export function MerchantsRoute() {
  const search = useSearch({ from: "/admin/merchants" });
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [revealed, setRevealed] = createSignal<Revealed | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [creating, setCreating] = createSignal(false);
  const [newName, setNewName] = createSignal("");
  const [newWebhook, setNewWebhook] = createSignal("");

  // Draft edits for the selected merchant. Reset whenever the selection changes,
  // so a half-typed name cannot follow you onto another merchant.
  const [draftName, setDraftName] = createSignal("");
  const [draftWebhook, setDraftWebhook] = createSignal("");

  const selectedId = () => search().id;

  const select = (id: string | undefined) =>
    navigate({ to: "/admin/merchants", search: () => (id ? { id } : {}) });

  const clients = useQuery(() => ({
    queryKey: ["clients"],
    queryFn: fetchClients,
    refetchInterval: refreshInterval(),
  }));

  const detail = useQuery(() => ({
    queryKey: ["merchant", selectedId()],
    queryFn: () => fetchMerchant(selectedId()!),
    enabled: Boolean(selectedId()),
    refetchInterval: refreshInterval(),
  }));

  createEffect(() => {
    const d = detail.data;
    if (!d) return;
    setDraftName(d.client.name);
    setDraftWebhook(d.client.webhook_url ?? "");
  });

  createEffect(() => {
    document.title = "Merchants · console";
  });

  const dirty = createMemo(() => {
    const d = detail.data;
    if (!d) return false;
    return draftName() !== d.client.name || draftWebhook() !== (d.client.webhook_url ?? "");
  });

  /** Every mutation lands here: refresh what it could have changed, surface what broke. */
  const settled = (e?: unknown) => {
    if (e) {
      setError(e instanceof ConsoleError ? e.message : String(e));
      return;
    }
    setError(null);
    queryClient.invalidateQueries({ queryKey: ["clients"] });
    queryClient.invalidateQueries({ queryKey: ["merchant"] });
    queryClient.invalidateQueries({ queryKey: ["audit"] });
    queryClient.invalidateQueries({ queryKey: ["stats"] });
  };

  const create = useMutation(() => ({
    mutationFn: () =>
      createMerchant({ name: newName().trim(), webhook_url: newWebhook().trim() || null }),
    onSuccess: (res) => {
      settled();
      setCreating(false);
      setNewName("");
      setNewWebhook("");
      select(res.client.id);
      setRevealed({
        title: `Credentials for ${res.client.name}`,
        values: [
          { label: "API key", value: res.api_key },
          { label: "Webhook signing secret", value: res.webhook_secret },
        ],
        note:
          "Neither is stored in a form the server can show again — the key is kept only as a " +
          "hash, and the secret is never returned by a read. Losing them means rotating, which " +
          "breaks the merchant's live integration.",
      });
    },
    onError: settled,
  }));

  const save = useMutation(() => ({
    mutationFn: () =>
      updateMerchant(selectedId()!, {
        name: draftName().trim(),
        webhook_url: draftWebhook().trim() || null,
      }),
    onSuccess: () => settled(),
    onError: settled,
  }));

  const setActive = useMutation(() => ({
    mutationFn: (isActive: boolean) => updateMerchant(selectedId()!, { is_active: isActive }),
    onSuccess: () => settled(),
    onError: settled,
  }));

  const newApiKey = useMutation(() => ({
    mutationFn: () => rotateApiKey(selectedId()!),
    onSuccess: (res) => {
      settled();
      setRevealed({
        title: `New API key for ${res.client.name}`,
        values: [{ label: "API key", value: res.api_key }],
        note:
          "The previous key stopped authenticating the moment this was issued — there is no " +
          "overlap window. Any running integration is failing with 401 until this value " +
          "reaches it.",
      });
    },
    onError: settled,
  }));

  const newSecret = useMutation(() => ({
    mutationFn: () => rotateWebhookSecret(selectedId()!),
    onSuccess: (res) => {
      settled();
      setRevealed({
        title: `New webhook secret for ${res.client.name}`,
        values: [{ label: "Webhook signing secret", value: res.webhook_secret }],
        note:
          "Deliveries are signed with the secret read at delivery time, so webhook jobs still " +
          "queued for this merchant will be signed with this new value — not the one they were " +
          "enqueued under. A receiver verifying against the old secret will reject them.",
      });
    },
    onError: settled,
  }));

  const remove = useMutation(() => ({
    mutationFn: (hard: boolean) => deleteMerchant(selectedId()!, hard),
    onSuccess: (res) => {
      settled();
      if (res.deleted) select(undefined);
    },
    onError: settled,
  }));

  const busy = () =>
    create.isPending ||
    save.isPending ||
    setActive.isPending ||
    newApiKey.isPending ||
    newSecret.isPending ||
    remove.isPending;

  return (
    <div class="space-y-4">
      <Show when={revealed()}>
        {(secret) => (
          <SecretReveal
            title={secret().title}
            values={secret().values}
            note={secret().note}
            onDismiss={() => setRevealed(null)}
          />
        )}
      </Show>

      <Show when={error()}>
        {(message) => (
          <Callout tone="critical">
            {message()}{" "}
            <button
              type="button"
              onClick={() => setError(null)}
              class="cursor-pointer underline underline-offset-2"
            >
              dismiss
            </button>
          </Callout>
        )}
      </Show>

      <Show when={selectedId() && detail.data}>
        {(_) => {
          const d = () => detail.data!;
          return (
            <Panel
              title={d().client.name}
              aside={
                <div class="flex items-center gap-2">
                  <Link
                    to="/admin/build"
                    search={{ client: d().client.id }}
                    class="rounded border border-hairline px-2.5 py-1 text-[0.75rem] text-ink-3 transition-colors hover:border-baseline hover:text-ink focus-visible:ring-2 focus-visible:ring-ink-2 focus-visible:outline-none"
                  >
                    Build a payment →
                  </Link>
                  <Button onClick={() => select(undefined)}>Close</Button>
                </div>
              }
            >
              <div class="space-y-5 px-4 py-4">
                <dl class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <Field label="Merchant id">
                    <span class="inline-flex min-w-0 items-center gap-1.5">
                      <span class="truncate font-mono text-[0.76rem]">{d().client.id}</span>
                      <CopyButton value={d().client.id} label="merchant id" />
                    </span>
                  </Field>
                  <Field
                    label="API key"
                    hint="Prefix of the key's hash — what the log records on a rejected key."
                  >
                    <span class="font-mono text-[0.76rem]">
                      {d().client.api_key_hash_prefix}…
                    </span>
                  </Field>
                  <Field label="Balance">
                    <span class="font-mono tabular-nums">{fmtCop(d().client.balance_cop)} COP</span>
                  </Field>
                  <Field label="Payments" hint={`${d().webhooks.dead} dead webhook jobs`}>
                    <span class="tabular-nums">{d().payments.total}</span>
                  </Field>
                </dl>

                <div class="space-y-3 border-t border-hairline pt-4">
                  <h3 class="text-[0.7rem] font-semibold tracking-[0.14em] text-ink-3 uppercase">
                    Settings
                  </h3>
                  <div class="grid gap-3 sm:grid-cols-2">
                    <label class="block">
                      <span class="text-[0.68rem] tracking-[0.1em] text-ink-3 uppercase">Name</span>
                      <div class="mt-1">
                        <TextInput
                          label="Merchant name"
                          value={draftName()}
                          onInput={setDraftName}
                        />
                      </div>
                    </label>
                    <label class="block">
                      <span class="text-[0.68rem] tracking-[0.1em] text-ink-3 uppercase">
                        Webhook URL
                      </span>
                      <div class="mt-1">
                        <TextInput
                          label="Webhook URL"
                          value={draftWebhook()}
                          onInput={setDraftWebhook}
                          placeholder="none — events are dropped"
                          mono
                        />
                      </div>
                    </label>
                  </div>
                  <Button
                    tone="primary"
                    disabled={!dirty() || busy()}
                    onClick={() => save.mutate()}
                  >
                    {save.isPending ? "Saving…" : "Save changes"}
                  </Button>
                </div>

                <div class="space-y-3 border-t border-hairline pt-4">
                  <h3 class="text-[0.7rem] font-semibold tracking-[0.14em] text-ink-3 uppercase">
                    Credentials
                  </h3>
                  <div class="flex flex-wrap items-center gap-3">
                    <InlineConfirm
                      label="Rotate API key"
                      confirmLabel="Rotate now"
                      consequence="The current key stops working immediately."
                      disabled={busy()}
                      onConfirm={() => newApiKey.mutate()}
                    />
                    <InlineConfirm
                      label="Rotate webhook secret"
                      confirmLabel="Rotate now"
                      consequence="Queued deliveries will be signed with the new secret."
                      disabled={busy()}
                      onConfirm={() => newSecret.mutate()}
                    />
                  </div>
                  <CredentialNote>
                    Rotation has no overlap window on either credential — there is no period
                    where both the old and the new value are accepted.
                  </CredentialNote>
                </div>

                <div class="space-y-3 border-t border-hairline pt-4">
                  <h3 class="text-[0.7rem] font-semibold tracking-[0.14em] text-ink-3 uppercase">
                    Access
                  </h3>
                  <div class="flex flex-wrap items-center gap-3">
                    <Show
                      when={d().client.is_active}
                      fallback={
                        <Button
                          disabled={busy()}
                          onClick={() => setActive.mutate(true)}
                        >
                          Reactivate merchant
                        </Button>
                      }
                    >
                      <InlineConfirm
                        label="Deactivate merchant"
                        confirmLabel="Deactivate"
                        consequence="Its API key stops authenticating at once."
                        disabled={busy()}
                        onConfirm={() => setActive.mutate(false)}
                      />
                    </Show>
                    <Show
                      when={d().deletable}
                      fallback={
                        <span class="text-[0.72rem] text-ink-3">
                          Cannot be deleted — {d().references.payments} payments,{" "}
                          {d().references.ledger_entries} ledger entries and{" "}
                          {d().references.webhook_jobs} webhook jobs point at it.
                        </span>
                      }
                    >
                      <InlineConfirm
                        label="Delete permanently"
                        confirmLabel="Delete"
                        consequence="Nothing references this merchant; the row will be removed."
                        disabled={busy()}
                        onConfirm={() => remove.mutate(true)}
                      />
                    </Show>
                  </div>
                  <Callout tone="warn">
                    Deactivating is not freezing. It stops the merchant's API calls immediately,
                    and it does not stop payments already on-chain from settling and crediting
                    its balance — settlement reads Transfer logs, never merchant state.
                  </Callout>
                </div>

                <div class="space-y-2 border-t border-hairline pt-4">
                  <h3 class="text-[0.7rem] font-semibold tracking-[0.14em] text-ink-3 uppercase">
                    Recorded changes
                  </h3>
                  <AuditStrip entries={d().audit} />
                </div>
              </div>
            </Panel>
          );
        }}
      </Show>

      <Panel
        title={`Merchants${clients.data ? ` · ${clients.data.clients.length}` : ""}`}
        aside={
          <Show
            when={!creating()}
            fallback={<Button onClick={() => setCreating(false)}>Cancel</Button>}
          >
            <Button tone="primary" onClick={() => setCreating(true)}>
              New merchant
            </Button>
          </Show>
        }
      >
        <Show when={creating()}>
          <div class="space-y-3 border-b border-hairline px-4 py-4">
            <div class="grid gap-3 sm:grid-cols-2">
              <label class="block">
                <span class="text-[0.68rem] tracking-[0.1em] text-ink-3 uppercase">Name</span>
                <div class="mt-1">
                  <TextInput
                    label="Merchant name"
                    value={newName()}
                    onInput={setNewName}
                    placeholder="Acme Store"
                  />
                </div>
              </label>
              <label class="block">
                <span class="text-[0.68rem] tracking-[0.1em] text-ink-3 uppercase">
                  Webhook URL (optional)
                </span>
                <div class="mt-1">
                  <TextInput
                    label="Webhook URL"
                    value={newWebhook()}
                    onInput={setNewWebhook}
                    placeholder="https://example.com/webhooks/gateway"
                    mono
                  />
                </div>
              </label>
            </div>
            <Callout>
              Creating a merchant mints an API key and a webhook signing secret. Both are shown
              once, on the next screen, and never again — the key is stored only as a hash, and
              the secret is never returned by any read.
            </Callout>
            <Button
              tone="primary"
              disabled={newName().trim().length === 0 || busy()}
              onClick={() => create.mutate()}
            >
              {create.isPending ? "Creating…" : "Create merchant"}
            </Button>
          </div>
        </Show>

        <Switch>
          <Match when={clients.isError}>
            <Empty>Could not load merchants: {String(clients.error?.message ?? "")}</Empty>
          </Match>
          <Match when={!clients.data}>
            <Empty>Loading…</Empty>
          </Match>
          <Match when={clients.data!.clients.length === 0}>
            <Empty>No merchants yet. Create one to get an API key.</Empty>
          </Match>
          <Match when={clients.data}>
            <MerchantsTable
              rows={clients.data!.clients}
              selectedId={selectedId()}
              onSelect={select}
            />
          </Match>
        </Switch>
      </Panel>
    </div>
  );
}
