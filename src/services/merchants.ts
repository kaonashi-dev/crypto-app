/**
 * Merchant credentials: how an API key is minted, hashed and referred to.
 *
 * Small, and deliberately shared. The hash written when a key is issued and the
 * hash computed when one is presented have to be the same function — a drift
 * between them is not a visible bug, it is every one of that merchant's requests
 * failing authentication for no stated reason. `src/api/auth.ts` verifies with
 * `hashApiKey`, `src/api/admin-write.ts` and `scripts/seed.ts` issue with it.
 *
 * SHA-256 and not argon2id, on purpose, and the opposite of the choice made for
 * operator passwords in ./admin-auth.ts: a 24-byte random key has no guessable
 * structure, so there is nothing for a slow hash to protect against, and the
 * verification happens on the merchant's hot path.
 */
import { randomBytes } from "crypto";
import { env } from "../config";

const API_KEY_BYTES = 24;
const WEBHOOK_SECRET_BYTES = 24;

/** How much of a key hash is enough to match a log line to a merchant. */
const HASH_PREFIX_LENGTH = 12;

export async function hashApiKey(key: string): Promise<string> {
  return Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key))
  ).toString("hex");
}

/**
 * A new API key, in plaintext.
 *
 * Returned to exactly one HTTP response and stored nowhere: the database keeps
 * the hash, and if the merchant loses the key it is rotated, not recovered.
 * The `test`/`live` marker follows NODE_ENV so a key pasted into the wrong
 * environment is recognisable as such before it is used.
 */
export function newApiKey(): string {
  return `gk_${env.isProduction ? "live" : "test"}_${randomBytes(API_KEY_BYTES).toString("hex")}`;
}

/**
 * A new webhook signing secret, in plaintext.
 *
 * Stored as-is rather than hashed, because HMAC signing needs the secret itself —
 * this is a shared key, not a credential we verify against.
 */
export function newWebhookSecret(): string {
  return `whsec_${randomBytes(WEBHOOK_SECRET_BYTES).toString("hex")}`;
}

/**
 * The public handle for a key: the first bytes of its *hash*, never of the key.
 *
 * This is what `src/api/auth.ts` logs when it rejects an unrecognised key, so
 * showing the same prefix on the merchant's console page is what lets an operator
 * match a rejection to the account it was aimed at — without the console ever
 * displaying something that could be replayed.
 */
export const apiKeyHashPrefix = (hash: string): string => hash.slice(0, HASH_PREFIX_LENGTH);
