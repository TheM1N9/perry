#!/usr/bin/env node
/**
 * Assistant's runner: the piece that lets Assistant work on this machine.
 *
 * How it connects, and why that shape:
 *
 *   This process dials out to your Convex deployment and holds a subscription.
 *   Convex pushes queued commands down the connection this process already
 *   opened. Nothing listens on a port here. There is no inbound firewall rule,
 *   no tunnel and no public address, so this machine cannot be found by anyone
 *   scanning the internet. That is the single most important line in this file.
 *
 * What protects you, in order of how much it actually matters:
 *
 *   1. This process. Close the terminal and Assistant has no hands again.
 *   2. Approval. Every command is printed here and waits for you to press y,
 *      unless you started it with --auto.
 *   3. The working directory. Commands run in one directory you chose, and
 *      file reads and writes cannot escape it.
 *   4. A denylist of commands that are never worth running.
 *
 * Nothing here runs at boot, installs a service, or survives a reboot. That is
 * deliberate.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { homedir, hostname, platform } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { ConvexClient } from "convex/browser";
import { ASSISTANT_MCP, CodexAppServer } from "./codex.mjs";

const CONFIG_DIR = join(homedir(), ".perry");
const CONFIG_FILE = join(CONFIG_DIR, "runner.json");
const CODEX_RESULTS = join(CONFIG_DIR, "codex-results");

const COMMAND_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 20_000;
const MAX_FILE_BYTES = 256 * 1024;
const CHECKIN_MS = 30_000;

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;

/**
 * Commands that are never a good idea from an agent, regardless of approval.
 *
 * This is a backstop, not the security model. A denylist cannot catch every
 * dangerous command and does not try to. The approval prompt is the real
 * control; this only removes the most obviously catastrophic typos.
 */
const DENY = [
  { pattern: /\brm\s+(-[a-zA-Z]*\s+)*(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b[^|;&]*\s\/(?:\s|$)/, why: "rm -rf on the filesystem root" },
  { pattern: /\bmkfs(\.\w+)?\b/, why: "formatting a filesystem" },
  { pattern: /\bdd\b[^|;&]*\bof=\/dev\//, why: "writing directly to a device" },
  { pattern: />\s*\/dev\/[sh]d[a-z]/, why: "writing directly to a disk" },
  { pattern: /:\(\)\s*\{\s*:\|\s*:&\s*\}\s*;\s*:/, why: "a fork bomb" },
  { pattern: /\bshutdown\b|\breboot\b|\bhalt\b/, why: "shutting down the machine" },
  { pattern: /\bdiskutil\s+(eraseDisk|eraseVolume|reformat)\b/, why: "erasing a disk" },
  { pattern: /\bFormat-Volume\b|\bClear-Disk\b/, why: "erasing a disk" },
  { pattern: /\bchmod\s+(-[a-zA-Z]+\s+)*777\s+\/(?:\s|$)/, why: "opening the filesystem root" },
  { pattern: /\bhistory\s+-c\b|\brm\b[^|;&]*\.bash_history/, why: "covering its tracks" },
];

function denied(command) {
  for (const rule of DENY) {
    if (rule.pattern.test(command)) return rule.why;
  }
  return null;
}

// --- Config --------------------------------------------------------------

function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveConfig(config) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

function parseArgs(argv) {
  const args = { auto: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--auto") args.auto = true;
    else if (arg === "--no-auto") args.auto = false;
    else if (arg === "--url") args.url = argv[++i];
    else if (arg === "--token") args.token = argv[++i];
    else if (arg === "--dir") args.dir = argv[++i];
    else if (arg === "--name") args.name = argv[++i];
  }
  return args;
}

// --- Safety --------------------------------------------------------------

/** Keep every path inside the working directory. No .. escapes, no absolutes. */
function confine(workdir, path) {
  const target = resolve(workdir, path ?? ".");
  const rel = relative(workdir, target);
  if (rel.startsWith("..") || (rel !== "" && resolve(workdir, rel) !== target)) {
    return null;
  }
  if (target !== workdir && !target.startsWith(workdir + sep)) return null;
  return target;
}

function clip(text) {
  if (text.length <= MAX_OUTPUT) return { text, truncated: false };
  return { text: text.slice(0, MAX_OUTPUT), truncated: true };
}

// --- Execution -----------------------------------------------------------

function runShell(command, cwd) {
  return new Promise((resolvePromise) => {
    const isWindows = process.platform === "win32";
    const shell = isWindows ? process.env.COMSPEC || "cmd.exe" : "/bin/sh";
    const shellArgs = isWindows ? ["/d", "/s", "/c", command] : ["-c", command];

    const child = spawn(shell, shellArgs, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PERRY_RUNNER: "1" },
    });

    let output = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, COMMAND_TIMEOUT_MS);

    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));

    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: null, output: String(error), timedOut: false });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: code, output, timedOut: killed });
    });
  });
}

