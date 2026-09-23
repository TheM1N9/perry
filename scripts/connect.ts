#!/usr/bin/env bun
/**
 * `pnpm run connect` — let Agent P work on this machine.
 *
 * Mints a runner token, points the install at local compute, writes the config
 * to ~/.perry/runner.json, and starts the runner.
 *
 * To connect a second machine, run this on the first one with --token-only,
 * then on the other machine run the runner with the url and token it printed.
 *
 * With --service the runner is not started here but installed as a background
 * service that starts at login (scripts/service.ts); approvals are then
 * answered in the dashboard.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import { readRunnerConfig, writeRunnerConfig } from "../runner/home";
import { bold, dim, red, runConvex, yellow } from "./lib";
import { install } from "./service";

const args = process.argv.slice(2);
const tokenOnly = args.includes("--token-only");
const policyFlag = args.indexOf("--policy");
// --auto is the older name for --policy trust.
const policy = policyFlag !== -1 ? args[policyFlag + 1] : args.includes("--auto") ? "trust" : undefined;
const asService = args.includes("--service");
const dirFlag = args.indexOf("--dir");
const dir = dirFlag !== -1 ? args[dirFlag + 1] : undefined;

const url = process.env.NEXT_PUBLIC_CONVEX_URL;

if (!url) {
  console.error(
    `\n${red("No Convex URL in .env.local.")} Run ${bold("pnpm run setup")} first.\n`,
  );
  process.exit(1);
}

const token = randomBytes(32).toString("base64url");
const name = hostname();

const created = await runConvex([
  "run",
  "runner:createToken",
  JSON.stringify({ name, token }),
]);

if (created.code !== 0) {
  console.error(`\n${red("Could not create a runner token.")}\n`);
  console.error(dim(created.output.split("\n").slice(-6).join("\n")));
  process.exit(1);
}

// Point this install's commands at a real machine instead of the cloud box.
const pointed = await runConvex([
  "run",
  "installation:setComputeTarget",
  JSON.stringify({ target: "local" }),
]);
if (pointed.code !== 0) {
  console.error(yellow("  Could not switch the compute target; do it in Settings."));
}

if (tokenOnly) {
  console.log(`\n${bold("Runner credentials")}\n`);
  console.log(`  url    ${url}`);
  console.log(`  token  ${token}`);
  console.log(
    dim(
      `\n  On the other machine, in a clone of this repo:\n` +
        `    pnpm install\n` +
        `    bun runner/index.ts --url ${url} --token ${token} --dir <folder>\n` +
        `  and, to keep it running in the background from then on:\n` +
        `    pnpm run service install\n`,
    ),
  );
  process.exit(0);
}

if (asService) {
  // What the runner would save on its first start; the service starts it with no flags.
  const { auto: _legacy, ...stored } = readRunnerConfig();
  writeRunnerConfig({ ...stored, url, token, dir: resolve(dir ?? process.cwd()), name });
  // The service passes no flags, so a --policy given here is set once now, as the runner would on its first start.
  if (policy) {
    if (!["ask", "review", "trust"].includes(policy)) {
      console.error(`\n${red("--policy is one of ask, review, trust.")}\n`);
      process.exit(1);
    }
    await new ConvexHttpClient(url).mutation(api.runner.checkIn, { token, platform: process.platform, hostname: hostname(), policy: policy as "ask" | "review" | "trust" });
  }
  process.exit(install() ? 0 : 1);
}

console.log(`\n${bold("Connecting this machine")}`);
console.log(dim("  Agent P's commands will run here instead of the cloud sandbox."));
console.log(
  dim(
    "  Nothing listens on a port: the runner dials out and holds the\n" +
      "  connection, so this machine stays invisible from the internet.\n",
  ),
);

const runnerArgs = [
  resolve(process.cwd(), "runner/index.ts"),
  "--url",
  url,
  "--token",
  token,
];
if (dir) runnerArgs.push("--dir", dir);
if (policy) runnerArgs.push("--policy", policy);

const runner = spawn(process.execPath, runnerArgs, { stdio: "inherit" });
runner.on("close", (code) => process.exit(code ?? 0));
