#!/usr/bin/env bun
/**
 * `pnpm run pair` — mint a fresh pairing code.
 *
 * Use it when the first code expired, or to move Perry to a different Telegram
 * chat. Minting a code does not unclaim an existing owner; do that from the
 * dashboard, or Perry would be stealable by anyone who can run this.
 */

import { runConvex } from "./lib";

const { code, output } = await runConvex(["run", "installation:startPairing", "{}"]);
const pairing = output.match(/"code":\s*"(\d{6})"/)?.[1];
if (code !== 0 || !pairing) {
  console.error("\nCould not mint a code. Is the deployment reachable?\n");
  console.error(output.split("\n").slice(-6).join("\n"));
  process.exit(1);
}
console.log(`\n  Send this to your bot:\n\n      \x1b[1m\x1b[32m${pairing}\x1b[0m\n`);
console.log("  \x1b[2mExpires in an hour.\x1b[0m\n");
