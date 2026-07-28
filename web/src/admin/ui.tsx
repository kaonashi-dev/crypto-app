import { createSignal, For, onCleanup, Show, type JSX } from "solid-js";
import { MARK, type PaymentStatus } from "../lib/status";
import { explorerUrl, truncate } from "./api";

/**
 * Status presentation for the console.
 *
 * The mark shape comes from lib/status and is shared with the checkout, so a
 * status never rests on hue alone — which matters both for colour-vision
 * deficiency and because `pending` and `expired` deliberately share the neutral
 * ink here, and only the mark separates them.
 */
export const STATUS_META: Record<
  PaymentStatus,
  { label: string; text: string; bg: string; border: string; note: string }
> = {
  pending: {
    label: "pending",
    text: "text-ink-3",
    bg: "bg-ink-3",
    border: "border-ink-3",
    note: "Address derived, quote frozen. No transfer seen yet.",
  },
  detecting: {
    label: "detecting",
    text: "text-warn",
    bg: "bg-warn",
    border: "border-warn",
    note: "A mined transfer was seen. Waiting for confirmations.",
  },
  partially_paid: {
    label: "partially paid",
    text: "text-serious",
    bg: "bg-serious",
    border: "border-serious",
    note: "Confirmed but short of the amount. The grace window is running.",
  },
  paid: {
    label: "paid",
    text: "text-ok",
    bg: "bg-ok",
    border: "border-ok",
    note: "Settled. COP balance credited and the ledger entry written.",
  },
  expired: {
    label: "expired",
    text: "text-ink-3",
    bg: "bg-ink-3",
    border: "border-ink-3",
    note: "The quote lapsed before any funds arrived. Nothing to reconcile.",
  },
  underpaid_expired: {
    label: "underpaid expired",
    text: "text-critical",
    bg: "bg-critical",
    border: "border-critical",
    note: "The grace window lapsed while short. Funds are held and need manual resolution.",
  },
};

export function StatusMark(props: { status: PaymentStatus; size?: number }) {
  const meta = () => STATUS_META[props.status];
  const box = () => ({ width: `${props.size ?? 9}px`, height: `${props.size ?? 9}px` });

  return (
    <Show
      when={MARK[props.status] !== "cross"}
      fallback={
        <span
          aria-hidden
          class={`relative inline-block shrink-0 ${meta().text}`}
          style={box()}
        >
          <span class="absolute inset-x-0 top-1/2 h-[1.5px] -translate-y-1/2 rotate-45 bg-current" />
          <span class="absolute inset-x-0 top-1/2 h-[1.5px] -translate-y-1/2 -rotate-45 bg-current" />
        </span>
      }
    >
      <span
        aria-hidden
        class={`inline-block shrink-0 rounded-full border-[1.5px] ${meta().border} ${
          MARK[props.status] === "solid" ? meta().bg : ""
        }`}
        style={box()}
      />
    </Show>
  );
}

export function StatusBadge(props: { status: PaymentStatus }) {
  return (
    <span
      class={`inline-flex items-center gap-2 whitespace-nowrap text-[0.8rem] ${
        STATUS_META[props.status].text
      }`}
    >
      <StatusMark status={props.status} />
      {STATUS_META[props.status].label}
    </span>
  );
}

// -- Lifecycle rail ----------------------------------------------------

const MAIN: PaymentStatus[] = ["pending", "detecting", "partially_paid", "paid"];

/**
 * Where a payment sits on the main track, and which dead-end it took.
 *
 * The row records only the current status, not its history, so position is
 * derived: a terminal branch reports the step it left from — `underpaid_expired`
 * with confirmed funds must have passed through `partially_paid`, without them
 * it stalled at `detecting`.
 */
function railPosition(status: PaymentStatus, confirmedRaw: string) {
  if (status === "expired") return { step: 0, branch: "expired" as const };
  if (status === "underpaid_expired") {
    return { step: BigInt(confirmedRaw) > 0n ? 2 : 1, branch: "underpaid_expired" as const };
  }
  return { step: MAIN.indexOf(status), branch: null };
}

