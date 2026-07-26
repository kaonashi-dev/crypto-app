import { render } from "solid-js/web";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { RouterProvider } from "@tanstack/solid-router";
import { router } from "./router";

// Self-hosted: a checkout page should not depend on a third-party font host
// being reachable, and the payer's browser should not announce this payment to
// one. Variable axes only — no static weight files are shipped.
import "@fontsource-variable/archivo/wght.css";
import "@fontsource-variable/bodoni-moda/wght.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./index.css";

/**
 * Refetch-on-focus is off by default because the console is a snapshot tool —
 * it fetches when asked, not whenever a tab regains focus. The checkout's status
 * query opts back in: a payer who returns from their wallet app should see the
 * result of what they just did, not the state from before they left.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 2_000,
    },
  },
});

render(
  () => (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  ),
  document.getElementById("root")!
);
