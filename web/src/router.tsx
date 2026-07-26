import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/solid-router";
import { CheckoutRoute } from "./checkout/CheckoutRoute";
import { AdminLayout } from "./admin/AdminLayout";
import { PaymentsRoute } from "./admin/PaymentsRoute";
import { DepositsRoute } from "./admin/DepositsRoute";
import { PaymentDetailRoute } from "./admin/PaymentDetailRoute";
import { NotFoundPage } from "./checkout/NotFoundPage";

/**
 * One route tree, two surfaces.
 *
 * The backend returns the same shell for /pay/:publicId and every path under
 * /admin, so the entry point used to switch on the pathname by hand. The tree
 * below replaces that, the pushState helper and the document-level click
 * interceptor the console needed to keep navigation client-side.
 */
const rootRoute = createRootRoute({
  component: () => <Outlet />,
  notFoundComponent: () => <NotFoundPage />,
});

const checkoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/pay/$publicId",
  component: CheckoutRoute,
});

const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin",
  component: AdminLayout,
});

/** Reads a search param that is only meaningful when non-empty. */
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

export type PaymentsSearch = {
  status?: string;
  network?: string;
  client?: string;
  q?: string;
  offset?: number;
};

/**
 * The payments filters live in the URL rather than in component state: a
 * filtered console view is the thing an operator pastes into an incident
 * thread, and Back should undo a filter the way it undoes a navigation.
 */
const paymentsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/",
  component: PaymentsRoute,
  validateSearch: (search: Record<string, unknown>): PaymentsSearch => {
    const offset = Number(search.offset);
    return {
      status: str(search.status),
      network: str(search.network),
      client: str(search.client),
      q: str(search.q),
      offset: Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : undefined,
    };
  },
});

export type DepositsSearch = { network?: string; confirmed?: string; q?: string };

const depositsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "deposits",
  component: DepositsRoute,
  validateSearch: (search: Record<string, unknown>): DepositsSearch => ({
    network: str(search.network),
    confirmed: search.confirmed === "true" || search.confirmed === "false"
      ? (search.confirmed as string)
      : undefined,
    q: str(search.q),
  }),
});

const paymentDetailRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "p/$publicId",
  component: PaymentDetailRoute,
});

const routeTree = rootRoute.addChildren([
  checkoutRoute,
  adminRoute.addChildren([paymentsRoute, depositsRoute, paymentDetailRoute]),
]);

export const router = createRouter({
  routeTree,
  defaultPreload: false,
  scrollRestoration: true,
});

declare module "@tanstack/solid-router" {
  interface Register {
    router: typeof router;
  }
}
