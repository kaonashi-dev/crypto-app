import type { PaymentStatus } from "../lib/status";
import { setSessionExpired } from "./auth";

// -- Wire types (mirror src/api/admin.ts responses) ---------------------

export type NetworkMeta = {
  id: string;
  family: "evm" | "tron";
  confirmations: number;
  explorer: { tx: string; address: string };
  chain_id: number | null;
};

export type Stats = {
  payments: {
    total: number;
    by_status: Record<PaymentStatus, number>;
    by_network: Array<{ network: string; n: number }>;
    paid_cop: string;
  };
  deposits: { total: number; unconfirmed: number };
  webhooks: { pending: number; delivered: number; dead: number };
  clients: number;
  config: {
    quote_ttl_min: number;
    grace_ttl_min: number;
    spread_bps: number;
    dust_bps: number;
  };
  networks: NetworkMeta[];
  statuses: PaymentStatus[];
};

export type ClientRow = {
  id: string;
  name: string;
  balance_cop: string;
  webhook_url: string | null;
  is_active: boolean;
  created_at: string;
  payments: number;
};

export type PaymentRow = {
  id: string;
  client_id: string;
  client_name: string;
  status: PaymentStatus;
  amount_cop: string;
  asset: string;
  network: string;
  amount_crypto_raw: string;
  confirmed_raw: string;
  pending_raw: string;
  overpaid_raw: string;
  address: string;
  decimals: number;
  quote_expires_at: string;
  grace_expires_at: string | null;
  paid_at: string | null;
  created_at: string;
  metadata: unknown;
  deposits: number;
};

export type DepositRow = {
  id: string;
  tx_hash: string;
  log_index: number;
  network: string;
  from_address: string;
  amount_raw: string;
  block_number: string;
  confirmed: boolean;
  created_at: string;
  payment_id: string;
  payment_status: PaymentStatus;
  asset: string;
  decimals: number;
};

export type WebhookRow = {
  id: string;
  event: string;
  attempts: number;
  next_attempt_at: string;
  delivered_at: string | null;
  created_at: string;
  payload: string;
};

export type LedgerRow = {
  id: string;
  amount_cop: string;
  type: string;
  created_at: string;
};

export type PaymentDetail = {
  payment: PaymentRow & {
    uuid: string;
    threshold_raw: string;
    rate_cop_per_unit_e6: string;
    derivation_index: number;
    updated_at: string;
  };
  client: {
    id: string;
    name: string;
    balance_cop: string;
    webhook_url: string | null;
    is_active: boolean;
  };
  token: { address: string; decimals: number; symbol: string } | null;
  network: NetworkMeta | null;
  deposits: Array<Omit<DepositRow, "network" | "payment_id" | "payment_status" | "asset" | "decimals">>;
  webhooks: WebhookRow[];
  ledger: LedgerRow[];
};

export type UserRow = {
  id: string;
  username: string;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
  active_sessions: number;
  is_you: boolean;
};

export type UsersResponse = {
  /** Null when the console is running open — nobody is signed in as anyone. */
  signed_in_as: string | null;
  bootstrap_username: string;
  session_ttl_hours: number;
  users: UserRow[];
};

export type PaymentFilters = {
  status?: string;
  network?: string;
  client_id?: string;
  q?: string;
};

// -- Fetchers ----------------------------------------------------------

/**
 * A lapsed session, raised once for the whole console.
 *
 * Every console request funnels through here, so the session guard's 401 is
 * turned into the signal AdminLayout watches in exactly one place — no route has
 * to think about expiry, and none can forget to.
 */
function noteUnauthorized(res: Response) {
  if (res.status === 401) setSessionExpired(true);
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`/admin/api${path}`);
  if (!res.ok) {
    noteUnauthorized(res);
    throw new Error(`${path} -> ${res.status}`);
  }
  return (await res.json()) as T;
}

export const fetchStats = () => get<Stats>("/stats");
export const fetchClients = () => get<{ clients: ClientRow[] }>("/clients");

export function fetchPayments(filters: PaymentFilters, limit = 50, offset = 0) {
  const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  for (const [k, v] of Object.entries(filters)) if (v) qs.set(k, v);
  return get<{ total: number; limit: number; offset: number; payments: PaymentRow[] }>(
    `/payments?${qs}`
  );
}

/** Resolves to null on 404 so a bad link renders "not found" instead of throwing. */
export async function fetchPaymentDetail(publicId: string): Promise<PaymentDetail | null> {
  const res = await fetch(`/admin/api/payments/${publicId}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    noteUnauthorized(res);
    throw new Error(`payment ${res.status}`);
  }
  return (await res.json()) as PaymentDetail;
}

export const fetchUsers = () => get<UsersResponse>("/users");

export function fetchDeposits(filters: { network?: string; confirmed?: string; q?: string }) {
  const qs = new URLSearchParams({ limit: "100" });
  for (const [k, v] of Object.entries(filters)) if (v) qs.set(k, v);
  return get<{ deposits: DepositRow[] }>(`/deposits?${qs}`);
}

// -- Formatting --------------------------------------------------------

/**
 * Raw token units -> human decimal string, exactly.
 *
 * Done with bigint string surgery rather than Number division: a raw USDC
 * amount can exceed 2^53 and this console's whole job is showing the truth
 * about amounts.
 */
export function fmtUnits(raw: string, decimals: number): string {
  const neg = raw.startsWith("-");
  const digits = (neg ? raw.slice(1) : raw).padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const frac = digits.slice(digits.length - decimals).replace(/0+$/, "");
  const int = BigInt(whole).toLocaleString("en-US");
  return `${neg ? "-" : ""}${int}${frac ? `.${frac}` : ""}`;
}

export function fmtCop(amountCop: string | null): string {
  if (amountCop == null) return "—";
  return BigInt(amountCop).toLocaleString("es-CO");
}

/** rate_cop_per_unit_e6 -> "4,100.25 COP / USDC". */
export function fmtRate(rateE6: string, asset: string): string {
  const cop = Number(BigInt(rateE6)) / 1e6;
  return `${cop.toLocaleString("es-CO", { maximumFractionDigits: 2 })} COP / ${asset}`;
}

export function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** "4m 12s ago" / "in 8m 03s" — the shape you need when watching a grace window. */
export function fmtRelative(iso: string | null, now = Date.now()): string {
  if (!iso) return "—";
  const ms = new Date(iso).getTime() - now;
  const past = ms < 0;
  const total = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const span = h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m ${String(sec).padStart(2, "0")}s`;
  return past ? `${span} ago` : `in ${span}`;
}

export function truncate(v: string, head = 10, tail = 8): string {
  return v.length <= head + tail + 1 ? v : `${v.slice(0, head)}…${v.slice(-tail)}`;
}

export function explorerUrl(template: string | undefined, value: string): string | null {
  return template ? template.replace("{v}", value) : null;
}

/** Percentage of the required amount confirmed so far, clamped for the meter. */
export function paidPct(confirmedRaw: string, requiredRaw: string): number {
  const req = BigInt(requiredRaw);
  if (req <= 0n) return 0;
  const pct = Number((BigInt(confirmedRaw) * 10_000n) / req) / 100;
  return Math.min(Math.max(pct, 0), 100);
}
