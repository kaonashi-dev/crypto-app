import type { PaymentStatus } from "../lib/status";
import { setSessionExpired } from "./auth";

// -- Wire types (mirror src/api/admin.ts responses) ---------------------

export type NetworkMeta = {
  id: string;
  family: "evm" | "tron";
  confirmations: number;
  explorer: { tx: string; address: string };
  chain_id: number | null;
  testnet: boolean;
  tokens: string[];
  /** Symbol of the chain's own coin, or null when it is not accepted. */
  native: string | null;
  /**
   * Whether the gateway still offers this network. A withheld mainnet keeps its
   * definition — old payments have to keep rendering — but takes no new ones.
   */
  offered: boolean;
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
  sweeps: {
    by_status: Record<SweepStatus, number>;
    unswept: UnsweptRow[];
  };
  config: {
    quote_ttl_min: number;
    grace_ttl_min: number;
    spread_bps: number;
    dust_bps: number;
    sweep_enabled: boolean;
    sweep_dry_run: boolean;
    sweep_min_usd: number;
    sweep_max_cost_bps: number;
    /** `network/ASSET:mechanism` for every pairing this build can consolidate. */
    sweep_pairings: string[];
  };
  networks: NetworkMeta[];
  statuses: PaymentStatus[];
};

export type SweepStatus =
  | "planned"
  | "authorized"
  | "broadcast"
  | "confirmed"
  | "failed"
  | "skipped";

/** Confirmed in minus confirmed out, per (network, asset). */
export type UnsweptRow = {
  network: string;
  asset: string;
  decimals: number;
  confirmed_raw: string;
  swept_raw: string;
  unswept_raw: string;
};

