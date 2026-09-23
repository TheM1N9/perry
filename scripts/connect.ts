#!/usr/bin/env bun
/**
 * `pnpm run connect` — let Agent P work on this machine.
 *
 * Mints a runner token, points the install at local compute, writes the config
 * to ~/.perry/runner.json, and starts the runner.
 *
 * To connect a second machine, run this on the first one with --token-only,
 * then on the other machine run the runner with the url and token it printed.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { bold, dim, red, runConvex, yellow } from "./lib";





const args = process.argv.slice(2);
const tokenOnly = args.includes("--token-only");
const auto = args.includes("--auto");
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
        `    bun runner/index.ts --url ${url} --token ${token} --dir <folder>\n`,
    ),
  );
  process.exit(0);
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
runnerArgs.push(auto ? "--auto" : "--no-auto");

const runner = spawn(process.execPath, runnerArgs, { stdio: "inherit" });
runner.on("close", (code) => process.exit(code ?? 0));
