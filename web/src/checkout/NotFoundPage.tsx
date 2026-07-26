import { Eyebrow, Slip } from "./parts";

/**
 * Shown for a payment id the gateway does not know, and for any other path the
 * router cannot match. An empty screen is an invitation to act: it says which
 * thing is missing and who can produce a working one.
 */
export function NotFoundPage() {
  return (
    <Slip band="bg-print-3">
      <header class="border-b border-rule pb-3">
        <Eyebrow>Orden de pago</Eyebrow>
      </header>
      <p class="mt-10 font-display text-[1.9rem] leading-tight text-print">
        Este enlace de pago no existe
      </p>
      <p class="mt-3 text-[0.88rem] leading-relaxed text-print-2">
        Puede que esté incompleto o que la orden ya se haya cerrado. Pídele al comercio un
        enlace nuevo — cada orden genera el suyo.
      </p>
    </Slip>
  );
}