export type SweepRow = {
  id: string;
  network: string;
  address: string;
  derivation_index: number;
  asset: string;
  amount_raw: string;
  decimals: number;
  to_address: string;
  via: string;
  status: SweepStatus;
  /** Why a row is skipped or failed: 'below_floor', 'fee_too_high', … */
  reason: string | null;
  tx_hash: string | null;
  block_number: string | null;
  /** In the network's fee currency, which is not always an asset we quote. */
  fee_raw: string | null;
  fee_asset: string;
  fee_decimals: number;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  authorization_nonce: string | null;
  valid_before: string | null;
  created_at: string;
  updated_at: string;
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
  /** The asset that actually arrived, which is not always the one quoted. */
  asset: string;
  payment_asset: string;
  /** False when the deposit is in an asset the payment never quoted. */
  settles: boolean;
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
  // `address` is null for a chain-native coin: there is no contract behind it.
  token: {
    address: string | null;
    decimals: number;
    symbol: string;
    kind: "token" | "native";
  } | null;
  network: NetworkMeta | null;
  deposits: Array<
    Omit<DepositRow, "network" | "payment_id" | "payment_status" | "payment_asset"> & {
      network?: undefined;
    }
  >;
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

// -- Write surface (mirrors src/api/admin-write.ts) ---------------------

/** One recorded mutation. `detail` was secret-scrubbed server-side. */
export type AuditEntry = {
  id: string;
  operator_id: string | null;
  operator_username: string;
  action: string;
  target_type: string;
  target_id: string | null;
  outcome: string;
  detail: unknown;
  ip_address: string | null;
  user_agent: string | null;
  /** Searchable in the log tail — expands this row into its whole request. */
  trace_id: string | null;
  created_at: string;
};

export type MerchantDetail = {
  client: ClientRow & { api_key_hash_prefix: string };
  payments: { total: number; by_status: Record<PaymentStatus, number> };
  ledger: { entries: number; credited_cop: string };
  webhooks: { total: number; pending: number; dead: number };
  references: { payments: number; ledger_entries: number; webhook_jobs: number };
  /** False when a hard delete would orphan settlement history. */
  deletable: boolean;
  audit: AuditEntry[];
};

/**
 * A response that carries a credential.
 *
 * Both fields are present exactly once, on the call that generated them, and are
 * never served again by any read — so whatever the console does with them here is
 * the only chance it gets.
 */
export type MerchantCreated = {
  client: ClientRow & { api_key_hash_prefix: string };
  api_key: string;
  webhook_secret: string;
};

export type PaymentCreated = {
  id: string;
  status: PaymentStatus;
  amount_cop: string;
  asset: string;
  network: string;
  amount_crypto_raw: string;
  confirmed_raw: string;
  overpaid_raw: string;
  address: string;
  quote_expires_at: string;
  grace_expires_at: string | null;
  paid_at: string | null;
  metadata: unknown;
  checkout_url: string;
};

/** The body of GET /api/payments/:publicId/status. */
export type PaymentStatusView = {
  id: string;
  status: PaymentStatus;
  terminal: boolean;
  asset: string;
  network: string;
  decimals: number | null;
  amount_cop: string;
  amount_crypto_raw: string;
  confirmed_raw: string;
  pending_raw: string;
  overpaid_raw: string;
  quote_expires_at: string;
  grace_expires_at: string | null;
  paid_at: string | null;
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

export type AssetBalance = {
  asset: string;
  raw: string;
  decimals: number;
  kind: "token" | "native";
  /** True for the coin this chain charges fees in — what a relayer must hold. */
  is_fee_currency: boolean;
};

export type WalletInfo = {
  role: "treasury" | "relayer";
  address: string | null;
  balances: AssetBalance[];
  /** Why there is nothing to report, when there is nothing to report. */
  note: string | null;
};

export type NetworkWallets = {
  network: string;
  family: "evm" | "tron";
  testnet: boolean;
  /** False when the RPC did not answer: balances are unknown, not zero. */
  reachable: boolean;
  error: string | null;
  wallets: WalletInfo[];
};

export type WalletsResponse = {
  networks: NetworkWallets[];
  age_s: number;
  cache_ttl_s: number;
  sweep: { enabled: boolean; dry_run: boolean; signer: string; pairings: string[] };
};

export const fetchWallets = () => get<WalletsResponse>("/wallets");

export function fetchSweeps(filters: { network?: string; status?: string; q?: string }) {
  const qs = new URLSearchParams({ limit: "100" });
  for (const [k, v] of Object.entries(filters)) if (v) qs.set(k, v);
  return get<{ total: number; limit: number; statuses: SweepStatus[]; sweeps: SweepRow[] }>(
    `/sweeps?${qs}`
  );
}

export const fetchMerchant = (id: string) => get<MerchantDetail>(`/clients/${id}`);

export function fetchAudit(filters: { action?: string; target_id?: string } = {}) {
  const qs = new URLSearchParams({ limit: "100" });
  for (const [k, v] of Object.entries(filters)) if (v) qs.set(k, v);
  return get<{ total: number; actions: string[]; entries: AuditEntry[] }>(`/audit?${qs}`);
}

// -- Mutations ---------------------------------------------------------

/**
 * Raised by every console mutation, carrying enough to explain itself.
 *
 * A write can fail for reasons a read never does — a refused webhook URL, a
 * merchant that still has payments pointing at it, an open console that may not
 * mutate at all — and each of those answers is a body the operator needs to see
 * rather than a generic "request failed".
 */
export class ConsoleError extends Error {
  constructor(
    readonly status: number,
    readonly body: any,
    message: string
  ) {
    super(message);
  }
}

async function write<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(`/admin/api${path}`, {
    method,
    // The guard in src/api/admin-auth.ts requires this on any request with a
    // body: it is the half of the CSRF defence that does not rest on the
    // browser honouring SameSite.
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" } }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    noteUnauthorized(res);
    const detail =
      typeof payload?.details === "string"
        ? payload.details
        : (payload?.error ?? `${method} ${path} -> ${res.status}`);
    throw new ConsoleError(res.status, payload, detail);
  }
  return payload as T;
}

export const createMerchant = (body: { name: string; webhook_url: string | null }) =>
  write<MerchantCreated>("/clients", "POST", body);

export const updateMerchant = (
  id: string,
  body: { name?: string; webhook_url?: string | null; is_active?: boolean }
) => write<{ client: ClientRow }>(`/clients/${id}`, "PATCH", body);

export const rotateApiKey = (id: string) =>
  write<{ client: ClientRow; api_key: string }>(`/clients/${id}/api-key`, "POST", {});

export const rotateWebhookSecret = (id: string) =>
  write<{ client: ClientRow; webhook_secret: string }>(
    `/clients/${id}/webhook-secret`,
    "POST",
    {}
  );

/** Soft by default; `hard` deletes the row and is refused when anything points at it. */
export const deleteMerchant = (id: string, hard = false) =>
  write<{ client?: ClientRow; deleted: boolean }>(
    `/clients/${id}${hard ? "?hard=true" : ""}`,
    "DELETE"
  );

// -- The request builder's two modes -----------------------------------

export type PaymentRequestBody = {
  amount_cop: string;
  asset: string;
  network: string;
  metadata?: unknown;
};

/**
 * What came back, whatever it was.
 *
 * The Build view renders the real response — status line, trace id and body —
 * including when it is a 400, because showing an integrator the actual rejection
 * is most of what makes the view worth having. So this never throws: a failure is
 * a result here, not an exception.
 */
export type RawResponse = {
  status: number;
  ok: boolean;
  trace_id: string | null;
  body: unknown;
  /** The request as it was actually sent, for the transcript. */
  sent: { method: string; url: string; headers: Record<string, string>; body?: string };
};

async function raw(
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: unknown
): Promise<RawResponse> {
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  const res = await fetch(url, { method, headers, body: serialized });
  const parsed = await res.json().catch(() => null);
  if (res.status === 401 && url.startsWith("/admin/")) noteUnauthorized(res);

  return {
    status: res.status,
    ok: res.ok,
    // Minted per request by the middleware in src/api/routes.ts; the handle to
    // search the log tail with when something went wrong.
    trace_id: res.headers.get("x-trace-id"),
    body: parsed,
    sent: { method, url, headers, body: serialized },
  };
}

/** The documented merchant integration path, exercised for real, with a real key. */
export const createPaymentAsMerchant = (apiKey: string, body: PaymentRequestBody) =>
  raw("POST", "/api/payments", {
    "Content-Type": "application/json",
    "X-Api-Key": apiKey,
  }, body);

/** The console's own path, for a merchant whose key is not recoverable. */
export const createPaymentAsOperator = (clientId: string, body: PaymentRequestBody) =>
  raw("POST", "/admin/api/payments", { "Content-Type": "application/json" }, {
    ...body,
    client_id: clientId,
  });

export const fetchStatusAsMerchant = (apiKey: string, publicId: string) =>
  raw("GET", `/api/payments/${publicId}/status`, { "X-Api-Key": apiKey });

/**
 * The operator's equivalent. There is no `/admin/api/.../status` — the console
 * already has a richer read of the same row, so adding one would be a second way
 * to ask the same question.
 */
export const fetchStatusAsOperator = (publicId: string) =>
  raw("GET", `/admin/api/payments/${publicId}`, {});

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
