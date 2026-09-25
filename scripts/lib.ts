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
export function run(command: string, args: string[], { quiet = true, env }: { quiet?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<Ran> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
      shell: false,
      env: env ?? process.env,
    });
    let output = "";
    child.stdout?.on("data", (d) => (output += d));
    child.stderr?.on("data", (d) => (output += d));
    // A command that is not installed fails to start at all.
    child.on("error", (error) => resolvePromise({ code: null, output: error.message }));
    child.on("close", (code) => resolvePromise({ code, output }));
  });
}

/**
 * The Convex CLI, run by path through this same runtime rather than npx.
 * Windows refuses to spawn a .cmd without a shell, and a shell needs quoting,
 * and quoting secrets on a command line is how secrets get mangled.
 */
const CONVEX_CLI = resolve(process.cwd(), "node_modules/convex/bin/main.js");

/**
 * The environment the Convex CLI runs in.
 *
 * Perry's deployment has to be in Convex's cloud, where Telegram can reach it,
 * so the CLI is never allowed to make one that runs on this machine: without
 * CONVEX_ALLOW_ANONYMOUS=false a first run offers "Start without an account",
 * and with no terminal it picks that on its own.
 *
 * Which deployment to use comes from .env.local as it is now: Bun copied the
 * file into process.env when the script started, and the CLI would believe
 * that stale copy over the file, even after setup has replaced the deployment.
 */
function convexEnv(): NodeJS.ProcessEnv {
  const { CONVEX_DEPLOYMENT: _deployment, CONVEX_URL: _url, NEXT_PUBLIC_CONVEX_URL: _publicUrl, ...rest } = process.env;
  return { ...rest, CONVEX_ALLOW_ANONYMOUS: "false" };
}

export function runConvex(args: string[], options?: { quiet?: boolean }): Promise<Ran> {
  return run(process.execPath, [CONVEX_CLI, ...args], { ...options, env: convexEnv() });
}

/**
 * Run the Convex CLI where you can answer it, showing what it says and calling
 * `onText` with each piece, so a caller can act on it (open a login link, say).
 */
export function runConvexShown(args: string[], onText: (text: string) => void): Promise<Ran> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CONVEX_CLI, ...args], { stdio: ["inherit", "pipe", "pipe"], env: convexEnv() });
    let output = "";
    const relay = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output += text;
      process.stdout.write(text);
      onText(text);
    };
    child.stdout.on("data", relay);
    child.stderr.on("data", relay);
    child.on("error", (error) => resolvePromise({ code: null, output: error.message }));
    child.on("close", (code) => resolvePromise({ code, output }));
  });
}

/** Open a link in the default browser. False when there is none to open it in. */
export function openUrl(url: string): Promise<boolean> {
  if (process.env.PERRY_NO_BROWSER === "1") return Promise.resolve(false);
  const opener = process.platform === "win32"
    ? ["powershell", ["-NoProfile", "-NonInteractive", "-Command", `Start-Process '${url.replace(/'/g, "''")}'`]] as const
    : [process.platform === "darwin" ? "open" : "xdg-open", [url]] as const;
  return run(opener[0], [...opener[1]]).then((ran) => ran.code === 0);
}

/**
 * The Codex CLI on PATH. On Windows an npm install is a .cmd, which only a
 * shell can start, so it goes through cmd.exe there, as the runner does; the
 * arguments are this repo's own, never user text.
 */
export function runCodex(args: string[]): Promise<Ran> {
  return process.platform === "win32"
    ? run(process.env.COMSPEC || "cmd.exe", ["/d", "/s", "/c", ["codex", ...args].join(" ")])
    : run("codex", args);
}

/** How to install what Perry needs on this OS, from each tool's own install docs. */
export const INSTALL_HINTS = {
  bun: process.platform === "win32"
    ? `powershell -c "irm bun.sh/install.ps1 | iex"`
    : "curl -fsSL https://bun.sh/install | bash",
  codex: process.platform === "win32"
    ? "npm i -g @openai/codex"
    : process.platform === "darwin"
      ? "brew install --cask codex  (or: npm i -g @openai/codex)"
      : "npm i -g @openai/codex  (or: curl -fsSL https://chatgpt.com/codex/install.sh | sh)",
};
