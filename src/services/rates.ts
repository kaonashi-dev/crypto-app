import { COINGECKO_IDS, env } from "../config";

type Cached<T> = { value: T; fetchedAt: number };

const rateCache = new Map<string, Cached<bigint>>();
let fxCache: Cached<number> | null = null;

const RATE_TTL_MS = 60_000; // asset quote: refresh every minute
const FX_TTL_MS = 600_000; // USD->COP moves slowly: 10 minutes is plenty
const STALE_MS = 600_000; // how long a cached value may cover for an outage

/**
 * USD price of 1 whole unit of the asset, from CoinGecko.
 *
 * We quote against USD (not COP directly) because CoinGecko dropped COP from
 * `/simple/supported_vs_currencies` — asking for `vs_currencies=cop` now returns
 * HTTP 200 with an empty object, so the COP leg has to come from an FX source.
 */
async function fetchUsdPrice(asset: string): Promise<number> {
  const id = COINGECKO_IDS[asset];
  if (!id) throw new Error(`Unsupported asset: ${asset}`);

  const res = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd&precision=6`
  );
  if (!res.ok) throw new Error(`CoinGecko error ${res.status}`);

  const data = (await res.json()) as Record<string, { usd?: number }>;
  const price = data[id]?.usd;
  if (typeof price !== "number" || !(price > 0)) {
    throw new Error(`No USD price for ${asset}`);
  }
  return price;
}

/** USD -> COP from the primary FX provider, falling back to a secondary one. */
async function fetchUsdCop(): Promise<number> {
  const sources: Array<{ url: string; pick: (json: any) => unknown }> = [
    { url: "https://open.er-api.com/v6/latest/USD", pick: (j) => j?.rates?.COP },
    {
      url: "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json",
      pick: (j) => j?.usd?.cop,
    },
  ];

  const errors: string[] = [];
  for (const source of sources) {
    try {
      const res = await fetch(source.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rate = source.pick(await res.json());
      if (typeof rate !== "number" || !(rate > 0)) throw new Error("no COP rate in response");
      return rate;
    } catch (e: any) {
      errors.push(`${new URL(source.url).host}: ${e.message}`);
    }
  }
  throw new Error(`FX lookup failed (${errors.join("; ")})`);
}

/** USD -> COP, cached, with a stale-cache and static-fallback safety net. */
async function getUsdCop(): Promise<number> {
  if (fxCache && Date.now() - fxCache.fetchedAt < FX_TTL_MS) return fxCache.value;

  try {
    const rate = await fetchUsdCop();
    fxCache = { value: rate, fetchedAt: Date.now() };
    return rate;
  } catch (e) {
    if (fxCache && Date.now() - fxCache.fetchedAt < STALE_MS) return fxCache.value;
    if (env.fallbackUsdCop) return env.fallbackUsdCop;
    throw e;
  }
}

/**
 * Returns COP per 1 whole unit of the asset, scaled x1e6, with the spread
 * already applied (in the gateway's favor).
 * e.g. USDC at 4,100.25 COP -> 4_100_250_000n
 *
 * Computed as (asset -> USD) x (USD -> COP). Any failure along the way falls
 * back to a cached quote up to STALE_MS old before giving up, so a blip at
 * either provider does not take the checkout down.
 */
export async function getRateCopE6(asset: string): Promise<bigint> {
  const hit = rateCache.get(asset);
  if (hit && Date.now() - hit.fetchedAt < RATE_TTL_MS) return hit.value;

  try {
    const [usdPrice, usdCop] = await Promise.all([fetchUsdPrice(asset), getUsdCop()]);

    const marketE6 = BigInt(Math.round(usdPrice * usdCop * 1e6));
    // spread: the payer pays a bit more crypto for the same COP ->
    // we lower the COP-per-token rate by spreadBps.
    const withSpread = (marketE6 * (10_000n - env.spreadBps)) / 10_000n;
    if (withSpread <= 0n) throw new Error(`Nonsensical rate for ${asset}`);

    rateCache.set(asset, { value: withSpread, fetchedAt: Date.now() });
    return withSpread;
  } catch (e) {
    // Any failure (bad status, malformed body, FX outage) may be covered by a
    // not-too-stale cache before we refuse to quote.
    if (hit && Date.now() - hit.fetchedAt < STALE_MS) return hit.value;
    throw e;
  }
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
