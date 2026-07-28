import { createEffect, onCleanup, Show, type JSX } from "solid-js";
import { Link, Outlet, useRouterState } from "@tanstack/solid-router";
import { useIsFetching, useQuery, useQueryClient } from "@tanstack/solid-query";
import {
  CLOCK_IDLE_MS,
  CLOCK_LIVE_MS,
  live,
  loadedAt,
  REFRESH_MS,
  setLive,
  setLoadedAt,
  setNow,
} from "./console";
import { fetchSession, logout, sessionExpired, setSessionExpired } from "./auth";
import { forgetAllApiKeys } from "./credentials";
import { LoginScreen } from "./LoginScreen";

function NavLink(props: { to: string; active: boolean; children: JSX.Element }) {
  return (
    <Link
      to={props.to}
      aria-current={props.active ? "page" : undefined}
      class={`-mb-px border-b-2 px-1 pb-2.5 text-[0.82rem] transition-colors focus-visible:ring-2 focus-visible:ring-ink-2 focus-visible:outline-none ${
        props.active
          ? "border-ink text-ink"
          : "border-transparent text-ink-3 hover:border-baseline hover:text-ink-2"
      }`}
    >
      {props.children}
    </Link>
  );
}

export function AdminLayout() {
  const queryClient = useQueryClient();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const fetching = useIsFetching();

  // Payments is the index route, so it is "everything else" — which means every
  // view added here has to be named in this list or it will render with the
  // Payments tab highlighted.
  const onDeposits = () => pathname().startsWith("/admin/deposits");
  const onSweeps = () => pathname().startsWith("/admin/sweeps");
  const onUsers = () => pathname().startsWith("/admin/users");
  const onMerchants = () => pathname().startsWith("/admin/merchants");
  const onBuild = () => pathname().startsWith("/admin/build");
  const onPayments = () =>
    !onDeposits() && !onSweeps() && !onUsers() && !onMerchants() && !onBuild();

  /**
   * Who is signed in — and therefore whether any of the console renders at all.
   *
   * `retry: false` because a 401 is an answer, not a failure to retry: the
   * fetcher resolves it to a signed-out session and the login screen replaces
   * the console below.
   */
  const session = useQuery(() => ({
    queryKey: ["session"],
    queryFn: fetchSession,
    retry: false,
    staleTime: 60_000,
  }));

  // Locked either because the identity query says so, or because some other
  // request came back 401 mid-session — an expiry should stop the tables on
  // screen now, not at the next poll of /auth/me.
  const locked = () => sessionExpired() || session.data?.authenticated === false;
  const operator = () => session.data?.user ?? null;
  const openMode = () => session.data?.mode === "open";

  /** Signing in resumes the view you were already on — nothing navigates. */
  const onSignedIn = () => {
    setSessionExpired(false);
    queryClient.invalidateQueries();
  };

  const signOut = async () => {
    await logout();
    // The cache holds cross-merchant data; a signed-out browser should not still
    // be carrying it. Nor should it still hold a merchant API key the Build view
    // was given — that is a live credential, not a preference.
    queryClient.clear();
    forgetAllApiKeys();
  };

  // The relative timestamps in every table need a clock of their own. It ticks
  // slowly while auto-refresh is off: precise seconds against a snapshot would
  // be false precision, and a 1s tick would re-render every row for nothing.
  createEffect(() => {
    const id = setInterval(
      () => setNow(Date.now()),
      live() ? CLOCK_LIVE_MS : CLOCK_IDLE_MS
    );
    onCleanup(() => clearInterval(id));
  });

  /**
   * Advance the clock whenever data lands, and record when that was.
   *
   * Pinning `now` to the moment of the fetch keeps it at or ahead of every
   * timestamp just returned — otherwise a row created seconds ago renders as
   * "in 0m 04s" whenever the clock is mid-interval, which on the 30s idle tick
   * is most of the time.
   */
  const cache = queryClient.getQueryCache();
  const unsubscribe = cache.subscribe(() => {
    const latest = cache
      .getAll()
      .reduce((max, query) => Math.max(max, query.state.dataUpdatedAt), 0);
    if (latest > 0) {
      setLoadedAt(latest);
      setNow(Date.now());
    }
  });
  onCleanup(unsubscribe);

  return (
    // Three states, in order of what the operator is owed: nothing until we know
    // whether they are signed in (a console that flashes merchant data and then
    // asks for a password has already shown it), the login screen if they are
    // not, the console if they are.
    <Show when={!session.isPending} fallback={<div class="min-h-screen bg-plane" />}>
    <Show when={!locked()} fallback={<LoginScreen onSignedIn={onSignedIn} />}>
    <div class="min-h-screen bg-plane font-sans text-ink antialiased">
      <header class="sticky top-0 z-20 border-b border-hairline bg-plane/95 backdrop-blur">
        <div class="mx-auto flex max-w-[1500px] flex-wrap items-end justify-between gap-4 px-4 pt-4 sm:px-6">
          <div class="flex items-end gap-7">
            <Link
              to="/admin"
              class="pb-2.5 focus-visible:ring-2 focus-visible:ring-ink-2 focus-visible:outline-none"
            >
              <span class="block text-[0.66rem] tracking-[0.2em] text-ink-3 uppercase">
                Crypto gateway
              </span>
              <span class="block text-[0.95rem] leading-tight text-ink">Console</span>
            </Link>
            <nav class="flex items-end gap-5" aria-label="Views">
              <NavLink to="/admin" active={onPayments()}>
                Payments
              </NavLink>
              <NavLink to="/admin/deposits" active={onDeposits()}>
                Deposits
              </NavLink>
              <NavLink to="/admin/sweeps" active={onSweeps()}>
                Sweeps
              </NavLink>
              <NavLink to="/admin/merchants" active={onMerchants()}>
                Merchants
              </NavLink>
              <NavLink to="/admin/build" active={onBuild()}>
                Build
              </NavLink>
              <NavLink to="/admin/users" active={onUsers()}>
                Operators
              </NavLink>
            </nav>
          </div>

          <div class="flex items-center gap-3 pb-2.5">
            {/* Absolute fetch time, not a relative one: a snapshot's age is only
                as accurate as the clock, and "data 04:57:12" can never read as a
                time in the future the way a lagging relative label can. */}
            <span
              class="font-mono text-[0.7rem] text-ink-3 tabular-nums"
              title={
                live()
                  ? `Refetched every ${REFRESH_MS / 1000}s`
                  : "Snapshot — press Refresh to update"
              }
            >
              {loadedAt()
                ? `data ${new Date(loadedAt()!).toLocaleTimeString("en-GB")}`
                : "loading…"}
            </span>
            <button
              type="button"
              onClick={() => queryClient.refetchQueries()}
              disabled={fetching() > 0}
              class="cursor-pointer rounded border border-hairline px-2.5 py-1 text-[0.75rem] text-ink-3 transition-colors hover:border-baseline hover:text-ink disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ink-2 focus-visible:outline-none"
            >
              {fetching() > 0 ? "Refreshing…" : "Refresh"}
            </button>
            <button
              type="button"
              onClick={() => setLive(!live())}
              aria-pressed={live()}
              title={
                live()
                  ? `Auto-refresh on — refetching every ${REFRESH_MS / 1000}s`
                  : "Auto-refresh off — nothing is fetched until you press Refresh or turn this on"
              }
              class="flex cursor-pointer items-center gap-2 rounded border border-hairline px-2.5 py-1 text-[0.75rem] transition-colors hover:border-baseline focus-visible:ring-2 focus-visible:ring-ink-2 focus-visible:outline-none"
            >
              <span
                aria-hidden
                class={`inline-block h-[7px] w-[7px] rounded-full ${
                  live() ? "bg-ok motion-safe:animate-pulse" : "border-[1.5px] border-ink-3"
                }`}
              />
              <span class={live() ? "text-ink-2" : "text-ink-3"}>
                {live() ? "Live" : "Auto-refresh off"}
              </span>
            </button>

            {/* Who is looking. In open mode there is no answer, and saying so is
                the point: an unauthenticated console should not be mistakable
                for a secured one. */}
            <Show
              when={operator()}
              fallback={
                <Show when={openMode()}>
                  <span
                    class="rounded border border-warn/50 px-2 py-1 text-[0.7rem] text-warn"
                    title="No ADMIN_PASSWORD is set on this server — the console is open to anyone who can reach the port"
                  >
                    unauthenticated
                  </span>
                </Show>
              }
            >
              {(who) => (
                <span class="flex items-center gap-2 border-l border-hairline pl-3">
                  <span class="font-mono text-[0.72rem] text-ink-2" title="Signed in operator">
                    {who().username}
                  </span>
                  <button
                    type="button"
                    onClick={signOut}
                    class="cursor-pointer rounded border border-hairline px-2.5 py-1 text-[0.75rem] text-ink-3 transition-colors hover:border-baseline hover:text-ink focus-visible:ring-2 focus-visible:ring-ink-2 focus-visible:outline-none"
                  >
                    Sign out
                  </button>
                </span>
              )}
            </Show>
          </div>
        </div>
      </header>

      <main class="mx-auto max-w-[1500px] px-4 py-5 sm:px-6">
        <Outlet />
      </main>

      <footer class="mx-auto max-w-[1500px] px-4 pb-8 text-[0.7rem] leading-relaxed text-ink-3 sm:px-6">
        <Show
          when={operator()}
          fallback={
            <>
              Internal console — <span class="text-warn">no authentication</span>. Reads are open;
              Merchants and Build are refused, because a change nobody can be attributed for is
              not recorded. Set ADMIN_PASSWORD to require a sign-in; until then, do not expose
              this port outside your machine.
            </>
          }
        >
          {(who) => (
            <>
              Internal console, signed in as{" "}
              <span class="font-mono text-ink-2">{who().username}</span>. Cross-merchant: every
              payment here belongs to someone. Every change you make is recorded against your
              name.
            </>
          )}
        </Show>
      </footer>
    </div>
    </Show>
    </Show>
  );
}
