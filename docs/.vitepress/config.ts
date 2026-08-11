import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";

// Not deployed publicly in this plan. For GitHub Pages later, set
// `base: "/<repo-name>/"` (and matching `vite.base` if needed).
export default withMermaid(
  defineConfig({
    title: "crypto-gateway",
    description:
      "Crypto payment gateway — integrator guide, API reference, and operations",
    srcDir: ".",
    ignoreDeadLinks: false,
    cleanUrls: true,
    themeConfig: {
      nav: [
        { text: "Home", link: "/" },
        { text: "Guides", link: "/guides/quickstart" },
        { text: "API", link: "/api/" },
        { text: "Architecture", link: "/architecture/overview" },
        { text: "Operations", link: "/operations/local-development" },
      ],
      search: { provider: "local" },
      sidebar: {
        "/guides/": [
          {
            text: "Integrator guides",
            items: [
              { text: "Quickstart", link: "/guides/quickstart" },
              { text: "Authentication", link: "/guides/authentication" },
              { text: "Payments", link: "/guides/payments" },
              { text: "Checkout", link: "/guides/checkout" },
              { text: "Webhooks", link: "/guides/webhooks" },
              { text: "Networks & assets", link: "/guides/networks-and-assets" },
              { text: "Testing", link: "/guides/testing" },
            ],
          },
        ],
        "/api/": [
          {
            text: "API reference",
            items: [
              { text: "Conventions", link: "/api/" },
              { text: "Merchant API", link: "/api/merchant" },
              { text: "Public API", link: "/api/public" },
              { text: "Console API", link: "/api/console" },
              { text: "Errors", link: "/api/errors" },
            ],
          },
        ],
        "/architecture/": [
          {
            text: "Architecture",
            items: [
              { text: "Overview", link: "/architecture/overview" },
              { text: "Data model", link: "/architecture/data-model" },
              { text: "Payment lifecycle", link: "/architecture/payment-lifecycle" },
              { text: "Workers", link: "/architecture/workers" },
              { text: "Pricing", link: "/architecture/pricing" },
              { text: "Wallets & keys", link: "/architecture/wallets-and-keys" },
              { text: "Sweeping", link: "/architecture/sweeping" },
              { text: "Console", link: "/architecture/console" },
              { text: "Observability", link: "/architecture/observability" },
              { text: "Invariants", link: "/architecture/invariants" },
            ],
          },
        ],
        "/operations/": [
          {
            text: "Operations",
            items: [
              { text: "Configuration", link: "/operations/configuration" },
              { text: "Local development", link: "/operations/local-development" },
              { text: "Database", link: "/operations/database" },
              { text: "Deployment", link: "/operations/deployment" },
              { text: "Mainnet checklist", link: "/operations/mainnet-checklist" },
              { text: "Sweeping runbook", link: "/operations/sweeping-runbook" },
              { text: "Troubleshooting", link: "/operations/troubleshooting" },
            ],
          },
        ],
        "/contributing/": [
          {
            text: "Contributing",
            items: [
              { text: "Repository guide", link: "/contributing/" },
              { text: "Conventions", link: "/contributing/conventions" },
              { text: "Verification", link: "/contributing/verification" },
            ],
          },
        ],
        "/adr/": [
          {
            text: "Architecture decision records",
            items: [
              { text: "Index", link: "/adr/" },
              { text: "0001 · numeric(78,0) as bigint", link: "/adr/0001-numeric-78-as-bigint" },
              { text: "0002 · Event-sourced settlement", link: "/adr/0002-event-sourced-settlement" },
              { text: "0003 · Decimals per pairing", link: "/adr/0003-decimals-per-pairing" },
              { text: "0004 · In-process workers", link: "/adr/0004-in-process-workers" },
              { text: "0005 · Console read/write split", link: "/adr/0005-console-read-write-split" },
              { text: "0006 · Operator audit on mutation", link: "/adr/0006-operator-audit-on-mutation" },
              { text: "0007 · Signer boundary", link: "/adr/0007-signer-boundary" },
              { text: "0008 · Sweeps have no payment FK", link: "/adr/0008-sweeps-no-payment-fk" },
              { text: "0009 · Sweep probe gate", link: "/adr/0009-sweep-probe-gate" },
            ],
          },
        ],
        "/design/": [
          {
            text: "Design documents",
            items: [
              { text: "Sweeping plan", link: "/design/SWEEPING-PLAN" },
              { text: "Console write plan", link: "/design/CONSOLE-WRITE-PLAN" },
              { text: "Balances and withdrawals plan", link: "/design/BALANCES-WITHDRAWALS-PLAN" },
              { text: "Testing report (archived)", link: "/design/TESTING-REPORT" },
            ],
          },
        ],
      },
      socialLinks: [],
      outline: { level: [2, 3] },
    },
    mermaid: {},
  }),
);
