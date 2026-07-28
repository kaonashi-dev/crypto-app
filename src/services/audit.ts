/**
 * The console's audit trail: who changed what through /admin, and when.
 *
 * `AGENTS.md` holds `/admin` to no console-driven mutation without an audit model
 * to go with it. This module *is* that model, and every write route on the console
 * goes through it — a mutation that is not recorded here is a bug, not an
 * optimisation.
 *
 * Three rules the rest of the console depends on:
 *
 *  1. **The row is written in the mutation's own transaction.** `recordAudit`
 *     takes the caller's transaction handle rather than opening its own, so a
 *     committed change cannot exist without its record. The one path that cannot
 *     do this is called out on `recordDetachedAudit` below.
 *  2. **`detail` is built by hand at each call site**, from an explicit list of
 *     fields. Never a spread of a database row: a `clients` row carries
 *     `apiKeyHash` and `webhookSecret`, and a spread is how both would end up in a
 *     table that is deliberately never deleted from.
 *  3. **No secret reaches this table.** Rule 2 is the intent; `scrub()` below is
 *     the enforcement, because "the call site was careful" is not a property
 *     anyone can verify a year later.
 *
 * Attribute namespace `audit.*` — see docs/LOGGING.md.
 */
import { and, count as countRows, desc, eq } from "drizzle-orm";
import { db, schema } from "../db";
import type { Operator } from "./admin-auth";
import { count, currentContext, getLogger, isSecretKey, redact } from "../observability";

const log = getLogger("audit");

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const MASK = "***";

/** Enough to recognise the browser; not an access log. */
const USER_AGENT_MAX = 300;

/** Every action the console can record. Also the filter list the UI offers. */
export const AUDIT_ACTIONS = [
  "merchant.create",
  "merchant.update",
  "merchant.deactivate",
  "merchant.delete",
  "merchant.api_key.rotate",
  "merchant.webhook_secret.rotate",
  "payment.create",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type AuditEntry = {
  /** Never null: `requireOperator` refuses the request when nobody is signed in. */
  operator: Operator;
  action: AuditAction;
  targetType: "client" | "payment" | "operator";
  targetId: string | null;
  detail?: Record<string, unknown>;
  outcome?: "ok" | "denied" | "error";
  ip?: string | null;
  userAgent?: string | null;
};

/**
 * Masks anything credential-shaped, at any depth.
 *
 * The key rule is the one the log sink already applies to attributes
 * (`isSecretKey`), so "what counts as a secret name" is defined once for the whole
 * process. The serialized result then goes through `redact()` as well, which
 * catches a secret that arrived as a *value* — an environment literal pasted into
 * a merchant name, say — rather than under a telling key.
 */
function scrubValue(value: unknown): unknown {
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(scrubValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, inner]) => [
        key,
        isSecretKey(key) ? MASK : scrubValue(inner),
      ])
    );
  }
  return value;
}

function scrub(detail: Record<string, unknown>): string {
  return redact(JSON.stringify(scrubValue(detail)));
}

/**
 * Records one mutation, inside the transaction that performs it.
 *
 * The log record deliberately omits `detail`: the row holds the full before/after,
 * while the log line holds the handles you search by. Both carry the same trace
 * id, so `/admin/api/logs?q=<trace>` expands any row here into the request that
 * produced it.
 */
export async function recordAudit(tx: Tx, entry: AuditEntry): Promise<void> {
  const outcome = entry.outcome ?? "ok";

  await tx.insert(schema.adminAuditLog).values({
    operatorId: entry.operator.id,
    operatorUsername: entry.operator.username,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    detail: entry.detail ? scrub(entry.detail) : null,
    outcome,
    ipAddress: entry.ip ?? null,
    userAgent: entry.userAgent?.slice(0, USER_AGENT_MAX) ?? null,
    traceId: currentContext()?.traceId ?? null,
  });

  count("admin.mutations", { action: entry.action, outcome });
  log.info("console mutation", {
    "audit.action": entry.action,
    "audit.target_type": entry.targetType,
    "audit.target_id": entry.targetId,
    "audit.outcome": outcome,
    "operator.id": entry.operator.id,
    "operator.username": entry.operator.username,
    "client.address": entry.ip,
  });
}

/**
 * Records a mutation that could not share a transaction with the change itself.
 *
 * One caller: `POST /admin/api/payments`. It reuses `createPayment()` from
 * services/payments.ts rather than reimplementing it, and that function owns its
 * own insert — threading a transaction handle through a core settlement service to
 * satisfy the console would be a worse trade than this gap.
 *
 * So the gap is stated rather than hidden: if this insert fails, the payment still
 * exists and the attribution is missing from the table. It is not missing from the
 * *process* — the failure is logged at error, and the `payment created` record the
 * service emitted carries the same trace id as the operator's request. Everything
 * else on the console writes its row transactionally.
 */
export async function recordDetachedAudit(entry: AuditEntry): Promise<void> {
  try {
    await db.transaction((tx) => recordAudit(tx, entry));
  } catch (e) {
    count("admin.mutations", { action: entry.action, outcome: "audit_failed" });
    log.error("mutation happened but its audit row could not be written", {
      "audit.action": entry.action,
      "audit.target_type": entry.targetType,
      "audit.target_id": entry.targetId,
      "operator.id": entry.operator.id,
      "operator.username": entry.operator.username,
      err: e,
    });
  }
}

export type AuditQuery = {
  action?: string;
  targetType?: string;
  targetId?: string;
  operatorId?: string;
  limit?: number;
  offset?: number;
};

export type AuditRow = typeof schema.adminAuditLog.$inferSelect;

/** Reads the trail back, newest first. Mapped to the wire by src/api/admin.ts. */
export async function auditTrail(
  q: AuditQuery
): Promise<{ total: number; entries: AuditRow[] }> {
  const conds = [];
  if (q.action) conds.push(eq(schema.adminAuditLog.action, q.action));
  if (q.targetType) conds.push(eq(schema.adminAuditLog.targetType, q.targetType));
  if (q.targetId) conds.push(eq(schema.adminAuditLog.targetId, q.targetId));
  if (q.operatorId) conds.push(eq(schema.adminAuditLog.operatorId, q.operatorId));
  const where = conds.length ? and(...conds) : undefined;

  const [entries, total] = await Promise.all([
    db
      .select()
      .from(schema.adminAuditLog)
      .where(where)
      .orderBy(desc(schema.adminAuditLog.createdAt))
      .limit(q.limit ?? 50)
      .offset(q.offset ?? 0),
    db.select({ n: countRows() }).from(schema.adminAuditLog).where(where),
  ]);

  return { total: Number(total[0]?.n ?? 0), entries };
}