// --- Main ----------------------------------------------------------------

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const stored = loadConfig();

  const url = flags.url ?? stored.url ?? process.env.PERRY_CONVEX_URL;
  const token = flags.token ?? stored.token ?? process.env.PERRY_RUNNER_TOKEN;

  if (!url || !token) {
    console.error(
      `\n${red("Not configured.")}\n\n` +
        `  On the machine where you installed Assistant:  ${bold("pnpm run connect")}\n` +
        `  On another machine:  ${bold("pnpm run connect -- --url <convex url> --token <token>")}\n`,
    );
    process.exit(1);
  }

  holdLock(token);

  const workdir = resolve(flags.dir ?? stored.dir ?? process.cwd());
  if (!existsSync(workdir)) {
    console.error(`\n${red(`No such directory: ${workdir}`)}\n`);
    process.exit(1);
  }

  const autoApprove = flags.auto ?? stored.auto === true;
  const name = flags.name ?? stored.name ?? hostname();

  saveConfig({ ...stored, url, token, dir: workdir, name, auto: autoApprove });

  const rl = autoApprove
    ? null
    : createInterface({ input: process.stdin, output: process.stdout });

  console.log(`\n${bold("Assistant runner")}`);
  console.log(dim(`  machine    ${name} (${platform()})`));
  console.log(dim(`  directory  ${workdir}`));
  console.log(
    autoApprove
      ? yellow("  approval   off, commands run without asking")
      : dim("  approval   every command waits for you"),
  );
  console.log(dim(`  connection outbound only, nothing is listening here`));
  console.log(dim(`\n  Ctrl-C takes Assistant's hands away.\n`));

  const client = new ConvexClient(url);
  const { api } = await import(
    new URL("../convex/_generated/api.js", import.meta.url).href
  );

  let codex = null;
  let lastCodexAttempt = 0;
  const ensureCodex = async () => {
    if (codex && !codex.closed) return codex;
    if (Date.now() - lastCodexAttempt < 30_000) {
      throw new Error("Codex app-server is unavailable. Retrying shortly.");
    }
    lastCodexAttempt = Date.now();
    const instance = new CodexAppServer();
    try {
      await instance.start();
      instance.on("serverRequest", (message) => {
        void (async () => {
          const method = message.method;
          if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
            const params = message.params ?? {};
            const command = params.command ?? (method.includes("fileChange") ? "Codex file change" : "Codex command");
            const reason = method.includes("commandExecution") ? denied(command) : null;
            const approved = !reason && await approve(rl, command, params.reason ?? null, autoApprove, params.cwd, workdir);
            instance.respond(message.id, { decision: approved ? "accept" : "decline" });
          } else if (method === "mcpServer/elicitation/request" && message.params?.serverName === ASSISTANT_MCP) {
            // Our own tools. Consequential actions are gated in chat, as on the gateway path.
            instance.respond(message.id, { action: "accept", content: {}, _meta: null });
          } else if (method === "item/permissions/requestApproval") {
            instance.respond(message.id, { permissions: {} });
          } else {
            instance.rejectRequest(message.id, `Assistant does not support ${method}.`);
          }
        })().catch((error) => instance.rejectRequest(message.id, String(error.message ?? error)));
      });
      instance.on("closed", () => { if (codex === instance) codex = null; });
      codex = instance;
      return instance;
    } catch (error) {
      instance.close();
      throw error;
    }
  };

  const refreshCodexAccount = async () => {
    try {
      const app = await ensureCodex();
      const account = await app.account();
      const models = account.authMode === "chatgpt" ? await app.models().catch(() => undefined) : undefined;
      await client.mutation(api.codex.reportAccount, { token, ...account, models });
    } catch (error) {
      await client.mutation(api.codex.reportAccount, {
        token,
        available: false,
        error: String(error.message ?? error),
      });
    }
  };

  const checkIn = async () => {
    try {
      await client.mutation(api.runner.checkIn, {
        token,
        platform: platform(),
        hostname: hostname(),
        workdir,
        autoApprove,
      });
    } catch (error) {
      console.error(red(`  check-in failed: ${error.message ?? error}`));
    }
  };

  await checkIn();
  await client.mutation(api.codex.recoverAuth, { token });
  await refreshCodexAccount();
  mkdirSync(CODEX_RESULTS, { recursive: true });
  const resultPath = (id) => join(CODEX_RESULTS, `${id}.json`);
  const savedResult = (id) => {
    try { return JSON.parse(readFileSync(resultPath(id), "utf8")); }
    catch { return null; }
  };
  const saveResult = (id, result) => {
    const target = resultPath(id);
    const temporary = `${target}.tmp`;
    writeFileSync(temporary, JSON.stringify(result), { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, target);
    console.log(dim(`  saved Codex turn ${id}`));
  };
  const recoverCodexTurns = async (markIncomplete) => {
    const running = await client.query(api.codex.runningTurns, { token });
    for (const job of running) {
      const result = savedResult(job._id);
      if (result || markIncomplete) {
        await client.mutation(api.codex.finishTurn, {
          token, id: job._id,
          ...(result ?? { error: "Runner stopped during this Codex turn. Gateway fallback will handle it." }),
        });
      }
    }
  };
  await recoverCodexTurns(true);
  const heartbeat = setInterval(() => {
    void checkIn();
    void refreshCodexAccount();
    void recoverCodexTurns(false).catch((error) => console.error(red(`  Codex delivery retry failed: ${error.message ?? error}`)));
  }, CHECKIN_MS);
  console.log(green("  connected.\n"));

  const busy = new Set();

  const handle = async (command) => {
    if (busy.has(command._id)) return;
    busy.add(command._id);

    try {
      const claimed = await client.mutation(api.runner.claimCommand, {
        token,
        commandId: command._id,
      });
      if (!claimed) return;

      const finish = (payload) =>
        client.mutation(api.runner.finishCommand, {
          token,
          commandId: command._id,
          ...payload,
        });

      // --- files ---
      if (command.kind !== "exec") {
        const target = confine(workdir, command.path);
        if (!target) {
          console.log(red(`  refused ${command.kind} ${command.path} (outside ${workdir})`));
          await finish({
            status: "denied",
            error: `Path is outside ${workdir}.`,
          });
          return;
        }

        try {
          if (command.kind === "read") {
            const buffer = await readFile(target);
            const { text, truncated } = clip(
              buffer.subarray(0, MAX_FILE_BYTES).toString("utf8"),
            );
            console.log(dim(`  read ${relative(workdir, target) || "."}`));
            await finish({ status: "done", output: text, truncated, exitCode: 0 });
          } else if (command.kind === "list") {
            const entries = await readdir(target, { withFileTypes: true });
            console.log(dim(`  list ${relative(workdir, target) || "."}`));
            await finish({
              status: "done",
              exitCode: 0,
              output: entries
                .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
                .join("\n"),
            });
          } else {
            if (Buffer.byteLength(command.text ?? "", "utf8") > MAX_FILE_BYTES) {
              await finish({ status: "error", error: "Over the 256 KB limit." });
              return;
            }
            const approved = await approve(
              rl,
              `write ${relative(workdir, target) || target}`,
              `${(command.text ?? "").slice(0, 400)}${(command.text ?? "").length > 400 ? "\n..." : ""}`,
              autoApprove,
            );
            if (!approved) {
              await finish({ status: "denied", error: "Declined." });
              return;
            }
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, command.text ?? "", "utf8");
            console.log(green(`  wrote ${relative(workdir, target)}`));
            await finish({ status: "done", exitCode: 0, output: "written" });
          }
        } catch (error) {
          console.log(red(`  ${command.kind} failed: ${error.message ?? error}`));
          await finish({ status: "error", error: String(error.message ?? error) });
        }
        return;
      }

      // --- shell ---
      const reason = denied(command.command);
      if (reason) {
        console.log(red(`\n  refused: ${command.command}`));
        console.log(red(`  reason: ${reason}\n`));
        await finish({
          status: "denied",
          error: `Refused by the runner: ${reason}.`,
        });
        return;
      }

      const cwd = command.cwd ? confine(workdir, command.cwd) : workdir;
      if (!cwd) {
        await finish({ status: "denied", error: `cwd is outside ${workdir}.` });
        return;
      }

      const approved = await approve(rl, command.command, null, autoApprove, cwd, workdir);
      if (!approved) {
        console.log(yellow("  declined.\n"));
        await finish({ status: "denied", error: "You declined it." });
        return;
      }

      const started = Date.now();
      const { exitCode, output, timedOut } = await runShell(command.command, cwd);
      const { text, truncated } = clip(output);
      const seconds = ((Date.now() - started) / 1000).toFixed(1);

      console.log(
        exitCode === 0
          ? green(`  exit 0 in ${seconds}s`)
          : red(`  exit ${timedOut ? "timeout" : exitCode} in ${seconds}s`),
      );
      if (text.trim()) {
        console.log(dim(text.split("\n").slice(0, 8).map((l) => `    ${l}`).join("\n")));
      }
      console.log("");

      await finish({
        status: "done",
        exitCode: exitCode ?? undefined,
        output: timedOut ? `${text}\n[killed after 120s]` : text,
        truncated,
      });
    } catch (error) {
      console.error(red(`  runner error: ${error.message ?? error}`));
    } finally {
      busy.delete(command._id);
    }
  };

  // Convex pushes queued work down the connection this process opened.
  client.onUpdate(api.runner.queued, { token }, (commands) => {
    for (const command of commands ?? []) void handle(command);
  });

  const handleCodexAuth = async (request) => {
    if (!request) return;
    const claimed = await client.mutation(api.codex.claimAuth, { token, id: request.id });
    if (!claimed) return;
    const update = (payload) => client.mutation(api.codex.updateAuth, {
      token, id: request.id, ...payload,
    });
    try {
      const app = await ensureCodex();
      if (request.kind === "logout") {
        await app.request("account/logout", {});
      } else {
        const account = await app.account();
        if (account.authMode !== "chatgpt") {
          const login = await app.request("account/login/start", { type: "chatgptDeviceCode" });
          if (login.type !== "chatgptDeviceCode" || !login.loginId || !login.verificationUrl || !login.userCode) {
            throw new Error("Codex did not return a device code.");
          }
          await update({ status: "running", verificationUrl: login.verificationUrl, userCode: login.userCode });
          await app.waitForLogin(login.loginId);
        }
      }
      await refreshCodexAccount();
      await update({ status: "done" });
    } catch (error) {
      await update({ status: "error", error: String(error.message ?? error) });
      await refreshCodexAccount();
    }
  };

  client.onUpdate(api.codex.queuedAuth, { token }, (request) => {
    if (request) void handleCodexAuth(request);
  });

  let codexTurnBusy = false;
  let codexQueue = [];
  const pumpCodex = async () => {
    if (codexTurnBusy) return;
    codexTurnBusy = true;
    try {
      while (codexQueue.length > 0) {
        const next = codexQueue.shift();
        const job = await client.mutation(api.codex.claimTurn, { token, id: next._id });
        if (!job) continue;
        let result = savedResult(job._id);
        if (!result) {
          try {
            const app = await ensureCodex();
            const completed = await app.runTurn({
              threadId: job.codexThreadId,
              instructions: job.instructions,
              history: job.history,
              prompt: job.prompt,
              cwd: workdir,
              mode: job.mode,
              model: job.requestedModel,
              tools: job.mcpUrl ? { url: job.mcpUrl, token } : undefined,
              attachments: job.attachments,
              onThread: (threadId) => client.mutation(api.codex.setThread, { token, id: job._id, threadId }),
            });
            result = { response: completed.response, model: job.requestedModel ? `codex/${job.requestedModel}` : "codex subscription" };
          } catch (error) {
            result = { error: String(error.message ?? error), model: job.requestedModel ? `codex/${job.requestedModel}` : "codex subscription" };
          }
          saveResult(job._id, result);
        }
        await client.mutation(api.codex.finishTurn, { token, id: job._id, ...result });
        codexQueue = await client.query(api.codex.queuedTurns, { token });
      }
    } catch (error) {
      console.error(red(`  Codex turn failed: ${error.message ?? error}`));
    } finally {
      codexTurnBusy = false;
    }
  };
  client.onUpdate(api.codex.queuedTurns, { token }, (jobs) => {
    codexQueue = jobs ?? [];
    void pumpCodex();
  });

  const stop = async () => {
    clearInterval(heartbeat);
    codex?.close();
    rl?.close();
    await client.close();
    console.log(dim("\n  runner stopped. Assistant has no hands here now.\n"));
    process.exit(0);
  };

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

