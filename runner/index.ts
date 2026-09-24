#!/usr/bin/env bun
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
 *   1. This process. Close the terminal, or stop the service, and Assistant
 *      has no hands again.
 *   2. Approval. Every command waits for you, here, in the dashboard or on
 *      Telegram, unless a rule you saved with "Always allow" covers it or the
 *      runner's policy says otherwise: "review" lets a Codex reviewer clear
 *      routine actions first, "trust" (--auto) runs everything.
 *   3. The working directory. Commands run in one directory you chose, and
 *      file reads and writes cannot escape it.
 *   4. A denylist of commands that are never worth running.
 *
 *   A chat the owner put on Full access gives up 2 and 3 for its turns: Codex
 *   runs without its sandbox and with approval policy "never", so its own
 *   commands never reach this process to be asked about or denied. They still
 *   show in the run's trace.
 *
 * Nothing here runs at boot or survives a reboot unless you ask for it with
 * `pnpm run service install` (scripts/service.ts). Without a terminal, as a
 * service, approvals are asked in the dashboard only.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile, writeFile, readdir, mkdir, stat } from "node:fs/promises";
import { homedir, hostname, platform } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { ConvexClient } from "convex/browser";
import { getFunctionName, type FunctionArgs, type FunctionReference, type FunctionReturnType } from "convex/server";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { api } from "../convex/_generated/api";
import { runLabel } from "../convex/lib/commands";
import { truncateCommandOutput, truncateHead } from "../convex/lib/truncate";
import { ASSISTANT_MCP, CodexAppServer, TurnFailed, type GeneratedImage, type RpcMessage } from "./codex";
import { isReviewThread, review } from "./review";
import { ensureHome, HOME, PATHS, readRunnerConfig, writeRunnerConfig, type RunnerConfig } from "./home";
import { runShell } from "./shell";
import { TurnTrace } from "./trace";

const CONFIG_DIR = HOME;
const CODEX_RESULTS = PATHS.codexResults;

const MAX_FILE_BYTES = 256 * 1024;
const CHECKIN_MS = 30_000;
/** Matches APPROVAL_TTL_MS in convex/approvals.ts: an unanswered request is declined. */
const APPROVAL_TIMEOUT_MS = 10 * 60_000;
/** Shared files past this stay on the machine rather than go to Convex for Telegram. */
const SHARED_UPLOAD_LIMIT = 200 * 1024 * 1024;

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

type Policy = "ask" | "review" | "trust";
/** The policy lives on the runner's record in Convex; `auto` in runner.json is from before policies. */
type Flags = RunnerConfig & { policy?: Policy; help?: boolean };
const POLICIES: Policy[] = ["ask", "review", "trust"];
type CodexResult = { response?: string; error?: string; stopped?: boolean; compacted?: boolean; model?: string; media?: Array<{ storageId?: Id<"_storage">; localPath?: string; fileName: string; contentType: string }> };

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

function denied(command: string): string | null {
  for (const rule of DENY) {
    if (rule.pattern.test(command)) return rule.why;
  }
  return null;
}

// --- Config --------------------------------------------------------------

function parseArgs(argv: string[]): Flags {
  const args: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--policy") {
      const policy = argv[++i] as Policy;
      if (!POLICIES.includes(policy)) {
        console.error(`\n${red(`--policy is one of ${POLICIES.join(", ")}.`)}\n`);
        process.exit(1);
      }
      args.policy = policy;
    }
    // The older flags, kept as aliases.
    else if (arg === "--auto") args.policy = "trust";
    else if (arg === "--no-auto") args.policy = "ask";
    else if (arg === "--url") args.url = argv[++i];
    else if (arg === "--token") args.token = argv[++i];
    else if (arg === "--dir") args.dir = argv[++i];
    else if (arg === "--name") args.name = argv[++i];
    else if (arg === "--help" || arg === "-h") args.help = true;
  }
  return args;
}

// --- Safety --------------------------------------------------------------

/** Keep every path inside the working directory. No .. escapes, no absolutes. */
function confine(workdir: string, path?: string): string | null {
  const target = resolve(workdir, path ?? ".");
  const rel = relative(workdir, target);
  if (rel.startsWith("..") || (rel !== "" && resolve(workdir, rel) !== target)) {
    return null;
  }
  if (target !== workdir && !target.startsWith(workdir + sep)) return null;
  return target;
}