/**
 * The state machine as the page's hero: which path this payment took and where
 * it stopped. Traversed steps are neutral and solid, the current step carries the
 * status colour, unreached steps are hollow. Dead-ends hang below the step they
 * branch from and stay dim unless taken.
 */
export function LifecycleRail(props: { status: PaymentStatus; confirmedRaw: string }) {
  const pos = () => railPosition(props.status, props.confirmedRaw);
  const meta = () => STATUS_META[props.status];
  const onMain = () => pos().branch === null;

  return (
    <div class="select-none">
      <div class="grid grid-cols-4">
        <For each={MAIN}>
          {(st, i) => {
            const reached = () => i() <= pos().step;
            const current = () => onMain() && i() === pos().step;
            // A payment that branched off left its last main step behind, so
            // that step counts as traversed rather than current.
            const done = () => reached() && !current();
            return (
              <div class="relative flex flex-col items-center pt-1">
                <Show when={i() > 0}>
                  <span
                    class={`absolute top-[8px] left-0 h-px w-1/2 ${
                      reached() ? "bg-ink-3" : "bg-hairline"
                    }`}
                  />
                </Show>
                <Show when={i() < MAIN.length - 1}>
                  <span
                    class={`absolute top-[8px] left-1/2 h-px w-1/2 ${
                      i() < pos().step ? "bg-ink-3" : "bg-hairline"
                    }`}
                  />
                </Show>
                <span
                  class={`relative z-10 block rounded-full border-[1.5px] transition-colors ${
                    current()
                      ? `${meta().border} ${meta().bg} ring-3 ring-panel`
                      : done()
                        ? "border-ink-3 bg-ink-3"
                        : "border-baseline bg-plane"
                  }`}
                  style={{ width: "11px", height: "11px", "margin-top": "2px" }}
                />
                <span
                  class={`mt-2.5 text-center text-[0.68rem] tracking-wide ${
                    current() ? meta().text : reached() ? "text-ink-2" : "text-ink-3/55"
                  }`}
                >
                  {STATUS_META[st].label}
                </span>
              </div>
            );
          }}
        </For>
      </div>

      {/* Dead-ends. Rendered always, so the paths not taken stay legible. */}
      <div class="mt-1 grid grid-cols-4">
        <For each={MAIN}>
          {(_st, i) => {
            const dead = (): PaymentStatus | null =>
              i() === 0 ? "expired" : i() === 2 ? "underpaid_expired" : null;
            return (
              <Show when={dead()} fallback={<div />}>
                {(status) => (
                  <div class="flex flex-col items-center">
                    <span
                      class={`h-4 w-px ${
                        pos().branch === status() ? "bg-ink-3" : "bg-hairline"
                      }`}
                    />
                    <span class="flex items-center gap-1.5">
                      {/* The mark recedes on a path not taken; the label stays readable. */}
                      <span class={pos().branch === status() ? "" : "opacity-45"}>
                        <StatusMark status={status()} size={8} />
                      </span>
                      <span
                        class={`text-[0.68rem] ${
                          pos().branch === status() ? STATUS_META[status()].text : "text-ink-3"
                        }`}
                      >
                        {STATUS_META[status()].label}
                      </span>
                    </span>
                  </div>
                )}
              </Show>
            );
          }}
        </For>
      </div>
    </div>
  );
}

// -- Meter -------------------------------------------------------------

/**
 * Share of the required amount confirmed.
 *
 * No tick for the dust threshold: at a 0.5% tolerance it would sit at 99.5% on
 * every payment ever rendered, so it encodes a constant rather than information.
 * The settle threshold is stated in words beside the meter instead.
 */
export function Meter(props: { pct: number; status: PaymentStatus; title?: string }) {
  return (
    <div class="h-[6px] w-full rounded-[4px] bg-baseline" title={props.title}>
      <div
        class={`h-full rounded-[4px] transition-[width] duration-500 ${
          STATUS_META[props.status].bg
        }`}
        style={{ width: `${props.pct}%` }}
      />
    </div>
  );
}

// -- Surfaces & fields -------------------------------------------------

