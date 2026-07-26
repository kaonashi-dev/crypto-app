export type PaymentStatus =
  | "pending"
  | "detecting"
  | "partially_paid"
  | "paid"
  | "expired"
  | "underpaid_expired";

/** Statuses that never change again, so nothing needs to keep polling them. */
export const TERMINAL: PaymentStatus[] = ["paid", "expired", "underpaid_expired"];

/**
 * The non-colour channel, shared by both surfaces.
 *
 * Status is drawn as a filled dot (live and progressing), a hollow ring
 * (waiting, nothing has happened yet) or a cross (closed). Hue is always
 * accompanied by one of these plus a label, so status survives colour-vision
 * deficiency — and on the console `pending` and `expired` deliberately share the
 * same neutral ink, which only the mark tells apart.
 */
export type Mark = "solid" | "ring" | "cross";

export const MARK: Record<PaymentStatus, Mark> = {
  pending: "ring",
  detecting: "solid",
  partially_paid: "solid",
  paid: "solid",
  expired: "cross",
  underpaid_expired: "cross",
};
