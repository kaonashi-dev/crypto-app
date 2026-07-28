import { createEffect, createSignal, onMount, Show } from "solid-js";
import { login, LoginError } from "./auth";

/**
 * The console's front door.
 *
 * Rendered instead of the console — not on a route of its own — so that signing
 * back in returns you to the view you were already on, deep link and filters
 * intact, rather than to a redirect's idea of where you were. It is also why an
 * expired session never loses the URL an operator pasted into an incident
 * thread.
 *
 * Deliberately plain: the same dark surface as the console, one card, no
 * branding beyond the console's own wordmark. A login screen that tries to
 * impress is a login screen that looks like a phishing page.
 */
export function LoginScreen(props: { onSignedIn: () => void }) {
  const [username, setUsername] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [pending, setPending] = createSignal(false);

  let usernameField: HTMLInputElement | undefined;
  onMount(() => usernameField?.focus());

  // The console routes own the title while they are mounted; while they are not,
  // this does — otherwise the tab keeps whatever the shell shipped with.
  createEffect(() => {
    document.title = "Sign in · Gateway console";
  });

  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    if (pending()) return;
    setError(null);
    setPending(true);
    try {
      await login(username(), password());
      // The password never outlives the request that used it.
      setPassword("");
      props.onSignedIn();
    } catch (err) {
      setError(
        err instanceof LoginError ? err.message : "Could not reach the server. Is it running?"
      );
      setPending(false);
    }
  };

  const field =
    "h-9 w-full rounded border border-hairline bg-plane px-2.5 text-[0.85rem] text-ink transition-colors placeholder:text-ink-3/70 hover:border-baseline focus-visible:border-ink-3 focus-visible:ring-2 focus-visible:ring-ink-3/40 focus-visible:outline-none disabled:opacity-60";

  return (
    <div class="flex min-h-screen items-center justify-center bg-plane px-4 py-10 font-sans text-ink antialiased">
      <div class="w-full max-w-[22rem]">
        <div class="mb-6">
          <span class="block text-[0.66rem] tracking-[0.2em] text-ink-3 uppercase">
            Crypto gateway
          </span>
          <h1 class="mt-0.5 text-[1.05rem] leading-tight text-ink">Console</h1>
        </div>

        <form
          onSubmit={submit}
          class="rounded-md border border-hairline bg-panel px-5 py-5"
          aria-labelledby="signin-heading"
        >
          <h2
            id="signin-heading"
            class="text-[0.7rem] font-semibold tracking-[0.14em] text-ink-3 uppercase"
          >
            Sign in
          </h2>

          <div class="mt-4 space-y-3.5">
            <div>
              <label
                for="operator"
                class="block text-[0.68rem] tracking-[0.1em] text-ink-3 uppercase"
              >
                Operator
              </label>
              <input
                ref={usernameField}
                id="operator"
                name="username"
                type="text"
                autocomplete="username"
                autocapitalize="none"
                spellcheck={false}
                required
                disabled={pending()}
                value={username()}
                onInput={(e) => setUsername(e.currentTarget.value)}
                class={`${field} mt-1 font-mono`}
              />
            </div>

            <div>
              <label
                for="password"
                class="block text-[0.68rem] tracking-[0.1em] text-ink-3 uppercase"
              >
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autocomplete="current-password"
                required
                disabled={pending()}
                value={password()}
                onInput={(e) => setPassword(e.currentTarget.value)}
                class={`${field} mt-1`}
              />
            </div>
          </div>

          {/* aria-live so a screen reader hears the rejection; the message is the
              server's, which never distinguishes a wrong password from an
              unknown operator. */}
          <div aria-live="polite" class="min-h-[1.25rem]">
            <Show when={error()}>
              <p class="mt-3 text-[0.75rem] leading-snug text-critical">{error()}</p>
            </Show>
          </div>

          <button
            type="submit"
            disabled={pending()}
            class="mt-3 h-9 w-full cursor-pointer rounded border border-baseline bg-plane text-[0.82rem] text-ink transition-colors hover:border-ink-3 disabled:cursor-default disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ink-2 focus-visible:outline-none"
          >
            {pending() ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p class="mt-4 text-[0.7rem] leading-relaxed text-ink-3">
          Internal operator console. It spans every merchant and shows operational internals the
          merchant API hides. Sign-ins are logged, and so is every change you make.
        </p>
      </div>
    </div>
  );
}