export function Panel(props: {
  title?: string;
  aside?: JSX.Element;
  class?: string;
  children: JSX.Element;
}) {
  return (
    <section class={`rounded-md border border-hairline bg-panel ${props.class ?? ""}`}>
      <Show when={props.title}>
        <header class="flex flex-wrap items-baseline justify-between gap-3 border-b border-hairline px-4 py-2.5">
          <h2 class="text-[0.7rem] font-semibold tracking-[0.14em] text-ink-3 uppercase">
            {props.title}
          </h2>
          {props.aside}
        </header>
      </Show>
      {props.children}
    </section>
  );
}

export function Field(props: { label: string; hint?: string; children: JSX.Element }) {
  return (
    <div class="min-w-0">
      <dt class="text-[0.68rem] tracking-[0.1em] text-ink-3 uppercase">{props.label}</dt>
      <dd class="mt-1 min-w-0 text-[0.82rem] text-ink">{props.children}</dd>
      <Show when={props.hint}>
        <p class="mt-0.5 text-[0.68rem] text-ink-3">{props.hint}</p>
      </Show>
    </div>
  );
}

export function StatTile(props: {
  label: string;
  value: JSX.Element;
  sub?: string;
  tone?: string;
}) {
  return (
    <div class="px-4 py-3">
      <p class="text-[0.66rem] tracking-[0.12em] text-ink-3 uppercase">{props.label}</p>
      <p class={`mt-1.5 text-2xl leading-none tabular-nums ${props.tone ?? "text-ink"}`}>
        {props.value}
      </p>
      <Show when={props.sub}>
        <p class="mt-1.5 text-[0.7rem] text-ink-3">{props.sub}</p>
      </Show>
    </div>
  );
}

// -- Copyable / linkable values ----------------------------------------

export function CopyButton(props: { value: string; label: string }) {
  const [copied, setCopied] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));

  const copy = () => {
    navigator.clipboard?.writeText(props.value).then(() => {
      setCopied(true);
      clearTimeout(timer);
      timer = setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={`Copy ${props.label}`}
      title={copied() ? "Copied" : `Copy ${props.label}`}
      class="shrink-0 cursor-pointer rounded px-1 text-ink-3 transition-colors hover:text-ink focus-visible:ring-2 focus-visible:ring-ink-2 focus-visible:outline-none"
    >
      {copied() ? "✓" : "⧉"}
    </button>
  );
}

/** A hash or address: truncated mono text, copy button, optional explorer link. */
export function Hash(props: {
  value: string;
  explorer?: string;
  kind: "transaction" | "address";
  head?: number;
  tail?: number;
}) {
  const href = () => explorerUrl(props.explorer, props.value);
  const text = () => truncate(props.value, props.head ?? 10, props.tail ?? 8);

  return (
    <span class="inline-flex min-w-0 items-center gap-1.5">
      <Show
        when={href()}
        fallback={
          <span title={props.value} class="truncate font-mono text-[0.78rem] text-ink">
            {text()}
          </span>
        }
      >
        {(url) => (
          <a
            href={url()}
            target="_blank"
            rel="noreferrer"
            title={`${props.value} — open on explorer`}
            class="truncate font-mono text-[0.78rem] text-ink underline decoration-hairline decoration-1 underline-offset-3 transition-colors hover:decoration-ink-2 focus-visible:ring-2 focus-visible:ring-ink-2 focus-visible:outline-none"
          >
            {text()}
          </a>
        )}
      </Show>
      <CopyButton value={props.value} label={props.kind} />
    </span>
  );
}

// -- Form controls -----------------------------------------------------

const CONTROL =
  "h-8 rounded border border-hairline bg-plane px-2 text-[0.8rem] text-ink transition-colors hover:border-baseline focus-visible:border-ink-3 focus-visible:ring-2 focus-visible:ring-ink-3/40 focus-visible:outline-none";

export function Select(props: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  label: string;
}) {
  return (
    <select
      aria-label={props.label}
      value={props.value}
      onChange={(e) => props.onChange(e.currentTarget.value)}
      class={`${CONTROL} cursor-pointer`}
    >
      <For each={props.options}>
        {(o) => (
          <option value={o.value} selected={o.value === props.value}>
            {o.label}
          </option>
        )}
      </For>
    </select>
  );
}

