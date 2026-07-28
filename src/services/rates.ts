import { COINGECKO_IDS, env } from "../config";
import { getLogger, count, observe, safeUrl } from "../observability";

type Cached<T> = { value: T; fetchedAt: number };

const rateCache = new Map<string, Cached<bigint>>();
let fxCache: Cached<number> | null = null;

const RATE_TTL_MS = 60_000; // asset quote: refresh every minute
const FX_TTL_MS = 600_000; // USD->COP moves slowly: 10 minutes is plenty
const STALE_MS = 600_000; // how long a cached value may cover for an outage

/**
 * Pricing log.
 *
 * A quote is frozen into the payment row, so "why was the amount that" is only
 * answerable after the fact from what was recorded here: which provider
 * answered, what it said, whether the value came from cache or a stale fallback,
 * and the spread applied on top.
 */
const log = getLogger("rates");

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

  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd&precision=6`;
  const started = performance.now();
  const res = await fetch(url);
  const ms = performance.now() - started;

  observe("http.client.duration", ms, { host: "api.coingecko.com" });
  count("http.client.requests", { host: "api.coingecko.com", status: res.status });
  log.debug("coingecko price request", {
    "http.request.method": "GET",
    "server.address": "api.coingecko.com",
    "url.full": safeUrl(url),
    "http.response.status_code": res.status,
    "rate.asset": asset,
    duration_ms: Math.round(ms),
  });

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
  for (const [index, source] of sources.entries()) {
    const host = new URL(source.url).host;
    try {
      const started = performance.now();
      const res = await fetch(source.url);
      const ms = performance.now() - started;
      observe("http.client.duration", ms, { host });
      count("http.client.requests", { host, status: res.status });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rate = source.pick(await res.json());
      if (typeof rate !== "number" || !(rate > 0)) throw new Error("no COP rate in response");

      log.debug("fx rate fetched", {
        "server.address": host,
        "url.full": safeUrl(source.url),
        "http.response.status_code": res.status,
        "rate.usd_cop": rate,
        "rate.provider_rank": index === 0 ? "primary" : "secondary",
        duration_ms: Math.round(ms),
      });
      if (index > 0) {
        log.warn("fx served by the secondary provider", { "server.address": host });
      }
      return rate;
    } catch (e: any) {
      count("http.client.errors", { host });
      log.warn("fx provider failed", { "server.address": host, err: e });
      errors.push(`${host}: ${e.message}`);
    }
  }
  throw new Error(`FX lookup failed (${errors.join("; ")})`);
}

/** USD -> COP, cached, with a stale-cache and static-fallback safety net. */
async function getUsdCop(): Promise<number> {
  if (fxCache && Date.now() - fxCache.fetchedAt < FX_TTL_MS) {
    log.trace("fx cache hit", {
      "rate.usd_cop": fxCache.value,
      "cache.age_s": Math.round((Date.now() - fxCache.fetchedAt) / 1000),
    });
    count("rates.cache", { leg: "fx", result: "hit" });
    return fxCache.value;
  }

  count("rates.cache", { leg: "fx", result: "miss" });
  try {
    const rate = await fetchUsdCop();
    fxCache = { value: rate, fetchedAt: Date.now() };
    return rate;
  } catch (e) {
    // Degradation ladder: stale cache, then the static floor, then refuse.
    if (fxCache && Date.now() - fxCache.fetchedAt < STALE_MS) {
      count("rates.degraded", { leg: "fx", source: "stale_cache" });
      log.warn("fx providers down — serving a stale cached rate", {
        "rate.usd_cop": fxCache.value,
        "cache.age_s": Math.round((Date.now() - fxCache.fetchedAt) / 1000),
        "cache.max_age_s": STALE_MS / 1000,
        err: e,
      });
      return fxCache.value;
    }
    if (env.fallbackUsdCop) {
      count("rates.degraded", { leg: "fx", source: "static_fallback" });
      log.error("fx providers down and no fresh cache — using FALLBACK_USD_COP", {
        "rate.usd_cop": env.fallbackUsdCop,
        err: e,
      });
      return env.fallbackUsdCop;
    }
    count("rates.degraded", { leg: "fx", source: "refused" });
    log.error("fx providers down, no cache, no fallback — refusing to quote", { err: e });
    throw e;
  }
}

/**
 * The USD -> COP leg on its own, cache, degradation ladder and all.
 *
 * Exposed for the sweeper, whose floor is configured in USD (`SWEEP_MIN_USD`)
 * while every amount it works with is in raw token units. No spread is applied:
 * this is a threshold, not a quote, and moving it in the gateway's favour would
 * only mean sweeping slightly later.
 */
export function getUsdCopRate(): Promise<number> {
  return getUsdCop();
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
  if (hit && Date.now() - hit.fetchedAt < RATE_TTL_MS) {
    count("rates.cache", { leg: "asset", result: "hit" });
    log.debug("rate cache hit", {
      "rate.asset": asset,
      "rate.cop_per_unit_e6": hit.value,
      "cache.age_s": Math.round((Date.now() - hit.fetchedAt) / 1000),
    });
    return hit.value;
  }

  count("rates.cache", { leg: "asset", result: "miss" });
  const done = log.time("rate quoted");
  try {
    const [usdPrice, usdCop] = await Promise.all([fetchUsdPrice(asset), getUsdCop()]);

    const marketE6 = BigInt(Math.round(usdPrice * usdCop * 1e6));
    // spread: the payer pays a bit more crypto for the same COP ->
    // we lower the COP-per-token rate by spreadBps.
    const withSpread = (marketE6 * (10_000n - env.spreadBps)) / 10_000n;
    if (withSpread <= 0n) throw new Error(`Nonsensical rate for ${asset}`);

    rateCache.set(asset, { value: withSpread, fetchedAt: Date.now() });
    // Every input to the frozen quote, on one line.
    done(
      {
        "rate.asset": asset,
        "rate.asset_usd": usdPrice,
        "rate.usd_cop": usdCop,
        "rate.market_cop_e6": marketE6,
        "rate.cop_per_unit_e6": withSpread,
        "config.spread_bps": Number(env.spreadBps),
      },
      "info"
    );
    return withSpread;
  } catch (e) {
    // Any failure (bad status, malformed body, FX outage) may be covered by a
    // not-too-stale cache before we refuse to quote.
    if (hit && Date.now() - hit.fetchedAt < STALE_MS) {
      count("rates.degraded", { leg: "asset", source: "stale_cache" });
      log.warn("pricing failed — serving a stale cached quote", {
        "rate.asset": asset,
        "rate.cop_per_unit_e6": hit.value,
        "cache.age_s": Math.round((Date.now() - hit.fetchedAt) / 1000),
        err: e,
      });
      return hit.value;
    }
    count("rates.degraded", { leg: "asset", source: "refused" });
    log.error("pricing failed and no usable cache — refusing to quote", {
      "rate.asset": asset,
      err: e,
    });
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

/**
 * Seeds the quote cache directly, so a caller can exercise the real creation
 * path without reaching a pricing provider.
 *
 * For the offline test scripts only. `scripts/create-payment.ts` solves the same
 * problem by mirroring `createPayment` and injecting a fixed rate, which works for
 * a demo but means the tests would be exercising a copy of the code rather than
 * the code — and the one thing `POST /admin/api/payments` has to prove is that it
 * goes through the same service the merchant API does.
 *
 * Nothing in `src/` calls this, and a seeded entry ages out on the same TTL as a
 * fetched one, so it cannot pin a running gateway to a stale quote.
 */
export function primeRateCache(asset: string, copPerUnitE6: bigint): void {
  rateCache.set(asset, { value: copPerUnitE6, fetchedAt: Date.now() });
}

/** Cache state for /admin/api/diagnostics. */
export function rateCacheState() {
  return {
    fx: fxCache
      ? { usd_cop: fxCache.value, age_s: Math.round((Date.now() - fxCache.fetchedAt) / 1000) }
      : null,
    assets: Object.fromEntries(
      [...rateCache].map(([asset, c]) => [
        asset,
        { cop_per_unit_e6: c.value.toString(), age_s: Math.round((Date.now() - c.fetchedAt) / 1000) },
      ])
    ),
  };
}
