/**
 * Lowers the gateway's log level for the standalone test scripts.
 *
 * The scripts report through their own `ok/FAIL` lines, and the services they
 * drive log every step at debug — which buries the assertions. This drops the
 * service log to warnings, so what you still see is anything that went wrong.
 *
 * Import it FIRST in a script, before any `../src/...` import: ES modules are
 * evaluated in import order, and the logger reads LOG_LEVEL once when it loads.
 * An explicit LOG_LEVEL in the environment still wins, so
 * `LOG_LEVEL=debug bun run scripts/smoke-test.ts` shows everything.
 */
process.env.LOG_LEVEL ??= "warn";
