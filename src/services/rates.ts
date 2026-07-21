import { COINGECKO_IDS, env } from "../config";

type RateCache = { copPerUnitE6: bigint; fetchedAt: number };
const cache = new Map<string, RateCache>();
const TTL_MS = 60_000;

/**
 * Returns COP per 1 whole unit of the asset, scaled x1e6, with the spread
 * already applied (in the gateway's favor).
 * e.g. USDC at 4,100.25 COP -> 4_100_250_000n
 */
export async function getRateCopE6(asset: string): Promise<bigint> {
  const hit = cache.get(asset);
  if (hit && Date.now() - hit.fetchedAt < TTL_MS) return hit.copPerUnitE6;

  const id = COINGECKO_IDS[asset];
  if (!id) throw new Error(`Unsupported asset: ${asset}`);

  const res = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=cop&precision=6`
  );
  if (!res.ok) {
    // If CoinGecko fails and we have a not-too-stale cache (< 10 min), use it.
    if (hit && Date.now() - hit.fetchedAt < 600_000) return hit.copPerUnitE6;
    throw new Error(`CoinGecko error ${res.status}`);
  }
  const data = (await res.json()) as Record<string, { cop: number }>;
  const price = data[id]?.cop;
  if (typeof price !== "number") throw new Error(`No COP price for ${asset}`);

  const marketE6 = BigInt(Math.round(price * 1e6));
  // spread: the payer pays a bit more crypto for the same COP ->
  // we lower the COP-per-token rate by spreadBps.
  const withSpread = (marketE6 * (10_000n - env.spreadBps)) / 10_000n;
  cache.set(asset, { copPerUnitE6: withSpread, fetchedAt: Date.now() });
  return withSpread;
}

/**
 * Converts COP -> raw token units.
 * amountRaw = amountCop / rate * 10^decimals, ALWAYS rounding up so the
 * merchant never receives less than the COP value.
 */
export function copToRaw(
  amountCop: bigint,
  rateCopPerUnitE6: bigint,
  decimals: number
): bigint {
  const scale = 10n ** BigInt(decimals);
  const num = amountCop * 1_000_000n * scale;
  return (num + rateCopPerUnitE6 - 1n) / rateCopPerUnitE6; // ceil division
}