/**
 * One process per runner token. Two would both claim that runner's Codex
 * turns, and Codex lets only one process write to a thread, so every other
 * turn in a chat would fail with "thread already has an active writer".
 */
function holdLock(token) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const lock = join(CONFIG_DIR, `runner-${createHash("sha256").update(token).digest("hex").slice(0, 12)}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lock, String(process.pid), { flag: "wx" });
      process.on("exit", () => { try { if (readFileSync(lock, "utf8") === String(process.pid)) unlinkSync(lock); } catch {} });
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const pid = Number(readFileSync(lock, "utf8"));
      let alive = false;
      try { process.kill(pid, 0); alive = pid > 0; } catch (check) { alive = check.code === "EPERM"; }
      if (alive) {
        console.error(`
${red(`This runner is already running (process ${pid}).`)} Stop it before starting another.
`);
        process.exit(1);
      }
      unlinkSync(lock);
    }
  }
}

/** The real control: a human, at the machine, reading the command. */
async function approve(rl, what, detail, autoApprove, cwd, workdir) {
  if (autoApprove) {
    console.log(`${cyan("  auto")} ${what}`);
    return true;
  }

  console.log(`\n${bold("  Assistant wants to run:")}`);
  console.log(`    ${cyan(what)}`);
  if (cwd && workdir) {
    const where = relative(workdir, cwd);
    console.log(dim(`    in ${where === "" ? workdir : where}`));
  }
  if (detail) console.log(dim(detail.split("\n").map((l) => `    ${l}`).join("\n")));

  const answer = (await rl.question(`  ${bold("run it?")} [y/N] `)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
