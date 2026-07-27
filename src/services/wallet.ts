import { sql } from "drizzle-orm";
import { db } from "../db";
import { getLogger } from "../observability";
import { seedFingerprint } from "./derivation";

// Derivation itself is pure and lives in derivation.ts; it is re-exported here
// because this module is what the payment path and the scripts already import.
export {
  deriveAddress,
  deriveEvmAddress,
  deriveTronAddress,
  seedFingerprint,
} from "./derivation";

const log = getLogger("wallet");

type CounterRow = { next_index: number; seed_fingerprint: string | null };

/**
 * Raised when the derivation counter in the database belongs to a different
 * mnemonic than the configured one.
 *
 * Fatal by construction: the indexes already handed out derive from the other
 * tree, so continuing would either publish an address whose key nobody present
 * holds, or — once a counter is reset alongside the swap — reissue an address
 * that was already given to a payer and can still receive funds.
 */
export class SeedMismatchError extends Error {
  constructor(
    readonly stored: string,
    readonly configured: string,
    readonly issued: number
  ) {
    super(
      `HD_MNEMONIC derives tree ${configured}, but this database issued its ` +
        `${issued} derivation index(es) from tree ${stored}. Restore the previous ` +
        `HD_MNEMONIC, or point at a fresh database — never mix two trees in one counter.`
    );
    this.name = "SeedMismatchError";
  }
}

/**
 * Atomically reserves the next derivation index — for the configured tree only.
 *
 * The fingerprint is a predicate inside the same statement rather than a check
 * before it: a seed swapped between check and insert would otherwise slip an
 * index from the wrong tree into the sequence. A row that fails the predicate
 * does not update and returns nothing, which is the mismatch signal, so the
 * guarantee costs no extra query on the happy path.
 */
export async function reserveDerivationIndex(): Promise<number> {
  const fingerprint = seedFingerprint();
  const done = log.time("derivation index reserved");
  return db.transaction(async (tx) => {
    const rows = await tx.execute(sql`
      INSERT INTO hd_counter (id, next_index, seed_fingerprint)
      VALUES (1, 1, ${fingerprint})
      ON CONFLICT (id) DO UPDATE
        SET next_index = hd_counter.next_index + 1,
            seed_fingerprint = ${fingerprint}
        WHERE hd_counter.seed_fingerprint IS NULL
           OR hd_counter.seed_fingerprint = ${fingerprint}
      RETURNING next_index - 1 AS idx
    `);
    const row = (rows as unknown as Array<{ idx: number }>)[0];
    if (row) {
      const index = Number(row.idx);
      done({ "wallet.derivation_index": index, "wallet.seed_fingerprint": fingerprint });
      return index;
    }

    // Only reachable through the fingerprint predicate: read the stored value so
    // the error names the tree the counter actually belongs to.
    const stored = await tx.execute(sql`
      SELECT next_index, seed_fingerprint FROM hd_counter WHERE id = 1
    `);
    const state = (stored as unknown as Array<CounterRow>)[0];
    throw new SeedMismatchError(
      state?.seed_fingerprint ?? "unknown",
      fingerprint,
      Number(state?.next_index ?? 0)
    );
  });
}

/**
 * Verifies at boot that the counter belongs to the configured mnemonic, so a
 * wrong `HD_MNEMONIC` fails on deploy instead of on the day's first payment.
 *
 * `reserveDerivationIndex` enforces the same invariant on every issue and is
 * what actually guarantees it; this is the early warning. A counter that
 * predates fingerprint tracking adopts the current tree — there is nothing to
 * compare against — and says so when indexes were already issued, since that is
 * the one case where the adoption may be recording a mistake.
 */
export async function assertSeedIdentity(): Promise<{ fingerprint: string; issued: number }> {
  const fingerprint = seedFingerprint();
  const rows = await db.execute(sql`
    SELECT next_index, seed_fingerprint FROM hd_counter WHERE id = 1
  `);
  const state = (rows as unknown as Array<CounterRow>)[0];

  // No counter row yet: nothing has been issued, so every tree is consistent.
  if (!state) return { fingerprint, issued: 0 };

  const issued = Number(state.next_index);
  if (state.seed_fingerprint === null) {
    await db.execute(sql`
      UPDATE hd_counter SET seed_fingerprint = ${fingerprint}
      WHERE id = 1 AND seed_fingerprint IS NULL
    `);
    if (issued > 0) {
      log.warn("adopted the current tree for a counter that predates fingerprinting", {
        "wallet.seed_fingerprint": fingerprint,
        "wallet.issued_indexes": issued,
        hint: "confirm those addresses derive from this HD_MNEMONIC before trusting them",
      });
    }
    return { fingerprint, issued };
  }

  if (state.seed_fingerprint !== fingerprint) {
    throw new SeedMismatchError(state.seed_fingerprint, fingerprint, issued);
  }
  return { fingerprint, issued };
}
