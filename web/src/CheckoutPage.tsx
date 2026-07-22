import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchCheckout,
  fetchStatus,
  fmtCop,
  fmtRaw,
  publicIdFromPath,
  TERMINAL,
  type Checkout,
  type PaymentStatus,
  type PaymentView,
} from "./api";

const STATUS_META: Record<
  PaymentStatus,
  { label: string; pill: string; tone: "wait" | "partial" | "ok" | "dead" }
> = {
  pending: { label: "Esperando pago…", pill: "bg-amber-100 text-amber-800", tone: "wait" },
  detecting: { label: "Pago detectado, confirmando…", pill: "bg-blue-100 text-blue-700", tone: "partial" },
  partially_paid: { label: "Pago parcial recibido", pill: "bg-blue-100 text-blue-700", tone: "partial" },
  paid: { label: "✅ Pago recibido", pill: "bg-green-100 text-green-700", tone: "ok" },
  expired: { label: "⏱ Cotización vencida. Genera un nuevo pago.", pill: "bg-red-100 text-red-700", tone: "dead" },
  underpaid_expired: {
    label: "⚠️ Pago incompleto y tiempo agotado. Contacta soporte.",
    pill: "bg-red-100 text-red-700",
    tone: "dead",
  },
};

function useCountdown(target: Date | null) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (!target) return "";
  const ms = target.getTime() - Date.now();
  if (ms <= 0) return "";
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

function StatusPill({ status }: { status: PaymentStatus }) {
  const meta = STATUS_META[status];
  return (
    <div className={`inline-block rounded-full px-4 py-1.5 text-sm font-semibold ${meta.pill}`}>
      {meta.label}
    </div>
  );
}

function ProgressBar({ pct }: { pct: number }) {
  return (
    <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-200">
      <div
        className="h-full rounded-full bg-blue-600 transition-[width] duration-500"
        style={{ width: `${Math.min(Math.max(pct, 0), 100)}%` }}
      />
    </div>
  );
}

export function CheckoutPage() {
  const publicId = useMemo(publicIdFromPath, []);
  const [checkout, setCheckout] = useState<Checkout | undefined>(undefined);
  const [payment, setPayment] = useState<PaymentView | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [copied, setCopied] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Initial load (static data + first status snapshot).
  useEffect(() => {
    let alive = true;
    fetchCheckout(publicId)
      .then((c) => {
        if (!alive) return;
        if (!c) {
          setNotFound(true);
          return;
        }
        setCheckout(c);
        setPayment(c.payment);
      })
      .catch(() => alive && setNotFound(true));
    return () => {
      alive = false;
    };
  }, [publicId]);

  // Poll status until a terminal state is reached.
  useEffect(() => {
    if (!checkout) return;
    const tick = async () => {
      const p = await fetchStatus(publicId);
      if (p) {
        setPayment(p);
        if (TERMINAL.includes(p.status) && pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      }
    };
    pollRef.current = setInterval(tick, 3000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [checkout, publicId]);

  const copyAddress = useCallback(() => {
    if (!payment) return;
    navigator.clipboard?.writeText(payment.address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [payment]);

  const graceTarget = payment?.grace_expires_at ? new Date(payment.grace_expires_at) : null;
  const quoteTarget = payment?.quote_expires_at ? new Date(payment.quote_expires_at) : null;
  const countdown = useCountdown(graceTarget ?? quoteTarget);

  if (notFound) {
    return (
      <Shell>
        <p className="text-lg font-semibold text-slate-800">Pago no encontrado</p>
        <p className="mt-2 text-sm text-slate-500">El enlace de pago no es válido o expiró.</p>
      </Shell>
    );
  }

  if (!checkout || !payment) {
    return (
      <Shell>
        <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" />
        <p className="mt-4 text-sm text-slate-500">Cargando…</p>
      </Shell>
    );
  }

  const decimals = checkout.decimals;
  const required = BigInt(payment.amount_crypto_raw);
  const confirmed = BigInt(payment.confirmed_raw);
  const remaining = required > confirmed ? required - confirmed : 0n;
  const pct = required > 0n ? Number((confirmed * 100n) / required) : 0;

  const meta = STATUS_META[payment.status];
  const isTerminalDead = meta.tone === "dead";
  const isPaid = payment.status === "paid";
  const isPartial = payment.status === "partially_paid" || payment.status === "detecting";
  const showPayZone = !isPaid && !isTerminalDead;

  const countdownLabel = graceTarget ? "Tiempo para completar el pago" : "Cotización válida por";

  return (
    <Shell>
      <p className="text-sm text-slate-500">Total a pagar</p>
      <p className="my-1 text-3xl font-bold text-slate-900">
        {fmtRaw(payment.amount_crypto_raw, decimals)} {payment.asset}
      </p>
      <p className="text-sm text-slate-500">
        ≈ ${fmtCop(payment.amount_cop)} COP · red {payment.network}
      </p>

      {showPayZone && (
        <div className="mt-5">
          <img
            src={checkout.qr_data_url}
            alt="QR de pago"
            width={280}
            height={280}
            className="mx-auto rounded-xl"
          />
          <button
            type="button"
            onClick={copyAddress}
            title="Clic para copiar"
            className="mt-4 block w-full cursor-pointer break-all rounded-lg bg-slate-100 px-3 py-2.5 text-left font-mono text-[0.78rem] text-slate-700 transition hover:bg-slate-200"
          >
            {payment.address}
          </button>
          <p className="mt-1 h-4 text-xs text-green-600">{copied ? "¡Dirección copiada!" : ""}</p>
          <a
            href={checkout.payment_uri}
            className="mt-3 inline-block rounded-xl bg-slate-900 px-6 py-3 font-semibold text-white transition hover:bg-slate-700"
          >
            Abrir en wallet
          </a>
          {countdown && (
            <p className="mt-3 text-xs text-slate-400">
              {countdownLabel}: {countdown}
            </p>
          )}
        </div>
      )}

      <div className="mt-5">
        <StatusPill status={payment.status} />
      </div>

      {isPartial && (
        <div className="mt-1">
          <ProgressBar pct={pct} />
          <p className="mt-2 text-xs text-slate-500">
            Recibido {fmtRaw(payment.confirmed_raw, decimals)} · faltan{" "}
            {fmtRaw(remaining.toString(), decimals)} {payment.asset}. Envía la diferencia a la misma
            dirección antes de que venza el tiempo.
          </p>
        </div>
      )}

      {isPaid && payment.overpaid_raw && BigInt(payment.overpaid_raw) > 0n && (
        <p className="mt-2 text-xs text-slate-500">
          Se recibió un excedente de {fmtRaw(payment.overpaid_raw, decimals)} {payment.asset}.
        </p>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-start justify-center bg-slate-100 px-4 py-10">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 text-center shadow-xl shadow-slate-200/60">
        {children}
      </div>
    </div>
  );
}