export function SearchInput(props: {
  value: string;
  onInput: (v: string) => void;
  placeholder: string;
}) {
  return (
    <input
      type="search"
      aria-label="Search"
      value={props.value}
      onInput={(e) => props.onInput(e.currentTarget.value)}
      placeholder={props.placeholder}
      class={`${CONTROL} w-72 max-w-full font-mono placeholder:font-sans placeholder:text-ink-3`}
    />
  );
}

export function TextInput(props: {
  value: string;
  onInput: (v: string) => void;
  placeholder?: string;
  label: string;
  type?: string;
  mono?: boolean;
  disabled?: boolean;
}) {
  return (
    <input
      type={props.type ?? "text"}
      aria-label={props.label}
      value={props.value}
      disabled={props.disabled}
      onInput={(e) => props.onInput(e.currentTarget.value)}
      placeholder={props.placeholder}
      class={`${CONTROL} w-full disabled:opacity-50 placeholder:text-ink-3 ${
        props.mono ? "font-mono placeholder:font-sans" : ""
      }`}
    />
  );
}

export function TextArea(props: {
  value: string;
  onInput: (v: string) => void;
  placeholder?: string;
  label: string;
  rows?: number;
  invalid?: boolean;
}) {
  return (
    <textarea
      aria-label={props.label}
      aria-invalid={props.invalid || undefined}
      value={props.value}
      rows={props.rows ?? 4}
      onInput={(e) => props.onInput(e.currentTarget.value)}
      placeholder={props.placeholder}
      class={`w-full rounded border bg-plane px-2 py-1.5 font-mono text-[0.78rem] leading-relaxed text-ink transition-colors placeholder:font-sans placeholder:text-ink-3 focus-visible:ring-2 focus-visible:ring-ink-3/40 focus-visible:outline-none ${
        props.invalid
          ? "border-critical focus-visible:border-critical"
          : "border-hairline hover:border-baseline focus-visible:border-ink-3"
      }`}
    />
  );
}

const BUTTON_TONE = {
  default: "border-hairline text-ink-2 enabled:hover:border-baseline enabled:hover:text-ink",
  primary: "border-ink-3 bg-ink-3/15 text-ink enabled:hover:border-ink-2 enabled:hover:bg-ink-3/25",
  danger: "border-critical/60 text-critical enabled:hover:border-critical enabled:hover:bg-critical/10",
} as const;

export function Button(props: {
  onClick: () => void;
  children: JSX.Element;
  tone?: keyof typeof BUTTON_TONE;
  disabled?: boolean;
  title?: string;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={props.type ?? "button"}
      title={props.title}
      disabled={props.disabled}
      onClick={() => props.onClick()}
      class={`cursor-pointer rounded border px-3 py-1.5 text-[0.78rem] whitespace-nowrap transition-colors disabled:cursor-default disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ink-2 focus-visible:outline-none ${
        BUTTON_TONE[props.tone ?? "default"]
      }`}
    >
      {props.children}
    </button>
  );
}

const CALLOUT_TONE = {
  info: "border-hairline text-ink-3",
  warn: "border-warn/50 text-warn",
  critical: "border-critical/50 text-critical",
} as const;

/** A short standing note: a consequence, a caveat, a refusal. */
export function Callout(props: {
  tone?: keyof typeof CALLOUT_TONE;
  children: JSX.Element;
}) {
  return (
    <p
      class={`rounded border px-3 py-2 text-[0.72rem] leading-relaxed ${
        CALLOUT_TONE[props.tone ?? "info"]
      }`}
    >
      {props.children}
    </p>
  );
}

/**
 * A destructive action that states what it will do before it does it.
 *
 * Inline rather than a modal: `window.confirm` blocks the page, and a console
 * that freezes mid-incident to ask a question is worse than one that asks it in
 * place. Arming is per-instance, so two of these on a page cannot be confused.
 */
