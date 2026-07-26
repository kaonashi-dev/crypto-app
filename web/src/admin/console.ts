import { createSignal } from "solid-js";

/**
 * Auto-refresh is OFF by default and opt-in per browser.
 *
 * Every console route is a plain Postgres SELECT — no Alchemy, CoinGecko or
 * TronGrid call is reachable from /admin/api/* — but polling still costs
 * database and compute on every open tab, and a console left open all day would
 * poll all day. Nothing refetches on a timer until this is switched on.
 */
const LIVE_KEY = "gateway-console-live";

export const REFRESH_MS = 4000;
// Relative timestamps ("4m 12s ago") need a ticking clock to stay honest. While
// auto-refresh is off the data on screen is a snapshot anyway, so the clock runs
// slowly — precise seconds against stale rows would be false precision.
export const CLOCK_LIVE_MS = 1000;
export const CLOCK_IDLE_MS = 30_000;

function readLivePreference(): boolean {
  try {
    return window.localStorage.getItem(LIVE_KEY) === "true";
  } catch {
    return false; // private mode / storage disabled: stay off
  }
}

const [live, setLiveSignal] = createSignal(readLivePreference());

export { live };

export function setLive(next: boolean) {
  setLiveSignal(next);
  try {
    window.localStorage.setItem(LIVE_KEY, String(next));
  } catch {
    // storage unavailable: the choice just won't survive a reload
  }
}

/** The console's shared clock, driven by AdminLayout. */
export const [now, setNow] = createSignal(Date.now());

/**
 * When the data on screen was actually fetched.
 *
 * The header reports this rather than the wall clock, which would imply a
 * freshness a console with auto-refresh off does not have.
 */
export const [loadedAt, setLoadedAt] = createSignal<number | null>(null);

/** How often each route's queries should refetch, given the current preference. */
export const refreshInterval = () => (live() ? REFRESH_MS : (false as const));
