#!/usr/bin/env node
/**
 * `npm run pair` — mint a fresh pairing code.
 *
 * Use it when the first code expired, or to move Perry to a different Telegram
 * chat. Minting a code does not unclaim an existing owner; do that from the
 * dashboard, or Perry would be stealable by anyone who can run this.
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";

/**
 * Call the Convex CLI through this same Node binary rather than npx.
 * Windows refuses to spawn a .cmd without a shell, and a shell needs quoting,
 * and quoting secrets on a command line is how secrets get mangled.
 */
const CONVEX_CLI = resolve(process.cwd(), "node_modules/convex/bin/main.js");

const child = spawn(
  process.execPath,
  [CONVEX_CLI, "run", "installation:startPairing", "{}"],
  { stdio: ["ignore", "pipe", "pipe"] },
);

let out = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (out += d));

child.on("close", (code) => {
  const pairing = out.match(/"code":\s*"(\d{6})"/)?.[1];
  if (code !== 0 || !pairing) {
    console.error("\nCould not mint a code. Is the deployment reachable?\n");
    console.error(out.split("\n").slice(-6).join("\n"));
    process.exit(1);
  }
  console.log(`\n  Send this to your bot:\n\n      \x1b[1m\x1b[32m${pairing}\x1b[0m\n`);
  console.log("  \x1b[2mExpires in an hour.\x1b[0m\n");
});
