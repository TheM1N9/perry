#!/usr/bin/env bun
/**
 * `perry pair` — mint a fresh pairing code.
 *
 * Use it when the first code expired, or to move Perry to a different Telegram
 * chat. Minting a code does not unclaim an existing owner; do that from the
 * dashboard, or Perry would be stealable by anyone who can run this. Perry must
 * be running, as its server keeps the code.
 */

import { BackendClient } from "../client/backend";

const port = Number(process.env.PERRY_PORT ?? 3000);
const key = process.env.DASHBOARD_KEY;
if (!key) {
  console.error("\nNo DASHBOARD_KEY in .env.local. Run perry setup first.\n");
  process.exit(1);
}
const pairing = await new BackendClient(`http://127.0.0.1:${port}`, { adminKey: key })
  .call<{ code: string }>("installation:startPairing")
  .then((result) => result.value.code, (error: Error) => {
    console.error(`\nCould not mint a code: ${error.message.includes("fetch") ? "Perry is not running here (perry start)" : error.message}\n`);
    process.exit(1);
  });
console.log(`\n  Send this to your bot:\n\n      \x1b[1m\x1b[32m${pairing}\x1b[0m\n`);
console.log("  \x1b[2mExpires in an hour.\x1b[0m\n");
