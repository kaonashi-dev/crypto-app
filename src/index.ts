import { app } from "./api/routes";
import { startWatcher } from "./workers/watcher";
import { startConfirmer } from "./workers/confirmer";
import { startExpirer } from "./workers/expirer";
import { env, NETWORKS } from "./config";

for (const network of Object.keys(NETWORKS) as (keyof typeof NETWORKS)[]) {
  startWatcher(network);
  startConfirmer(network);
}
startExpirer();

console.log(`[gateway] API + workers up on http://localhost:${env.port}`);

export default { port: env.port, fetch: app.fetch };
// bun run src/index.ts -> API + workers up