export function InlineConfirm(props: {
  label: string;
  confirmLabel: string;
  consequence: string;
  tone?: keyof typeof BUTTON_TONE;
  disabled?: boolean;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = createSignal(false);

  return (
    <Show
      when={armed()}
      fallback={
        <Button tone={props.tone ?? "danger"} disabled={props.disabled} onClick={() => setArmed(true)}>
          {props.label}
        </Button>
      }
    >
      <span class="inline-flex flex-wrap items-center gap-2">
        <span class="text-[0.72rem] text-ink-2">{props.consequence}</span>
        <Button
          tone={props.tone ?? "danger"}
          onClick={() => {
            setArmed(false);
            props.onConfirm();
          }}
        >
          {props.confirmLabel}
        </Button>
        <Button onClick={() => setArmed(false)}>Cancel</Button>
      </span>
    </Show>
  );
}

/** Two or three mutually exclusive modes, where a dropdown would hide the choice. */
export function SegmentedControl<T extends string>(props: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string; title?: string }>;
  label: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={props.label}
      class="inline-flex overflow-hidden rounded border border-hairline"
    >
      <For each={props.options}>
        {(o) => (
          <button
            type="button"
            role="radio"
            aria-checked={props.value === o.value}
            title={o.title}
            onClick={() => props.onChange(o.value)}
            class={`cursor-pointer px-3 py-1.5 text-[0.75rem] transition-colors focus-visible:ring-2 focus-visible:ring-ink-2 focus-visible:outline-none ${
              props.value === o.value
                ? "bg-ink-3/20 text-ink"
                : "text-ink-3 hover:bg-plane/60 hover:text-ink-2"
            }`}
          >
            {o.label}
          </button>
        )}
      </For>
    </div>
  );
}

/**
 * A credential, shown once.
 *
 * The server returns an API key or a webhook secret in the response to the call
 * that generated it and in no other response ever — so this panel is the only
 * moment the value exists outside the merchant's own records. It is therefore
 * dismissed by hand rather than on a timer or a navigation, and it says what
 * happens if it is closed too early.
 */
export function SecretReveal(props: {
  title: string;
  /** One row per credential — each labelled and separately copyable. */
  values: Array<{ label: string; value: string }>;
  note: string;
  onDismiss: () => void;
}) {
  return (
    <div class="rounded border border-warn/50 bg-warn/5 px-4 py-3">
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <h3 class="text-[0.7rem] font-semibold tracking-[0.12em] text-warn uppercase">
          {props.title}
        </h3>
        <span class="text-[0.66rem] tracking-[0.1em] text-warn uppercase">shown once</span>
      </div>
      <div class="mt-2 space-y-2">
        <For each={props.values}>
          {(item) => (
            <div>
              <span class="text-[0.64rem] tracking-[0.1em] text-ink-3 uppercase">
                {item.label}
              </span>
              <div class="mt-1 flex items-center gap-2 rounded border border-hairline bg-plane px-2.5 py-2">
                <code class="min-w-0 flex-1 font-mono text-[0.78rem] break-all text-ink select-all">
                  {item.value}
                </code>
                <CopyButton value={item.value} label={item.label} />
              </div>
            </div>
          )}
        </For>
      </div>
      <p class="mt-2 text-[0.7rem] leading-relaxed text-ink-2">{props.note}</p>
      <div class="mt-2.5">
        <Button onClick={props.onDismiss}>I have copied it — dismiss</Button>
      </div>
    </div>
  );
}

export function Empty(props: { children: JSX.Element }) {
  return <p class="px-4 py-8 text-center text-[0.8rem] text-ink-3">{props.children}</p>;
}

/** Pagination / table footer buttons. */
export function PageButton(props: {
  disabled?: boolean;
  onClick: () => void;
  children: JSX.Element;
}) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={() => props.onClick()}
      class="cursor-pointer rounded border border-hairline px-2.5 py-1 transition-colors enabled:hover:border-baseline enabled:hover:text-ink disabled:cursor-default disabled:opacity-35 focus-visible:ring-2 focus-visible:ring-ink-2 focus-visible:outline-none"
    >
      {props.children}
    </button>
  );
}
