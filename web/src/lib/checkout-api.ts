import type { PaymentStatus } from "./status";

export type PaymentView = {
  id: string;
  status: PaymentStatus;
  amount_cop: string;
  asset: string;
  network: string;
  amount_crypto_raw: string;
  confirmed_raw: string;
  overpaid_raw?: string;
  address: string;
  quote_expires_at: string;
  grace_expires_at: string | null;
  paid_at?: string | null;
  metadata?: unknown;
};

export type Checkout = {
  payment: PaymentView;
  payment_uri: string;
  /** Wallet deep link, or null on chains with no such standard (Tron). */
  wallet_uri: string | null;
  qr_data_url: string;
  decimals: number;
  family: "evm" | "tron";
  /** Window lengths, so a countdown can be drawn as a share of its span. */
  quote_ttl_sec: number;
  grace_ttl_sec: number;
};

export async function fetchCheckout(publicId: string): Promise<Checkout | null> {
  const res = await fetch(`/public/payments/${publicId}/checkout`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`checkout ${res.status}`);
  return (await res.json()) as Checkout;
}

export async function fetchStatus(publicId: string): Promise<PaymentView | null> {
  const res = await fetch(`/public/payments/${publicId}`);
  if (!res.ok) return null;
  return (await res.json()) as PaymentView;
}

export type CheckResult = {
  payment: PaymentView;
  /** Whether this request actually reached the chain (vs. served cached status). */
  checked: boolean;
  cooldown_ms: number;
};

/**
 * Asks the gateway to look at the chain for this payment right now.
 *
 * This is the cheap alternative to scanning every open payment continuously:
 * the chain read happens when the payer asks for it. Cooldown-gated server-side.
 */
export async function checkNow(publicId: string): Promise<CheckResult | null> {
  const res = await fetch(`/public/payments/${publicId}/check`, { method: "POST" });
  if (!res.ok) return null;
  return (await res.json()) as CheckResult;
}

// -- Formatting --------------------------------------------------------

/**
 * Raw token units -> the decimal string a wallet accepts.
 *
 * bigint string surgery rather than Number division: this is the number the
 * payer transcribes or pastes into a wallet, so it may not drift in the last
 * digits. Deliberately machine-formatted — a dot, no thousands separators —
 * even though the page is Spanish: it is copied into another program, and what
 * is displayed must be exactly what lands on the clipboard. The COP amount
 * beside it is human money and stays in es-CO.
 */
export function plainUnits(raw: string, decimals: number): string {
  const digits = raw.padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals).replace(/^0+(?=\d)/, "");
  const frac = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

export function fmtCop(amountCop: string): string {
  return Number(amountCop).toLocaleString("es-CO");
}

/**
 * The rate this charge was actually frozen at, derived from the pair it froze.
 *
 * The public payload carries the two amounts, not the rate; COP-per-token is
 * their quotient. It matches the stored rate to within the round-up applied
 * when the token amount was computed.
 */
export function impliedRate(amountCop: string, raw: string, decimals: number): number {
  const units = Number(BigInt(raw)) / 10 ** decimals;
  return units > 0 ? Number(amountCop) / units : 0;
}

export function fmtRate(rate: number): string {
  return rate.toLocaleString("es-CO", { maximumFractionDigits: 2 });
}
