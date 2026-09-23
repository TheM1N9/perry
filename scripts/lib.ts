import { spawn } from "node:child_process";
import { resolve } from "node:path";

/** What the install scripts share. Bun loads .env.local into process.env on its own. */

export const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
export const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
export const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
export const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
export const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

export type Ran = { code: number | null; output: string };

/** Run a command. Quiet collects its output; otherwise it streams to this terminal. */
export function run(command: string, args: string[], { quiet = true }: { quiet?: boolean } = {}): Promise<Ran> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
      shell: false,
    });
    let output = "";
    child.stdout?.on("data", (d) => (output += d));
    child.stderr?.on("data", (d) => (output += d));
    child.on("close", (code) => resolvePromise({ code, output }));
  });
}

/**
 * The Convex CLI, run by path through this same runtime rather than npx.
 * Windows refuses to spawn a .cmd without a shell, and a shell needs quoting,
 * and quoting secrets on a command line is how secrets get mangled.
 */
const CONVEX_CLI = resolve(process.cwd(), "node_modules/convex/bin/main.js");

export function runConvex(args: string[], options?: { quiet?: boolean }): Promise<Ran> {
  return run(process.execPath, [CONVEX_CLI, ...args], options);
}
