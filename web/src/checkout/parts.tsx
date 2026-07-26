import { createSignal, onCleanup, Show, type JSX } from "solid-js";
import { MARK, type PaymentStatus } from "../lib/status";

/**
 * What each status means to the payer, in their words.
 *
 * `title` names the state, `note` says what to do about it — an interface that
 * reports "partially_paid" without saying "send the rest to the same address"
 * has told the payer nothing they can act on.
 */
export const STATUS_ES: Record<
  PaymentStatus,
  { title: string; note: string; ink: string; fill: string }
> = {
  pending: {
    title: "Esperando tu pago",
    note: "Envía el monto exacto a la dirección de esta orden.",
    ink: "text-violet",
    fill: "bg-violet",
  },
  detecting: {
    title: "Pago detectado",
    note: "Ya lo vimos en la red. Falta que la cadena lo confirme; no cierres esta página.",
    ink: "text-gold",
    fill: "bg-gold-bar",
  },
  partially_paid: {
    title: "Falta una parte",
    note: "Envía lo que falta a la misma dirección antes de que se acabe el plazo.",
    ink: "text-gold",
    fill: "bg-gold-bar",
  },
  paid: {
    title: "Pago confirmado",
    note: "Ya puedes cerrar esta página.",
    ink: "text-pine",
    fill: "bg-pine",
  },
  expired: {
    title: "La cotización venció",
    note: "No llegaron fondos a tiempo. Pídele al comercio un enlace nuevo.",
    ink: "text-print-3",
    fill: "bg-print-3",
  },
  underpaid_expired: {
    title: "Se acabó el plazo con el pago incompleto",
    note: "Tus fondos quedaron retenidos. Escríbele al comercio con esta referencia.",
    ink: "text-carmine",
    fill: "bg-carmine",
  },
};

/**
 * The page ground.
 *
 * No floating card: the viewport is the paper, and the band along the top edge
 * carries the payment's state, so it is legible at a glance from anywhere on
 * the page — including while scrolled past the status line.
 */
export function Slip(props: { band?: string; wide?: boolean; children: JSX.Element }) {
  return (
    <div class="min-h-screen bg-paper font-sans text-print antialiased">
      <div
        aria-hidden
        class={`fixed inset-x-0 top-0 z-50 h-[3px] transition-colors duration-500 ${
          props.band ?? "bg-violet"
        }`}
      />
      {/* A payment still open has two halves — what is owed and how to send it —
          and side by side they fit one screen. A closed one has only the first. */}
      <div
        class={`mx-auto w-full px-5 pt-9 pb-16 sm:pt-14 ${
          props.wide ? "max-w-[30rem] lg:max-w-[56rem]" : "max-w-[30rem]"
        }`}
      >
        {props.children}
      </div>
    </div>
  );
}

export function Eyebrow(props: { class?: string; children: JSX.Element }) {
  return (
    <p
      class={`text-[0.66rem] font-medium tracking-[0.18em] text-print-3 uppercase ${
        props.class ?? ""
      }`}
    >
      {props.children}
    </p>
  );
}

/** Filled / hollow / crossed — status never rests on hue alone. See lib/status. */
export function StatusMark(props: { status: PaymentStatus; class?: string; size?: number }) {
  const size = () => props.size ?? 9;
  const box = () => ({ width: `${size()}px`, height: `${size()}px` });

  return (
    <Show
      when={MARK[props.status] !== "cross"}
      fallback={
        <span aria-hidden class={`relative inline-block shrink-0 ${props.class ?? ""}`} style={box()}>
          <span class="absolute inset-x-0 top-1/2 h-[1.5px] -translate-y-1/2 rotate-45 bg-current" />
          <span class="absolute inset-x-0 top-1/2 h-[1.5px] -translate-y-1/2 -rotate-45 bg-current" />
        </span>
      }
    >
      <span
        aria-hidden
        class={`inline-block shrink-0 rounded-full border-[1.5px] border-current ${
          MARK[props.status] === "solid" ? "bg-current" : ""
        } ${props.class ?? ""}`}
        style={box()}
      />
    </Show>
  );
}

/**
 * Click-to-copy value.
 *
 * The whole field is the button: on a phone the address is the one thing the
 * payer must move into another app, and a 12px icon is not a target.
 */
export function CopyField(props: {
  value: string;
  label: string;
  done: string;
  /** Rendered beside the value but never copied — a wallet wants the number alone. */
  unit?: string;
  size?: "address" | "amount";
}) {
  const [copied, setCopied] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));

  const copy = () => {
    navigator.clipboard?.writeText(props.value).then(() => {
      setCopied(true);
      clearTimeout(timer);
      timer = setTimeout(() => setCopied(false), 1800);
    });
  };

  return (
    <div>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copiar ${props.label}`}
        class={`block w-full cursor-pointer rounded-sm border border-rule bg-paper-2 px-3.5 text-left font-mono break-all text-print transition-colors hover:border-violet/45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet ${
          props.size === "amount"
            ? "py-3 text-[1.35rem] leading-tight font-medium tabular-nums"
            : "py-3 text-[0.82rem] leading-relaxed"
        }`}
      >
        {props.value}
        <Show when={props.unit}>
          <span class="ml-2 font-sans text-[0.62em] font-semibold tracking-[0.14em] text-print-3 uppercase">
            {props.unit}
          </span>
        </Show>
      </button>
      <p aria-live="polite" class="mt-1.5 h-4 text-[0.7rem] text-pine">
        <Show when={copied()}>{props.done}</Show>
      </p>
    </div>
  );
}

const BUTTON =
  "block w-full rounded-sm px-5 py-3.5 text-center text-[0.92rem] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet";

export function PrimaryLink(props: { href: string; children: JSX.Element }) {
  return (
    <a href={props.href} class={`${BUTTON} bg-violet text-paper hover:bg-print`}>
      {props.children}
    </a>
  );
}

export function SecondaryButton(props: {
  onClick: () => void;
  disabled?: boolean;
  children: JSX.Element;
}) {
  return (
    <button
      type="button"
      onClick={() => props.onClick()}
      disabled={props.disabled}
      class={`${BUTTON} cursor-pointer border border-print/35 bg-transparent text-print hover:border-print hover:bg-print/5 disabled:cursor-wait disabled:text-print-3`}
    >
      {props.children}
    </button>
  );
}

/**
 * The receipt stamp.
 *
 * The one flourish on the page, and it only ever appears once a payment has
 * actually settled — the payer has been staring at a countdown, and the resolution
 * should feel like something landed rather than like a colour changing.
 */
export function Stamp(props: { at: string }) {
  return (
    <div class="anim-press flex justify-center py-2">
      <div class="-rotate-2 border-[1.5px] border-pine px-6 py-3 text-center text-pine">
        <div class="border-y border-pine/45 py-2">
          <p class="text-[1.05rem] font-semibold tracking-[0.22em] uppercase">Pagado</p>
          <p class="mt-1 font-mono text-[0.68rem] tracking-wide tabular-nums">{props.at}</p>
        </div>
      </div>
    </div>
  );
}
