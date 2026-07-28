import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/solid-router";
import { CheckoutRoute } from "./checkout/CheckoutRoute";
import { AdminLayout } from "./admin/AdminLayout";
import { PaymentsRoute } from "./admin/PaymentsRoute";
import { DepositsRoute } from "./admin/DepositsRoute";
import { SweepsRoute } from "./admin/SweepsRoute";
import { PaymentDetailRoute } from "./admin/PaymentDetailRoute";
import { UsersRoute } from "./admin/UsersRoute";
import { MerchantsRoute } from "./admin/MerchantsRoute";
import { BuildRoute } from "./admin/BuildRoute";
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

export type SweepsSearch = { network?: string; status?: string; q?: string };

const sweepsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "sweeps",
  component: SweepsRoute,
  validateSearch: (search: Record<string, unknown>): SweepsSearch => ({
    network: str(search.network),
    status: str(search.status),
    q: str(search.q),
  }),
});

const paymentDetailRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "p/$publicId",
  component: PaymentDetailRoute,
});

// Operator accounts. A child of the admin route like every other view, so it
// renders inside the same shell — and behind the same sign-in, since AdminLayout
// is what decides whether any child renders at all.
const usersRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "users",
  component: UsersRoute,
});

export type MerchantsSearch = { id?: string };

/**
 * Merchants, and the first two views that can change anything.
 *
 * The selected merchant lives in the URL for the same reason the payment filters
 * do: a console view an operator is asking someone else to look at should survive
 * being pasted into a thread, and Back should undo a selection.
 */
const merchantsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "merchants",
  component: MerchantsRoute,
  validateSearch: (search: Record<string, unknown>): MerchantsSearch => ({
    id: str(search.id),
  }),
});

export type BuildSearch = { client?: string };

const buildRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "build",
  component: BuildRoute,
  validateSearch: (search: Record<string, unknown>): BuildSearch => ({
    client: str(search.client),
  }),
});

const routeTree = rootRoute.addChildren([
  checkoutRoute,
  adminRoute.addChildren([
    paymentsRoute,
    depositsRoute,
    sweepsRoute,
    paymentDetailRoute,
    merchantsRoute,
    buildRoute,
    usersRoute,
  ]),
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
