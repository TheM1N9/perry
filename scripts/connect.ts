#!/usr/bin/env bun
/**
 * `pnpm run connect` — let Perry work on another machine too.
 *
 * The computer Perry is installed on needs nothing: its server connects it as
 * it starts. For a second machine:
 *
 *   on Perry's computer:   pnpm run connect -- --token-only
 *                          prints the address and a token for the other machine
 *   on the other machine:  pnpm run connect -- --url <address> --token <token> [--dir <folder>] [--policy ask|review|trust] [--service]
 *                          checks them, saves them, and starts the runner (or,
 *                          with --service, installs it to start at login)
 *
 * The other machine reaches Perry's server over your network, typically its
 * Tailscale address; nothing about it needs to be public.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { hostname, networkInterfaces } from "node:os";
import { resolve } from "node:path";
import { api } from "../convex/_generated/api";
import { BackendClient } from "../client/backend";
import { readRunnerConfig, writeRunnerConfig } from "../runner/home";
import { bold, dim, red } from "./lib";
import { install } from "./service";

const args = process.argv.slice(2);
const option = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const port = Number(process.env.PERRY_PORT ?? 3000);

if (args.includes("--token-only")) {
  const key = process.env.DASHBOARD_KEY;
  if (!key) { console.error(`\n${red("No DASHBOARD_KEY in .env.local.")} Run ${bold("perry setup")} first.\n`); process.exit(1); }
  const token = randomBytes(32).toString("base64url");
  const name = option("--name") ?? "another machine";
  await new BackendClient(`http://127.0.0.1:${port}`, { adminKey: key }).call("runner:createToken", { name, token }).catch((error: Error) => {
    console.error(`\n${red("Could not make a token:")} ${error.message.includes("fetch") ? "Perry is not running here (perry start)" : error.message}\n`);
    process.exit(1);
  });
  // Addresses other machines can reach; Tailscale's first, since it works from anywhere you are signed in.
  const addresses = Object.values(networkInterfaces()).flat()
    .filter((address) => address && address.family === "IPv4" && !address.internal && !address.address.startsWith("169.254."))
    .map((address) => address!.address)
    .sort((a, b) => Number(b.startsWith("100.")) - Number(a.startsWith("100.")));
  const url = `http://${addresses[0] ?? "<this computer's address>"}:${port}`;
  console.log(`\n${bold("For the other machine")}\n`);
  console.log(`  url    ${url}`);
  console.log(`  token  ${token}`);
  console.log(dim(`\n  There, in a clone of this repo:\n    pnpm install\n    pnpm run connect -- --url ${url} --token ${token} --dir <folder> --service\n`));
  process.exit(0);
}

const url = option("--url");
const token = option("--token");
if (!url || !token) {
  const here = readRunnerConfig();
  console.log(here.token
    ? `\n  This computer is connected (${here.name ?? hostname()}), by Perry's server. For another machine: ${bold("pnpm run connect -- --token-only")}\n`
    : `\n  On the computer Perry is installed on, its server connects it as it starts (${bold("perry start")}).\n  For another machine: ${bold("pnpm run connect -- --token-only")} on Perry's computer.\n`);
  process.exit(0);
}

const policy = option("--policy");
if (policy && !["ask", "review", "trust"].includes(policy)) { console.error(`\n${red("--policy is one of ask, review, trust.")}\n`); process.exit(1); }
const dir = resolve(option("--dir") ?? process.cwd());
const name = hostname();

// A wrong address or token fails here, not later in the background.
await new BackendClient(url).mutation(api.runner.checkIn, { token, platform: process.platform, hostname: name, ...(policy ? { policy: policy as "ask" | "review" | "trust" } : {}) })
  .catch((error: Error) => { console.error(`\n${red("Could not reach Perry with that address and token:")} ${error.message}\n`); process.exit(1); });

const { auto: _legacy, ...stored } = readRunnerConfig();
writeRunnerConfig({ ...stored, url, token, dir, name });
if (args.includes("--service")) process.exit(install() ? 0 : 1);

console.log(`\n${bold("Connecting this machine")}`);
console.log(dim("  Nothing listens on a port here: the runner dials out to Perry's server and holds the connection.\n"));
const runner = spawn(process.execPath, [resolve(process.cwd(), "runner/index.ts")], { stdio: "inherit" });
runner.on("close", (code) => process.exit(code ?? 0));
