export type PaymentStatus =
  | "pending"
  | "detecting"
  | "partially_paid"
  | "paid"
  | "expired"
  | "underpaid_expired";

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
  qr_data_url: string;
  decimals: number;
};

/** publicId is the last path segment of /pay/:publicId */
export function publicIdFromPath(): string {
  const parts = window.location.pathname.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

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

/** Format a raw token amount (bigint string) into a human decimal string. */
export function fmtRaw(raw: string, decimals: number, maxFractionDigits = 6): string {
  const value = Number(BigInt(raw)) / 10 ** decimals;
  return value.toFixed(decimals > 2 ? maxFractionDigits : 2);
}

export function fmtCop(amountCop: string): string {
  return Number(amountCop).toLocaleString("es-CO");
}

export const TERMINAL: PaymentStatus[] = ["paid", "expired", "underpaid_expired"];
