import { createSignal } from "solid-js";

/**
 * Merchant API keys the operator has pasted into the Build view.
 *
 * Held so the request builder can send a genuine `POST /api/payments` — the
 * documented integration path, with the merchant's own credential — instead of
 * only ever exercising the console's shortcut. Three deliberate properties:
 *
 *  - **`sessionStorage`, never `localStorage`.** A key survives a reload of the
 *    tab it was typed into and nothing more: closing the tab is the end of it.
 *    `localStorage` would leave a merchant credential on the operator's disk
 *    indefinitely, which is a decision no one made.
 *  - **Cleared on sign-out**, alongside the query cache, by AdminLayout. A
 *    signed-out browser should not still be holding a way in.
 *  - **Keyed by merchant id**, so switching merchants in the builder cannot
 *    silently send the previous merchant's key.
 *
 * This is still the operator choosing to put a live credential in a browser. The
 * view says so; it does not pretend the storage choice makes it free.
 */

const PREFIX = "gateway-console-key:";

/**
 * Mirrors sessionStorage into a signal so the UI re-renders on a change.
 *
 * Storage reads are not reactive on their own, and the alternative — reading in
 * a memo — would make every render touch storage without ever noticing a write
 * from elsewhere in the view.
 */
const [keys, setKeys] = createSignal<Record<string, string>>(readAll());

function readAll(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const key = window.sessionStorage.key(i);
      if (!key?.startsWith(PREFIX)) continue;
      const value = window.sessionStorage.getItem(key);
      if (value) out[key.slice(PREFIX.length)] = value;
    }
  } catch {
    // Private mode or storage disabled: the builder still works, the key just
    // does not survive a reload.
  }
  return out;
}

/** The key held for a merchant, or null. */
export const apiKeyFor = (clientId: string): string | null => keys()[clientId] ?? null;

export function rememberApiKey(clientId: string, apiKey: string): void {
  setKeys((prev) => ({ ...prev, [clientId]: apiKey }));
  try {
    window.sessionStorage.setItem(PREFIX + clientId, apiKey);
  } catch {
    // As above: the choice just will not survive a reload.
  }
}

export function forgetApiKey(clientId: string): void {
  setKeys((prev) => {
    const next = { ...prev };
    delete next[clientId];
    return next;
  });
  try {
    window.sessionStorage.removeItem(PREFIX + clientId);
  } catch {
    /* nothing held it in the first place */
  }
}

/** Drops every held key. Called on sign-out. */
export function forgetAllApiKeys(): void {
  setKeys({});
  try {
    for (const key of Object.keys(window.sessionStorage))
      if (key.startsWith(PREFIX)) window.sessionStorage.removeItem(key);
  } catch {
    /* nothing to clear */
  }
}

/** `gk_test_1a2b…9f0c` — enough to recognise, not enough to use. */
export function maskKey(apiKey: string): string {
  const cut = apiKey.lastIndexOf("_") + 1;
  const prefix = apiKey.slice(0, cut);
  const body = apiKey.slice(cut);
  if (body.length <= 8) return `${prefix}••••`;
  return `${prefix}${body.slice(0, 4)}…${body.slice(-4)}`;
}
