import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexClient } from "convex/browser";
import { getFunctionName, type FunctionReference } from "convex/server";
import { api } from "../../convex/_generated/api";

// bun artifacts/runner-resubscribe/run.ts <outDir>   (CONVEX_URL set)
// The runner's subscriptions must survive a failing query. Before, one Convex
// "too many system operations" timeout on codex:stopRequests threw out of the
// client and killed the runner. This subscribes the same way the runner's
// `watch` does, with a token that makes the query fail every time, and checks
// that each failure is reported and resubscribed while the process lives on.
// Ways it could fail: onError never called (the client throws instead, and
// this process dies with no result.json); no resubscription (failures stays 1).
const [, , outDir] = process.argv;
mkdirSync(outDir, { recursive: true });
const client = new ConvexClient(process.env.CONVEX_URL!);
const failures: string[] = [];
const watch = <Query extends FunctionReference<"query">>(query: Query, args: Query["_args"]) => {
  const subscribe = () => {
    const unsubscribe = client.onUpdate(query, args, () => {}, (error) => {
      failures.push(`${getFunctionName(query)}: ${error.message.split("\n")[0]}`);
      unsubscribe();
      setTimeout(subscribe, 2_000);
    });
  };
  subscribe();
};
watch(api.codex.stopRequests, { token: "not-a-real-token" });
await new Promise((resolve) => setTimeout(resolve, 7_000));
const result = { ranAt: new Date().toISOString(), failures, stillAlive: true, pass: failures.length >= 2 };
writeFileSync(join(outDir, "result.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
await client.close();
process.exit(result.pass ? 0 : 1);
