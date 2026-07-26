import { createEffect, createSignal, Match, Show, Switch } from "solid-js";
import { useParams } from "@tanstack/solid-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/solid-query";
import {
  checkNow,
  fetchCheckout,
  fetchStatus,
  fmtCop,
  fmtRate,
  impliedRate,
  plainUnits,
  type Checkout,
  type PaymentView,
} from "../lib/checkout-api";
import { TERMINAL } from "../lib/status";
import { fmtDuration, useNow } from "../lib/clock";
import {
  CopyField,
  Eyebrow,
  PrimaryLink,
  SecondaryButton,
  Slip,
  Stamp,
  StatusMark,
  STATUS_ES,
} from "./parts";
import { NotFoundPage } from "./NotFoundPage";

export function CheckoutRoute() {
  const params = useParams({ from: "/pay/$publicId" });
  const publicId = () => params().publicId;
  const queryClient = useQueryClient();
  const [note, setNote] = createSignal("");

  // Static for the life of the payment: QR, wallet link, decimals, window lengths.
  const checkout = useQuery(() => ({
    queryKey: ["checkout", publicId()],
    queryFn: () => fetchCheckout(publicId()),
    staleTime: Infinity,
    retry: false,
  }));

  // The status poll reads our own database — no provider call — so it costs
  // nothing at Alchemy or TronGrid. It still has no reason to run once the
  // payment can no longer change, and it stops there.
  const status = useQuery(() => ({
    queryKey: ["status", publicId()],
    queryFn: () => fetchStatus(publicId()),
    enabled: !!checkout.data,
    placeholderData: () => checkout.data?.payment,
    refetchOnWindowFocus: true,
    refetchInterval: (query) => {
      const current = query.state.data?.status;
      return current && TERMINAL.includes(current) ? false : 10_000;
    },
  }));

  // The chain read the payer asks for. Everything else here is a database read;
  // this is the one call that spends provider quota, which is why it is a button.
  const check = useMutation(() => ({
    mutationFn: () => checkNow(publicId()),
    onSuccess: (result) => {
      if (!result) {
        setNote("No pudimos consultar la red. Intenta otra vez en unos segundos.");
        return;
      }
      queryClient.setQueryData(["status", publicId()], result.payment);
      if (TERMINAL.includes(result.payment.status) || result.payment.confirmed_raw !== "0") {
        setNote("");
        return;
      }
      setNote(
        result.checked
          ? "Todavía no vemos tu pago en la red. Si acabas de enviarlo, espera un momento y vuelve a intentar."
          : `Puedes volver a consultar en ${Math.ceil(result.cooldown_ms / 1000)} segundos.`
      );
    },
    onError: () => setNote("No pudimos consultar la red. Intenta otra vez en unos segundos."),
  }));

  return (
    <Switch
      fallback={
        <Slip>
          <p class="mt-20 text-center text-[0.84rem] text-print-3">Cargando la orden…</p>
        </Slip>
      }
    >
      <Match when={checkout.data === null}>
        <NotFoundPage />
      </Match>
      <Match when={checkout.isError}>
        <Slip band="bg-carmine">
          <p class="mt-16 font-display text-[1.7rem] leading-tight text-print">
            No pudimos cargar la orden
          </p>
          <p class="mt-3 text-[0.88rem] leading-relaxed text-print-2">
            Revisa tu conexión y vuelve a cargar la página. Si sigue igual, escríbele al
            comercio.
          </p>
        </Slip>
      </Match>
      <Match when={checkout.data && status.data}>
        <Slip
          band={STATUS_ES[status.data!.status].fill}
          wide={!TERMINAL.includes(status.data!.status)}
        >
          <PaymentSlip
            checkout={checkout.data!}
            payment={status.data!}
            checking={check.isPending}
            note={note()}
            onCheck={() => {
              setNote("");
              check.mutate();
            }}
          />
        </Slip>
      </Match>
    </Switch>
  );
}

