#!/usr/bin/env bun
/**
 * A stand-in npm for artifacts/engine-update, first on the runner's PATH as
 * npm.cmd, so updating the stand-in Codex never reaches the owner's own npm
 * or their global packages. `npm install -g @openai/codex@latest` prints
 * what npm would, a line at a time over a few seconds, then sets the stand-in
 * Codex (artifacts/cli-versions/fake-cli.ts) to the version in
 * FAKE_CLI_HOME/codex-latest. FAKE_CLI_HOME/npm-mode "fail" makes it fail as
 * npm does. Every start is recorded in FAKE_CLI_HOME/log.jsonl.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const HOME = process.env.FAKE_CLI_HOME ?? join(tmpdir(), "fake-cli");
mkdirSync(HOME, { recursive: true });
const read = (name: string) => existsSync(join(HOME, name)) ? readFileSync(join(HOME, name), "utf8").trim() : undefined;
const mode = read("npm-mode") ?? "ok";
appendFileSync(join(HOME, "log.jsonl"), `${JSON.stringify({ at: Date.now(), pid: process.pid, cli: "npm", args, mode })}\n`);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

if (args.join(" ") !== "install -g @openai/codex@latest") {
  console.error(`fake npm: ${args.join(" ")} is not played here`);
  process.exit(2);
}
const latest = read("codex-latest") ?? "0.0.0";
const steps = [
  "npm http fetch GET 200 https://registry.npmjs.org/@openai%2fcodex 182ms (cache revalidated)",
  `npm http fetch GET 200 https://registry.npmjs.org/@openai/codex/-/codex-${latest}.tgz 1204ms (cache miss)`,
  `npm http fetch GET 200 https://registry.npmjs.org/@openai/codex/-/codex-${latest}-win32-x64.tgz 2310ms (cache miss)`,
  "npm info run @openai/codex@" + latest + " postinstall node_modules/@openai/codex node ./scripts/postinstall.js",
];
for (const step of steps) {
  console.error(step);
  await sleep(900);
}
if (mode === "fail") {
  console.error("npm error code EBUSY\nnpm error syscall rename\nnpm error EBUSY: resource busy or locked, rename 'codex.exe'");
  process.exit(1);
}
writeFileSync(join(HOME, "codex-version"), latest);
console.log(`\nchanged 1 package in ${steps.length}s`);
