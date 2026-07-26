import { createSignal, onCleanup } from "solid-js";

/**
 * A ticking `Date.now()`.
 *
 * Anything showing "11:42 left" or "4m 12s ago" needs a clock of its own —
 * the data it is describing does not change, only the distance to it does.
 */
export function useNow(intervalMs: number) {
  const [now, setNow] = createSignal(Date.now());
  const id = setInterval(() => setNow(Date.now()), intervalMs);
  onCleanup(() => clearInterval(id));
  return now;
}

/** `672` -> `"11:12"`, `4823` -> `"1:20:23"`. Tabular-safe: fixed field widths. */
export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}