function PaymentSlip(props: {
  checkout: Checkout;
  payment: PaymentView;
  checking: boolean;
  note: string;
  onCheck: () => void;
}) {
  const now = useNow(1000);
  const meta = () => STATUS_ES[props.payment.status];
  const decimals = () => props.checkout.decimals;

  const required = () => BigInt(props.payment.amount_crypto_raw);
  const confirmed = () => BigInt(props.payment.confirmed_raw);
  const overpaid = () => BigInt(props.payment.overpaid_raw ?? "0");
  const remaining = () => (required() > confirmed() ? required() - confirmed() : 0n);
  const partial = () => confirmed() > 0n && remaining() > 0n;
  const pct = () =>
    required() > 0n ? Number((confirmed() * 10_000n) / required()) / 100 : 0;

  const live = () => !TERMINAL.includes(props.payment.status);
  const onGrace = () => props.payment.grace_expires_at != null;

  /**
   * The quote lock.
   *
   * One rule binds the COP charge to the token amount, and the share of it still
   * inked is the share of the window still running — the frozen rate and the time
   * it stays frozen are the same object, because for the payer they are. A
   * settled payment fills the rule; a closed one empties it.
   */
  const spanMs = () =>
    (onGrace() ? props.checkout.grace_ttl_sec : props.checkout.quote_ttl_sec) * 1000;
  const leftMs = () =>
    Math.max(
      0,
      new Date(props.payment.grace_expires_at ?? props.payment.quote_expires_at).getTime() - now()
    );
  const heldPct = () => {
    if (props.payment.status === "paid") return 100;
    if (!live()) return 0;
    return Math.min(100, Math.max(0, (leftMs() / spanMs()) * 100));
  };

  /** What the rule is measuring, which is not the same thing once it stops moving. */
  const lockLabel = () => {
    if (props.payment.status === "paid") return "Tasa aplicada";
    if (!live()) return "Tasa vencida";
    return onGrace() ? "Plazo para completar" : "Tasa congelada";
  };

  const reference = () =>
    (props.payment.metadata as { order_id?: string } | null)?.order_id ?? props.payment.id;

  const paidAt = () => {
    const at = new Date(props.payment.paid_at ?? Date.now());
    const date = at.toLocaleDateString("es-CO", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
    const time = at.toLocaleTimeString("es-CO", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    return `${date} · ${time}`;
  };

  createEffect(() => {
    document.title = `${meta().title} · $${fmtCop(props.payment.amount_cop)} COP`;
  });

  return (
    <>
      <header class="flex items-baseline justify-between gap-4 border-b border-rule pb-3">
        <Eyebrow>Orden de pago</Eyebrow>
        <span class="truncate font-mono text-[0.72rem] text-print-2">{reference()}</span>
      </header>

      <div class={live() ? "lg:grid lg:grid-cols-2 lg:items-start lg:gap-x-14" : ""}>
      <div>
      <div class="mt-4 flex items-start gap-2.5">
        <StatusMark status={props.payment.status} class={`mt-[6px] ${meta().ink}`} />
        <div class="min-w-0">
          <p class={`text-[0.95rem] font-medium ${meta().ink}`}>{meta().title}</p>
          <p class="mt-0.5 text-[0.8rem] leading-relaxed text-print-2">{meta().note}</p>
        </div>
      </div>

      {/* The charge, the lock, and the amount to send — the page's thesis. */}
      <section class="mt-9">
        <Eyebrow class="anim-rise">Cobro</Eyebrow>
        <p class="anim-rise mt-1.5 font-display text-[clamp(2.6rem,13vw,3.5rem)] leading-[0.95] font-medium tracking-[-0.015em] text-print">
          <span class="mr-1 align-[0.38em] text-[0.42em] text-print-3">$</span>
          {fmtCop(props.payment.amount_cop)}
          <span class="ml-2.5 align-[0.85em] font-sans text-[0.2em] font-semibold tracking-[0.22em] text-print-3 uppercase">
            COP
          </span>
        </p>

        <div class="mt-6 mb-7">
          <div class="relative h-px w-full bg-rule">
            <div
              class={`anim-draw absolute inset-y-0 left-0 transition-[width] duration-1000 ease-linear ${meta().fill}`}
              style={{ width: `${heldPct()}%` }}
            />
          </div>
          <div class="mt-2.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <Eyebrow>{lockLabel()}</Eyebrow>
            <p class="font-mono text-[0.74rem] text-print-2 tabular-nums">
              1 {props.payment.asset} = $
              {fmtRate(
                impliedRate(
                  props.payment.amount_cop,
                  props.payment.amount_crypto_raw,
                  decimals()
                )
              )}
              <Show when={live()}>
                <span class={`ml-2.5 font-medium ${meta().ink}`}>{fmtDuration(leftMs())}</span>
              </Show>
            </p>
          </div>
        </div>

        <Show when={live()}>
          <Eyebrow class="mb-1.5">
            {partial() ? "Te falta enviar" : "Envías exactamente"}
          </Eyebrow>
          <CopyField
            size="amount"
            value={plainUnits((partial() ? remaining() : required()).toString(), decimals())}
            unit={props.payment.asset}
            label="el monto"
            done="Monto copiado"
          />
          {/* What has landed, then what to do about it. */}
          <Show when={confirmed() > 0n}>
            <div class="mb-3">
              <div class="h-[3px] w-full bg-rule">
                <div
                  class={`h-full transition-[width] duration-700 ${meta().fill}`}
                  style={{ width: `${pct()}%` }}
                />
              </div>
              <p class="mt-2 text-[0.76rem] leading-relaxed text-print-2">
                Ya recibimos {plainUnits(props.payment.confirmed_raw, decimals())} de{" "}
                {plainUnits(props.payment.amount_crypto_raw, decimals())} {props.payment.asset}.
              </p>
            </div>
          </Show>

          <p class="text-[0.76rem] leading-relaxed text-print-2">
            {partial()
              ? "Envía la diferencia a la misma dirección. La tasa sigue siendo la de arriba."
              : "El monto quedó fijo al crear la orden. Aunque el precio se mueva, envías exactamente esto."}
          </p>
        </Show>
      </section>

      <Show when={props.payment.status === "paid"}>
        <div class="mt-10">
          <Stamp at={paidAt()} />
          <p class="mt-5 text-center text-[0.8rem] leading-relaxed text-print-2">
            Recibimos {plainUnits(props.payment.confirmed_raw, decimals())}{" "}
            {props.payment.asset} en {props.payment.network}.
            <Show when={overpaid() > 0n}>
              {" "}
              Enviaste {plainUnits(overpaid().toString(), decimals())} {props.payment.asset} de
              más; el comercio puede devolvértelos.
            </Show>
          </p>
        </div>
      </Show>

      <Show when={props.payment.status === "underpaid_expired" && confirmed() > 0n}>
        <div class="mt-9 border border-carmine/35 bg-paper-2 px-4 py-3.5">
          <Eyebrow>Fondos retenidos</Eyebrow>
          <p class="mt-1.5 font-mono text-[1rem] font-medium text-print tabular-nums">
            {plainUnits(props.payment.confirmed_raw, decimals())} {props.payment.asset}
          </p>
          <p class="mt-1.5 text-[0.78rem] leading-relaxed text-print-2">
            Llegaron a tiempo pero no completaban el cobro. Escríbele al comercio con la
            referencia de abajo para que te los devuelva o cierre la orden.
          </p>
        </div>
      </Show>
      </div>

      {/* Pay zone. On a phone the wallet link comes first and the QR last — a QR
          on the same screen as the wallet is the least useful of the three. */}
      <Show when={live()}>
        <section class="mt-9 flex flex-col gap-5 lg:mt-4">
          <figure class="order-3 sm:order-1">
            <div class="mx-auto w-fit rounded-sm border border-rule bg-paper-2 p-3">
              <img
                src={props.checkout.qr_data_url}
                alt={`Código QR con la dirección de pago en ${props.payment.network}`}
                width={216}
                height={216}
                class="block h-[216px] w-[216px]"
              />
            </div>
            <figcaption class="mt-2.5 text-center text-[0.74rem] text-print-3">
              Escanea con tu wallet · red {props.payment.network}
            </figcaption>
          </figure>

          <div class="order-2">
            <Eyebrow class="mb-1.5">Dirección de esta orden</Eyebrow>
            <CopyField
              value={props.payment.address}
              label="la dirección"
              done="Dirección copiada"
            />
          </div>

          <div class="order-1 sm:order-3">
            <Show
              when={props.checkout.wallet_uri}
              fallback={
                // Tron has no payment-link standard, so nothing can be pre-filled:
                // the payer types the amount, and the page says so plainly.
                <div class="border-l-2 border-gold-bar bg-paper-2 px-4 py-3">
                  <p class="text-[0.82rem] font-medium text-print">Escribe el monto a mano</p>
                  <p class="mt-1 text-[0.78rem] leading-relaxed text-print-2">
                    Las wallets de Tron no admiten enlaces de pago. Copia el monto y la
                    dirección de esta orden, y envía <b>{props.payment.asset}</b> por la red{" "}
                    <b>{props.payment.network}</b>. Si envías otro token o usas otra red, los
                    fondos se pierden.
                  </p>
                </div>
              }
            >
              {(uri) => <PrimaryLink href={uri()}>Abrir en la wallet</PrimaryLink>}
            </Show>
          </div>

          <div class="order-4">
            <SecondaryButton onClick={() => props.onCheck()} disabled={props.checking}>
              {props.checking ? "Buscando en la red…" : "Ya envié el pago — búscalo"}
            </SecondaryButton>
            <p
              aria-live="polite"
              class="mt-2 min-h-9 text-[0.76rem] leading-relaxed text-print-2"
            >
              {props.note}
            </p>
          </div>
        </section>
      </Show>
      </div>

      <footer class="mt-12 flex flex-wrap justify-between gap-x-4 gap-y-1 border-t border-rule pt-4 text-[0.68rem] text-print-3">
        <span>
          Referencia <span class="font-mono text-print-2">{props.payment.id}</span>
        </span>
        <span>{props.payment.network}</span>
      </footer>
    </>
  );
}
