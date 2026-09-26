import { spawn } from "node:child_process";
import { resolve } from "node:path";

/** What the install scripts share. Bun loads .env.local into process.env on its own. */

export const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
export const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
export const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
export const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
export const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

export type Ran = { code: number | null; output: string };

export type Spinner = { succeed(text: string): void; fail(text: string): void; stop(): void };

/**
 * An ora spinner for a step that makes you wait, settled as ✔ or ✖. Loaded
 * when needed: a checkout pulled by hand has not installed ora yet, and
 * `perry update`, which installs it, must still run there.
 */
export async function spinner(text: string): Promise<Spinner> {
  const ora = await loadOra();
  if (ora) {
    // A prefix rather than ora's indent, which the line a step ends on does not keep.
    const spin = ora({ text: dim(text), prefixText: " " });
    // Without a terminal, as in the service's log, there is nothing to animate: only how the step ended is written.
    return spin.isEnabled ? spin.start() : { succeed: (line) => spin.succeed(line), fail: (line) => spin.fail(line), stop: () => {} };
  }
  console.log(dim(`  ${text}`));
  return { succeed: (line) => console.log(`  ${line}`), fail: (line) => console.log(`  ${line}`), stop: () => {} };
}

let oraModule: Promise<typeof import("ora").default | null> | undefined;
const loadOra = () => (oraModule ??= import("ora").then((module) => module.default, () => null));

/** A step that went well, as one line: the line a spinner ends on. */
export async function done(text: string): Promise<void> {
  const ora = await loadOra();
  if (ora) ora({ prefixText: " " }).succeed(text);
  else console.log(`  ${text}`);
}

/** The last lines of a command's output, which is where it says what went wrong. */
export const tail = (output: string, lines = 15) => output.trim().split(/\r?\n/).filter((line) => line.trim()).slice(-lines).join("\n");

/** Run a command. Quiet collects its output; otherwise it streams to this terminal. */
export function run(command: string, args: string[], { quiet = true, env, cwd }: { quiet?: boolean; env?: NodeJS.ProcessEnv; cwd?: string } = {}): Promise<Ran> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
      shell: false,
      env: env ?? process.env,
      cwd,
      windowsHide: true,
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
 * The Convex CLI, run by path through this same runtime rather than npx; only
 * `perry migrate` needs it now, to export an install that still lives on
 * Convex. Windows refuses to spawn a .cmd without a shell, and a shell needs
 * quoting, and quoting secrets on a command line is how secrets get mangled.
 */
const CONVEX_CLI = resolve(process.cwd(), "node_modules/convex/bin/main.js");

/**
 * The CLI reads which deployment from .env.local itself. Bun copied that file
 * into process.env when the script started, and the CLI would believe the
 * copy over the file, so it is left out; and the CLI never gets to offer to
 * make a new deployment.
 */
function convexEnv(): NodeJS.ProcessEnv {
  const { CONVEX_DEPLOYMENT: _deployment, CONVEX_URL: _url, NEXT_PUBLIC_CONVEX_URL: _publicUrl, ...rest } = process.env;
  return { ...rest, CONVEX_ALLOW_ANONYMOUS: "false" };
}

export function runConvex(args: string[], options?: { quiet?: boolean }): Promise<Ran> {
  return run(process.execPath, [CONVEX_CLI, ...args], { ...options, env: convexEnv() });
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
export function runCodex(args: string[], options?: { quiet?: boolean }): Promise<Ran> {
  return process.platform === "win32"
    ? run(process.env.COMSPEC || "cmd.exe", ["/d", "/s", "/c", ["codex", ...args].join(" ")], options)
    : run("codex", args, options);
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