// --- Main ----------------------------------------------------------------

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log(
      `\n${bold("Assistant runner")}  ${dim(`${platform()}, home ${HOME}`)}\n\n` +
        `  bun runner/index.ts [--url <convex url>] [--token <token>] [--dir <folder>] [--name <name>] [--policy ask|review|trust]\n\n` +
        dim(`  Flags are saved to ${PATHS.runnerConfig}; later runs need none.\n`),
    );
    return;
  }
  const stored = readRunnerConfig();

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

  ensureHome();
  holdLock(token);
  // Started by the Windows logon task, which cannot end what it started: `pnpm run service stop` ends this PID.
  const pidFile = process.env.PERRY_SERVICE_PID_FILE;
  if (pidFile) {
    mkdirSync(dirname(pidFile), { recursive: true });
    writeFileSync(pidFile, String(process.pid));
  }

  const workdir = resolve(flags.dir ?? stored.dir ?? process.cwd());
  if (!existsSync(workdir)) {
    console.error(`\n${red(`No such directory: ${workdir}`)}\n`);
    process.exit(1);
  }

  const name = flags.name ?? stored.name ?? hostname();

  const { auto: _legacy, ...kept } = stored;
  writeRunnerConfig({ ...kept, url, token, dir: workdir, name });

  // The policy can change from the dashboard at any time, so the terminal is always ready to ask.
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const client = new ConvexClient(url);

  const checkIn = async (policy?: Policy) => {
    try {
      return await client.mutation(api.runner.checkIn, {
        token,
        platform: platform(),
        hostname: hostname(),
        workdir,
        policy,
      });
    } catch (error) {
      console.error(red(`  check-in failed: ${message(error)}`));
      return null;
    }
  };

  // A --policy flag sets the policy once; after that the dashboard's choice stands.
  const first = await checkIn(flags.policy);
  const policy = first?.policy ?? flags.policy ?? "ask";
  console.log(`\n${bold("Assistant runner")}`);
  console.log(dim(`  machine    ${name} (${platform()})`));
  console.log(dim(`  directory  ${workdir}`));
  console.log(
    policy === "trust"
      ? yellow("  approval   trust: commands run without asking")
      : dim(`  approval   ${policy === "review" ? "review: a Codex reviewer clears routine actions, the rest wait for you" : "ask: every command waits for you"}${process.stdin.isTTY ? "" : " in the dashboard and on Telegram"}`),
  );
  console.log(dim(`             change it on the dashboard's Computer page`));
  console.log(dim(`  connection outbound only, nothing is listening here`));
  console.log(dim(`\n  ${process.stdin.isTTY ? "Ctrl-C" : "`pnpm run service stop`"} takes Assistant's hands away.\n`));

  /**
   * Subscribe for as long as the runner lives. A query can fail for a moment
   * (a Convex timeout, a redeploy), and without an error handler the client
   * throws and takes the whole runner down; so a failure is logged and the
   * query subscribed to again shortly.
   */
  const watch = <Query extends FunctionReference<"query">>(
    query: Query,
    args: FunctionArgs<Query>,
    onResult: (result: FunctionReturnType<Query>) => void,
  ) => {
    const subscribe = () => {
      const unsubscribe = client.onUpdate(query, args, onResult, (error) => {
        console.error(red(`  ${getFunctionName(query)} failed: ${message(error)}; trying again shortly.`));
        unsubscribe();
        setTimeout(subscribe, 5_000);
      });
    };
    subscribe();
  };

  /** The chat whose Codex turn is running, so an approval can say which chat asked. */
  let activeConversation: Id<"conversations"> | undefined;
  // Without a terminal, stdin may already be closed and would read as "no"; ask only the dashboard then.
  const terminal = process.stdin.isTTY ? rl : null;

  type Request = {
    kind: "command" | "file" | "write";
    what: string;
    detail: string | null;
    cwd?: string;
    paths?: string[];
    /** Codex's proposed command prefix, which "Always allow" may remember instead of the exact command. */
    amendment?: string[];
    /** More for the reviewer to judge by than is worth storing, such as a diff. */
    evidence?: string;
  };

  /**
   * Whether something may run here. The hard deny list is checked before this
   * is called; Convex then applies the owner's saved rules and this runner's
   * policy, and says whether to run it, have the reviewer look, or ask.
   */
  const approve = async (request: Request): Promise<boolean> => {
    const { id, next } = await client.mutation(api.approvals.request, {
      token,
      kind: request.kind,
      title: request.what,
      detail: request.detail ?? undefined,
      cwd: request.cwd,
      paths: request.paths,
      amendment: request.amendment,
      conversationId: activeConversation,
    });
    if (next === "run") {
      console.log(`${cyan("  allowed")} ${request.what}`);
      return true;
    }
    if (next === "review") {
      const verdict = await ensureCodex()
        .then((app) => review(app, {
          kind: request.kind,
          title: request.what,
          cwd: request.cwd,
          workdir,
          paths: request.paths,
          detail: [request.detail, request.evidence].filter(Boolean).join("\n\n") || undefined,
        }))
        .catch((error) => ({ verdict: "error" as const, reason: message(error), model: undefined, ms: 0 }));
      const run = await client.mutation(api.approvals.reviewed, { token, id, ...verdict });
      if (run) {
        console.log(`${cyan("  reviewed")} ${request.what} ${dim(`(${verdict.reason})`)}`);
        return true;
      }
      console.log(yellow(`\n  reviewer: ${verdict.verdict}. ${verdict.reason}`));
    }
    return await askOwner(id, request);
  };

  /**
   * The real control: the owner, deciding before anything runs here. The
   * request is asked in this terminal, the dashboard and on Telegram at once,
   * and whichever answers first wins. Unanswered, it is declined after
   * APPROVAL_TIMEOUT_MS.
   */
  const askOwner = async (id: Id<"approvals">, request: Request): Promise<boolean> => {
    console.log(`\n${bold("  Assistant wants to run:")}`);
    console.log(`    ${cyan(request.what)}`);
    if (request.cwd) {
      const where = relative(workdir, request.cwd);
      console.log(dim(`    in ${where === "" ? workdir : where}`));
    }
    if (request.detail) console.log(dim(request.detail.split("\n").map((l) => `    ${l}`).join("\n")));
    if (!terminal) console.log(dim("    approve or decline it in the dashboard or on Telegram"));

    return await new Promise<boolean>((resolve) => {
      let done = false;
      const abort = new AbortController();
      let unsubscribe = () => {};
      const settle = (approved: boolean, by: "terminal" | "elsewhere" | "timeout", always = false) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsubscribe();
        abort.abort();
        if (by !== "elsewhere") void client.mutation(api.approvals.settle, { token, id, approved, by, always }).catch(() => {});
        if (by !== "terminal") console.log(dim(by === "timeout" ? "  nobody answered; declined." : `  ${approved ? "approved" : "declined"} in the dashboard or on Telegram.`));
        resolve(approved);
      };
      const timer = setTimeout(() => settle(false, "timeout"), APPROVAL_TIMEOUT_MS);
      unsubscribe = client.onUpdate(api.approvals.decision, { token, id }, (status) => {
        if (status === "approved" || status === "declined") settle(status === "approved", "elsewhere");
      }, (error) => console.error(red(`  could not follow the dashboard's answer: ${message(error)}`)));
      terminal?.question(`  ${bold("run it?")} [y/N/a = always] `, { signal: abort.signal })
        .then((answer) => {
          const choice = answer.trim().toLowerCase();
          settle(["y", "yes", "a", "always"].includes(choice), "terminal", ["a", "always"].includes(choice));
        })
        .catch(() => {});
    });
  };

  let codex: CodexAppServer | null = null;
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
      // Without them Codex still works, just without the agent's own skills.
      await instance.useSkills().catch((error) => console.log(yellow(`  skills unavailable: ${message(error)}`)));
      instance.on("serverRequest", (request: RpcMessage) => {
        void (async () => {
          const method = request.method ?? "";
          if (isReviewThread(request.params?.threadId)) {
            // The reviewer only answers; it never gets to act or ask.
            instance.rejectRequest(request.id, "The reviewer cannot do this.");
          } else if (method === "item/commandExecution/requestApproval") {
            const params = request.params ?? {};
            const command = params.command ?? "Codex command";
            const approved = !denied(command) && await approve({
              kind: "command",
              what: command,
              detail: params.reason ?? null,
              cwd: params.cwd ?? undefined,
              amendment: params.proposedExecpolicyAmendment ?? undefined,
            });
            instance.respond(request.id, { decision: approved ? "accept" : "decline" });
          } else if (method === "item/fileChange/requestApproval") {
            const params = request.params ?? {};
            const changes = instance.changesFor(params.itemId);
            const paths = changes.map((change) => resolve(workdir, change.path));
            const listed = changes.map((change, i) => `${change.kind?.type ?? "change"} ${paths[i]}`).join("\n");
            const approved = await approve({
              kind: "file",
              what: paths.length === 1 ? `change ${paths[0]}` : paths.length ? `change ${paths.length} files` : "Codex file change",
              detail: [params.reason, listed].filter(Boolean).join("\n") || null,
              paths,
              evidence: changes.map((change) => change.diff ?? "").join("\n").slice(0, 6000) || undefined,
            });
            instance.respond(request.id, { decision: approved ? "accept" : "decline" });
          } else if (method === "mcpServer/elicitation/request" && request.params?.serverName === ASSISTANT_MCP) {
            // Our own tools. Consequential actions are gated in chat, as on the gateway path.
            instance.respond(request.id, { action: "accept", content: {}, _meta: null });
          } else if (method === "item/permissions/requestApproval") {
            instance.respond(request.id, { permissions: {} });
          } else {
            instance.rejectRequest(request.id, `Assistant does not support ${method}.`);
          }
        })().catch((error) => instance.rejectRequest(request.id, message(error)));
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
        error: message(error),
      });
    }
  };

  /**
   * While the owner lets turns be answered without this machine, Convex holds
   * the ChatGPT access token Codex has now. It is pushed again when Codex has a
   * different one, cleared when Codex is signed out, and refreshed first when
   * Convex dropped the one pushed (ChatGPT refused it, or it expired).
   */
  let pushedToken: string | null | undefined;
  const pushChatgptToken = async (fallback: boolean, holdsToken: boolean) => {
    if (!fallback) {
      pushedToken = undefined;
      return;
    }
    try {
      const app = await ensureCodex();
      let current = await app.chatgptToken();
      if (current && current.accessToken === pushedToken && !holdsToken) current = await app.chatgptToken(true);
      if ((current?.accessToken ?? null) === pushedToken && (holdsToken || !current)) return;
      await client.mutation(api.chatgpt.pushToken, { token, ...current });
      pushedToken = current?.accessToken ?? null;
    } catch (error) {
      console.error(red(`  could not share the ChatGPT token: ${message(error)}`));
    }
  };

  /** Check in, and share the ChatGPT token as the answer says. */
  const checkInAndShare = async () => {
    const result = await checkIn();
    if (result) await pushChatgptToken(result.fallback, result.holdsToken);
  };
  if (first) await pushChatgptToken(first.fallback, first.holdsToken);
  await client.mutation(api.codex.recoverAuth, { token });
  await refreshCodexAccount();
  mkdirSync(CODEX_RESULTS, { recursive: true });
  const resultPath = (id: string) => join(CODEX_RESULTS, `${id}.json`);
  const savedResult = (id: string): CodexResult | null => {
    try { return JSON.parse(readFileSync(resultPath(id), "utf8")); }
    catch { return null; }
  };
  const saveResult = (id: string, result: CodexResult) => {
    const target = resultPath(id);
    const temporary = `${target}.tmp`;
    writeFileSync(temporary, JSON.stringify(result), { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, target);
    console.log(dim(`  saved Codex turn ${id}`));
  };
  const recoverCodexTurns = async (markIncomplete: boolean) => {
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
    void checkInAndShare();
    void refreshCodexAccount();
    void recoverCodexTurns(false).catch((error) => console.error(red(`  Codex delivery retry failed: ${message(error)}`)));
  }, CHECKIN_MS);
  console.log(green("  connected.\n"));

  const busy = new Set<string>();

  const handle = async (command: Doc<"commands">) => {
    if (busy.has(command._id)) return;
    busy.add(command._id);

    try {
      const claimed = await client.mutation(api.runner.claimCommand, {
        token,
        commandId: command._id,
      });
      if (!claimed) return;

      const finish = (payload: { status: "done" | "error" | "denied"; output?: string; error?: string; exitCode?: number; truncated?: boolean }) =>
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
            const { output: text, truncated } = truncateHead(
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
            const approved = await approve({
              kind: "write",
              what: `write ${relative(workdir, target) || target}`,
              detail: `${(command.text ?? "").slice(0, 400)}${(command.text ?? "").length > 400 ? "\n..." : ""}`,
              paths: [target],
              evidence: (command.text ?? "").slice(0, 6000),
            });
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
          console.log(red(`  ${command.kind} failed: ${message(error)}`));
          await finish({ status: "error", error: message(error) });
        }
        return;
      }

      // --- shell ---
      const shellCommand = command.command ?? "";
      const reason = denied(shellCommand);
      if (reason) {
        console.log(red(`\n  refused: ${shellCommand}`));
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

      const approved = await approve({ kind: "command", what: shellCommand, detail: null, cwd });
      if (!approved) {
        console.log(yellow("  declined.\n"));
        await finish({ status: "denied", error: "You declined it." });
        return;
      }

      const started = Date.now();
      const { exitCode, output, timedOut } = await runShell(shellCommand, cwd);
      // The end of the output is where errors and results are.
      const { output: text, truncated } = truncateCommandOutput(output);
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
      console.error(red(`  runner error: ${message(error)}`));
    } finally {
      busy.delete(command._id);
    }
  };

  // Convex pushes queued work down the connection this process opened.
  watch(api.runner.queued, { token }, (commands) => {
    for (const command of commands ?? []) void handle(command);
  });

  const handleCodexAuth = async (request: { id: number; kind: "login" | "logout" }) => {
    const claimed = await client.mutation(api.codex.claimAuth, { token, id: request.id });
    if (!claimed) return;
    const update = (payload: { status: "running" | "done" | "error"; verificationUrl?: string; userCode?: string; error?: string }) => client.mutation(api.codex.updateAuth, {
      token, id: request.id, ...payload,
    });
    try {
      const app = await ensureCodex();
      if (request.kind === "logout") {
        await app.request("account/logout", {});
      } else {
        const account = await app.account();
        if (account.authMode !== "chatgpt") {
          const login = await app.request<{ type?: string; loginId?: string; verificationUrl?: string; userCode?: string }>("account/login/start", { type: "chatgptDeviceCode" });
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
      await update({ status: "error", error: message(error) });
      await refreshCodexAccount();
    }
  };

  watch(api.codex.queuedAuth, { token }, (request) => {
    if (request) void handleCodexAuth(request);
  });

  const upload = async (turnId: Id<"codexTurns">, bytes: Buffer<ArrayBuffer>, contentType: string) => {
    const uploadUrl = await client.mutation(api.codex.mediaUploadUrl, { token, id: turnId });
    const response = await fetch(uploadUrl, { method: "POST", headers: { "Content-Type": contentType }, body: bytes });
    if (!response.ok) throw new Error(`upload failed (${response.status})`);
    const { storageId } = await response.json() as { storageId: Id<"_storage"> };
    return storageId;
  };

  // Generated images and shared files stay where they are on this machine, and
  // web chats serve them from there. Telegram needs the bytes, so for a
  // Telegram chat both are uploaded to Convex too. Past Telegram's 50 MB the
  // chat gets a download link instead, so the upload stops somewhere sensible.
  const keepMedia = async (turnId: Id<"codexTurns">, channel: "web" | "telegram", images: GeneratedImage[] = []) => {
    const media: NonNullable<CodexResult["media"]> = [];
    for (const image of images) {
      try {
        if (channel === "web") {
          let localPath = image.path;
          if (!localPath) {
            localPath = join(PATHS.files, "generated", `${randomUUID()}.png`);
            await mkdir(dirname(localPath), { recursive: true });
            await writeFile(localPath, Buffer.from(image.base64 ?? "", "base64"), { flag: "wx" });
          }
          media.push({ localPath, fileName: `${image.id}.png`, contentType: "image/png" });
          continue;
        }
        const bytes = image.path ? await readFile(image.path) : Buffer.from(image.base64 ?? "", "base64");
        media.push({ storageId: await upload(turnId, bytes, "image/png"), fileName: `${image.id}.png`, contentType: "image/png" });
      } catch (error) {
        console.error(red(`  Could not keep a generated image: ${message(error)}`));
      }
    }
    if (channel !== "telegram") return media;
    const shared = await client.query(api.codex.sharedFiles, { token, id: turnId }).catch(() => []);
    for (const file of shared) {
      try {
        if ((await stat(file.localPath)).size > SHARED_UPLOAD_LIMIT) {
          console.log(dim(`  ${file.fileName} is too big to send to Telegram; it stays here`));
          continue;
        }
        const storageId = await upload(turnId, await readFile(file.localPath), file.contentType);
        media.push({ storageId, localPath: file.localPath, fileName: file.fileName, contentType: file.contentType });
      } catch (error) {
        console.error(red(`  Could not upload ${file.fileName} for Telegram: ${message(error)}`));
      }
    }
    return media;
  };

  // Attachments stored in the cloud (a Telegram photo, say) are fetched into the
  // uploads folder first, so Codex reads every attachment from this disk.
  const localise = async (attachments: NonNullable<Doc<"codexTurns">["attachments"]> = []) => Promise.all(attachments.map(async (attachment) => {
    if (attachment.localPath || !attachment.url) return attachment;
    try {
      const response = await fetch(attachment.url);
      if (!response.ok) throw new Error(`download failed (${response.status})`);
      const extension = extname(attachment.fileName).toLowerCase().replace(/[^.a-z0-9]/g, "");
      const localPath = join(PATHS.uploads, `${randomUUID()}${extension}`);
      await mkdir(PATHS.uploads, { recursive: true });
      await writeFile(localPath, Buffer.from(await response.arrayBuffer()));
      return { ...attachment, localPath };
    } catch (error) {
      console.error(red(`  Could not fetch ${attachment.fileName}: ${message(error)}`));
      return attachment;
    }
  }));

  let codexTurnBusy = false;
  let codexQueue: Doc<"codexTurns">[] = [];
  // The turn Codex is working on, and the turns the owner asked to stop.
  let current: { jobId: Id<"codexTurns">; threadId: string; turnId: string } | null = null;
  let stopRequested = new Set<string>();
  const interruptIfAsked = () => {
    if (!current || !stopRequested.has(current.jobId) || !codex) return;
    console.log(yellow("  stopping the Codex turn, as asked"));
    void codex.interrupt(current.threadId, current.turnId).catch((error) => console.error(red(`  Could not stop the Codex turn: ${message(error)}`)));
  };
  // Messages the owner sent while the turn runs, and those already handed to Codex.
  let pendingSteers: Array<{ _id: Id<"codexSteers">; turnId: Id<"codexTurns">; prompt: string; attachments?: Doc<"codexTurns">["attachments"] }> = [];
  const steered = new Map<string, Promise<unknown>>();
  /**
   * Hand each new message for the running turn to Codex with turn/steer, then
   * tell Convex whether Codex took it. One it refused ("no active turn to
   * steer", a turn id mismatch) is queued as a turn of its own there.
   */
  const steerIfAsked = () => {
    if (!current || !codex) return;
    const { jobId, threadId, turnId } = current;
    const app = codex;
    for (const steer of pendingSteers) {
      if (steer.turnId !== jobId || steered.has(steer._id)) continue;
      steered.set(steer._id, (async () => {
        try {
          await app.steer(threadId, turnId, steer.prompt, await localise(steer.attachments));
          console.log(dim("  steered the Codex turn with a new message"));
          await client.mutation(api.codex.ackSteer, { token, id: steer._id, applied: true });
        } catch (error) {
          console.log(yellow(`  could not steer the Codex turn, so the message waits its turn: ${message(error)}`));
          await client.mutation(api.codex.ackSteer, { token, id: steer._id, applied: false, error: message(error) });
        }
      })().catch((error) => console.error(red(`  Could not report a steer: ${message(error)}`))));
    }
  };
  const pumpCodex = async () => {
    if (codexTurnBusy) return;
    codexTurnBusy = true;
    try {
      while (codexQueue.length > 0) {
        const next = codexQueue.shift()!;
        const job = await client.mutation(api.codex.claimTurn, { token, id: next._id });
        if (!job) continue;
        activeConversation = job.conversationId;
        let result = savedResult(job._id);
        if (!result) {
          // The reply so far, and the trace of what Codex is doing, go to Convex
          // about three times a second while the turn runs.
          let latest = "";
          let sent = "";
          let streamTimer: ReturnType<typeof setTimeout> | null = null;
          const trace = new TurnTrace();
          const report = async () => {
            const changes = trace.take();
            if (!changes) return;
            await client.mutation(api.codex.traceTurn, { token, id: job._id, ...changes }).catch(() => trace.retry(changes));
          };
          const flush = () => {
            streamTimer = null;
            void report();
            if (latest === sent) return;
            sent = latest;
            void client.mutation(api.codex.streamTurn, { token, id: job._id, text: latest }).catch(() => {});
          };
          const schedule = () => { streamTimer ??= setTimeout(flush, 300); };
          // What the run records: the model, the effort sent, and full access when it was.
          const label = runLabel(job.requestedModel, job.requestedEffort, job.access);
          if (job.access === "full" && job.kind !== "compact") {
            console.log(yellow("  full access: this turn runs without the sandbox, and Codex does not ask"));
          }
          try {
            const app = await ensureCodex();
            if (job.kind === "compact") {
              if (!job.codexThreadId) throw new Error("This chat has no Codex thread to compact yet.");
              console.log(dim("  compacting a chat's Codex thread"));
              await app.compact(job.codexThreadId, workdir);
              result = { response: "Compacted.", compacted: true, model: "codex subscription" };
            } else {
              const completed = await app.runTurn({
                threadId: job.codexThreadId,
                instructions: job.instructions,
                history: job.history,
                recalled: job.recalled,
                prompt: job.prompt,
                cwd: workdir,
                model: job.requestedModel,
                effort: job.requestedEffort,
                access: job.access,
                tools: job.mcpUrl ? { url: job.mcpUrl, token } : undefined,
                attachments: await localise(job.attachments),
                onThread: (threadId) => client.mutation(api.codex.setThread, { token, id: job._id, threadId }),
                onText: (text) => {
                  latest = text;
                  schedule();
                },
                onStarted: (turn) => {
                  current = { jobId: job._id, ...turn };
                  void client.mutation(api.codex.setCodexTurn, { token, id: job._id, codexTurnId: turn.turnId }).catch(() => {});
                  interruptIfAsked();
                  steerIfAsked();
                },
                onItem: (phase, item, atMs) => {
                  if (trace.item(phase, item, atMs)) schedule();
                },
                onUsage: (usage) => {
                  trace.addUsage(usage);
                  schedule();
                },
              });
              const media = await keepMedia(job._id, job.channel, completed.images);
              result = {
                response: completed.response,
                ...(completed.interrupted ? { stopped: true } : {}),
                ...(completed.compacted ? { compacted: true } : {}),
                model: label,
                ...(media.length ? { media } : {}),
              };
            }
          } catch (error) {
            // A late failure keeps what the turn had already produced.
            const partial = error instanceof TurnFailed ? error.partial : null;
            const media = await keepMedia(job._id, job.channel, partial?.images);
            result = {
              error: message(error),
              ...(partial?.text ? { response: partial.text } : {}),
              ...(partial?.compacted ? { compacted: true } : {}),
              model: label,
              ...(media.length ? { media } : {}),
            };
          } finally {
            current = null;
            activeConversation = undefined;
          }
          if (streamTimer) clearTimeout(streamTimer);
          // A steer still being answered must be recorded as applied or not
          // before finishTurn queues whatever the turn did not take.
          await Promise.all(steered.values());
          steered.clear();
          saveResult(job._id, result);
          // The trace's last report goes before the turn ends; Convex takes reports only while it runs.
          trace.drain(Date.now());
          await report();
        }
        await client.mutation(api.codex.finishTurn, { token, id: job._id, ...result });
        codexQueue = await client.query(api.codex.queuedTurns, { token });
      }
    } catch (error) {
      console.error(red(`  Codex turn failed: ${message(error)}`));
    } finally {
      codexTurnBusy = false;
    }
  };
  watch(api.codex.queuedTurns, { token }, (jobs) => {
    codexQueue = jobs ?? [];
    void pumpCodex();
  });
  watch(api.codex.stopRequests, { token }, (ids) => {
    stopRequested = new Set(ids ?? []);
    interruptIfAsked();
  });
  watch(api.codex.pendingSteers, { token }, (steers) => {
    pendingSteers = steers ?? [];
    steerIfAsked();
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
function holdLock(token: string) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const lock = join(CONFIG_DIR, `runner-${createHash("sha256").update(token).digest("hex").slice(0, 12)}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lock, String(process.pid), { flag: "wx" });
      process.on("exit", () => { try { if (readFileSync(lock, "utf8") === String(process.pid)) unlinkSync(lock); } catch {} });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number(readFileSync(lock, "utf8"));
      let alive = false;
      try { process.kill(pid, 0); alive = pid > 0; } catch (check) { alive = (check as NodeJS.ErrnoException).code === "EPERM"; }
      if (alive) {
        console.error(`\n${red(`This runner is already running (process ${pid}).`)} Stop it before starting another.\n`);
        process.exit(1);
      }
      unlinkSync(lock);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
