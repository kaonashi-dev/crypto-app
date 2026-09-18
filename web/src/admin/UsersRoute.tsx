import { createEffect, For, Match, Show, Switch } from "solid-js";
import { useQuery } from "@tanstack/solid-query";
import { fetchUsers, fmtRelative, fmtTime, type UserRow } from "./api";
import { now, refreshInterval } from "./console";
import { Empty, Panel } from "./ui";

/**
 * Who can open this console.
 *
 * Read-only, unlike Merchants and Build: accounts are still created by the server
 * at boot from `ADMIN_USER`/`ADMIN_PASSWORD`, not through the console.
 *
 * The reason is no longer that no audit model exists — `admin_audit_log` and the
 * `requireOperator` guard were built for the merchant write surface, and operator
 * CRUD could sit behind exactly the same two. It is that granting console access
 * is a larger decision than provisioning a merchant: it needs a role model to say
 * who may grant it, which nothing here has yet. Until then the environment stays
 * the only way in, which is also what keeps `ADMIN_PASSWORD` a reliable recovery
 * path for a deployment nobody can sign in to.
 */
function Tag(props: { children: string; tone?: string }) {
  return (
    <span
      class={`rounded-sm border px-1.5 py-px text-[0.62rem] tracking-[0.08em] uppercase ${
        props.tone ?? "border-hairline text-ink-3"
      }`}
    >
      {props.children}
    </span>
  );
}

function UsersTable(props: { rows: UserRow[]; bootstrap: string }) {
  return (
    <div class="overflow-x-auto">
      <table class="w-full min-w-[720px] border-collapse text-left">
        <thead>
          <tr class="border-b border-hairline text-[0.66rem] tracking-[0.12em] text-ink-3 uppercase">
            <th class="px-4 py-2.5 font-medium">Operator</th>
            <th class="px-4 py-2.5 font-medium">Status</th>
            <th class="px-4 py-2.5 text-right font-medium">Open sessions</th>
            <th class="px-4 py-2.5 text-right font-medium">Last sign-in</th>
            <th class="px-4 py-2.5 text-right font-medium">Created</th>
          </tr>
        </thead>
        <tbody>
          <For each={props.rows}>
            {(u) => (
              <tr class="border-b border-hairline/70 transition-colors hover:bg-plane/60">
                <td class="px-4 py-3 align-top">
                  <span class="font-mono text-[0.82rem] text-ink">{u.username}</span>
                  <span class="mt-1 flex flex-wrap items-center gap-1.5">
                    <Show when={u.is_you}>
                      <Tag tone="border-ok/60 text-ok">you</Tag>
                    </Show>
                    <Show when={u.username === props.bootstrap}>
                      <Tag>bootstrap</Tag>
                    </Show>
                  </span>
                </td>

                <td class="px-4 py-3 align-top">
                  <span
                    class={`inline-flex items-center gap-2 text-[0.8rem] ${
                      u.is_active ? "text-ink-2" : "text-critical"
                    }`}
                  >
                    <span
                      aria-hidden
                      class={`inline-block h-[7px] w-[7px] rounded-full border-[1.5px] ${
                        u.is_active ? "border-ok bg-ok" : "border-critical"
                      }`}
                    />
                    {u.is_active ? "active" : "disabled"}
                  </span>
                </td>

                <td class="px-4 py-3 text-right align-top">
                  <span
                    class={`text-[0.82rem] tabular-nums ${
                      u.active_sessions > 0 ? "text-ink" : "text-ink-3"
                    }`}
                  >
                    {u.active_sessions}
                  </span>
                </td>

                <td class="px-4 py-3 text-right align-top whitespace-nowrap">
                  <Show
                    when={u.last_login_at}
                    fallback={<span class="text-[0.78rem] text-ink-3">never</span>}
                  >
                    <span class="text-[0.78rem] text-ink-2" title={fmtTime(u.last_login_at)}>
                      {fmtRelative(u.last_login_at, now())}
                    </span>
                  </Show>
                </td>

                <td class="px-4 py-3 text-right align-top whitespace-nowrap">
                  <span class="text-[0.78rem] text-ink-3" title={fmtTime(u.created_at)}>
                    {fmtRelative(u.created_at, now())}
                  </span>
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  );
}

export function UsersRoute() {
  const users = useQuery(() => ({
    queryKey: ["users"],
    queryFn: fetchUsers,
    refetchInterval: refreshInterval(),
  }));

  createEffect(() => {
    document.title = "Operators · Gateway console";
  });

  return (
    <Panel
      title={`Operators${users.data ? ` · ${users.data.users.length}` : ""}`}
      aside={
        <Show when={users.data}>
          {(data) => (
            <span class="font-mono text-[0.68rem] text-ink-3">
              sessions last {data().session_ttl_hours}h
            </span>
          )}
        </Show>
      }
    >
      <Switch>
        <Match when={users.isError}>
          <Empty>Could not load operators: {String(users.error?.message ?? "")}</Empty>
        </Match>
        <Match when={!users.data}>
          <Empty>Loading…</Empty>
        </Match>
        <Match when={users.data!.users.length === 0}>
          <Empty>
            No operator accounts. Set <span class="font-mono text-ink-2">ADMIN_PASSWORD</span> and
            restart the server to create one.
          </Empty>
        </Match>
        <Match when={users.data}>
          {(data) => (
            <>
              <UsersTable rows={data().users} bootstrap={data().bootstrap_username} />
              <footer class="border-t border-hairline px-4 py-2.5 text-[0.7rem] leading-relaxed text-ink-3">
                Accounts are created by the server at boot:{" "}
                <span class="font-mono text-ink-2">ADMIN_USER</span> (default{" "}
                <span class="font-mono text-ink-2">admin</span>) with the password in{" "}
                <span class="font-mono text-ink-2">ADMIN_PASSWORD</span>, which is also how a
                password is reset — change it and restart, and that operator's open sessions are
                revoked. The console itself grants nothing: it can create merchants, but not
                operators, because deciding who may open this console needs a role model that
                does not exist yet.
                <Show when={data().signed_in_as === null}>
                  {" "}
                  This server is running <span class="text-warn">open</span> — no{" "}
                  <span class="font-mono text-ink-2">ADMIN_PASSWORD</span> is set, so nobody is
                  signed in and anyone who can reach the port sees everything.
                </Show>
              </footer>
            </>
          )}
        </Match>
      </Switch>
    </Panel>
  );
}
