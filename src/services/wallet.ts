import { mnemonicToAccount } from "viem/accounts";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { env } from "../config";

/** Atomically reserves the next derivation index. */
export async function reserveDerivationIndex(): Promise<number> {
  return db.transaction(async (tx) => {
    const rows = await tx.execute(sql`
      INSERT INTO hd_counter (id, next_index) VALUES (1, 1)
      ON CONFLICT (id) DO UPDATE SET next_index = hd_counter.next_index + 1
      RETURNING next_index - 1 AS idx
    `);
    return Number((rows as unknown as Array<{ idx: number }>)[0]!.idx);
  });
}

/** Derives the address m/44'/60'/0'/0/{index} (EVM standard). */
export function deriveAddress(index: number): `0x${string}` {
  const account = mnemonicToAccount(env.mnemonic, { addressIndex: index });
  return account.address;
}
