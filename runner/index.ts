#!/usr/bin/env bun
/**
 * Assistant's runner: the piece that lets Assistant work on this machine.
 *
 * How it connects, and why that shape:
 *
 *   This process dials out to Perry's server: calls are plain HTTP requests,
 *   and a server-sent event stream says when a query it follows has changed,
 *   so new turns reach it over the connection it opened. Nothing listens
 *   on a port here. There is no inbound firewall rule, no tunnel and no public
 *   address, so this machine cannot be found by anyone scanning the internet.
 *   That is the single most important line in this file.
 *
 * The work itself is done by an engine: a coding agent on this machine,
 * signed in with the owner's own subscription (runner/engine.ts; Codex is the
 * first, runner/engines/codex.ts). This file knows engines only through that
 * interface.
 *
 * What protects you, in order of how much it actually matters:
 *
 *   1. This process. Close the terminal, or stop the service, and Assistant
 *      has no hands again.
 *   2. Approval. Whatever the engine wants to do beyond its sandbox is
 *      decided by the chat's access (convex/approvals.ts): on Ask it waits for
 *      you, here, in the dashboard or where you are talking; on Auto a
 *      reviewer clears routine actions first and asks you about the rest. A
 *      rule you saved with "Always allow" runs it either way. A request from
 *      no chat follows the runner's own policy (--policy ask|review|trust).
 *   3. The engine's sandbox. Codex works in the directory you chose, and may
 *      write only there and in Perry's own folders (runner/engines/codex.ts).
 *   4. A denylist of commands that are never worth running.
 *
 *   A chat the owner put on Full access gives up 2, 3 and 4 for its turns:
 *   the engine runs without its sandbox and never asks, so its own commands
 *   never reach this process to be asked about or denied. They still show in
 *   the run's trace.
 *
 * Nothing here runs at boot or survives a reboot unless you ask for it with
 * `pnpm run service install` (scripts/service.ts). Without a terminal, as a
 * service, approvals are asked in the dashboard only.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { hostname, platform } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { BackendClient } from "../client/backend";
import { getFunctionName, type FunctionArgs, type FunctionReference, type FunctionReturnType } from "convex/server";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { api } from "../convex/_generated/api";
import { runLabel } from "../convex/lib/commands";
import { ENGINE_LABELS, engineOf } from "../convex/lib/engines";
import {
  optionOf, type Engine, type EngineKind, type EngineRequest, type EngineStatus, type GeneratedImage, type PerryTools,
  type TurnHandle, type TurnResult, type TurnSink,
} from "./engine";
import { createEngines } from "./engines";
import { review } from "./review";
import { nameChat } from "./title";
import { ensureHome, HOME, PATHS, readRunnerConfig, writeRunnerConfig, type RunnerConfig } from "./home";
import { TurnTrace } from "./trace";

const CONFIG_DIR = HOME;
/** Finished turns not yet delivered. The folder keeps its name from before engines, so none is lost on update. */
const TURN_RESULTS = PATHS.codexResults;

const CHECKIN_MS = 30_000;
/** Matches APPROVAL_TTL_MS in convex/approvals.ts: an unanswered request is declined. */
const APPROVAL_TIMEOUT_MS = 10 * 60_000;
/** Shared files past this stay on the machine rather than go to Convex for Telegram. */
const SHARED_UPLOAD_LIMIT = 200 * 1024 * 1024;
/**
 * The turn watchdog: a turn still running after this is interrupted, and its
 * engine ended, process group and all, if it has not stopped KILL_GRACE_MS
 * later. PERRY_TURN_TIMEOUT_MS changes it.
 */
const TURN_TIMEOUT_MS = Number(process.env.PERRY_TURN_TIMEOUT_MS) || 8 * 60_000;
/** A compaction waits on its own for up to ten minutes; this is past that. */
const COMPACT_TIMEOUT_MS = 11 * 60_000;
const KILL_GRACE_MS = 30_000;
/** Perry's tools over stdio, for engines that take MCP servers only as a command. */
const MCP_BRIDGE = fileURLToPath(new URL("./mcp-bridge.ts", import.meta.url));

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
type TurnRecord = { response?: string; error?: string; stopped?: boolean; compacted?: boolean; model?: string; media?: Array<{ storageId?: Id<"_storage">; localPath?: string; fileName: string; contentType: string }> };

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

  let url = flags.url ?? stored.url ?? process.env.PERRY_SERVER_URL;
  let token = flags.token ?? stored.token ?? process.env.PERRY_RUNNER_TOKEN;

  // On the machine Perry is installed on, its server connects this runner as it starts (server/index.ts).
  if (!url || !token) {
    console.log(dim("  Waiting for Perry's server to connect this computer…"));
    console.log(dim(`  On another machine: ${bold("pnpm run connect -- --url <server url> --token <token>")}`));
    while (!url || !token) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const fresh = readRunnerConfig();
      url = fresh.url;
      token = fresh.token;
    }
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

  const client = new BackendClient(url);

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
  await checkIn(flags.policy);
  console.log(`\n${bold("Assistant runner")}`);
  console.log(dim(`  machine    ${name} (${platform()})`));
  console.log(dim(`  directory  ${workdir}`));
  console.log(dim("  access     set per chat: Ask, Auto or Full access, from the chat or Settings"));
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

  // Without a terminal, stdin may already be closed and would read as "no"; ask only the dashboard then.
  const terminal = process.stdin.isTTY ? rl : null;

  // --- Engines ---------------------------------------------------------------

  const engines = createEngines({ warn: (line) => console.log(yellow(`  ${line}`)) });
  /** What each engine's last probe found. */
  const statuses = new Map<EngineKind, EngineStatus>();
  const probeEngines = async () => {
    const found = await Promise.all([...engines.values()].map((engine) => engine.status()
      .catch((error): EngineStatus => ({ kind: engine.kind, installed: false, signedIn: false, auth: {}, models: [], error: message(error) }))));
    for (const status of found) statuses.set(status.kind, status);
    await client.mutation(api.engines.report, { token, engines: found });
  };
  let probing: Promise<void> | null = null;
  /**
   * Report every engine's status. Probes never overlap: a heartbeat while one
   * runs shares it, and `fresh` (after a sign-in) waits for it and probes again.
   */
  const refreshEngines = async (fresh = false): Promise<void> => {
    while (probing) {
      const running = probing;
      if (!fresh) return running;
      await running.catch(() => {});
      fresh = false;
    }
    probing = probeEngines()
      .catch((error) => console.error(red(`  could not report the engines: ${message(error)}`)))
      .finally(() => { probing = null; });
    return probing;
  };
  /**
   * An engine for quick side turns (the reviewer, chat names): the preferred
   * one when it runs them and is signed in, else any that is.
   */
  const quickEngine = (preferred?: EngineKind): Engine | undefined => {
    const ready = (engine?: Engine) => engine?.quickTurn && engine.capabilities.quickTurns && statuses.get(engine.kind)?.signedIn ? engine : undefined;
    return ready(preferred ? engines.get(preferred) : undefined) ?? [...engines.values()].find((engine) => ready(engine));
  };
  /**
   * The turn watchdog. Past `limitMs` the turn is interrupted, and if it has
   * not ended KILL_GRACE_MS later, or never started, its engine is ended,
   * process group and all, which fails what it was doing.
   */
  const watchdog = (engine: Engine, limitMs: number, handle: () => TurnHandle | undefined) => {
    let expired = false;
    let kill: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      expired = true;
      const running = handle();
      console.log(yellow(`  ${engine.label} ran past ${Math.round(limitMs / 60_000)} minutes; stopping it`));
      if (running) void engine.interrupt(running).catch(() => {});
      kill = setTimeout(() => {
        console.log(yellow(`  ${engine.label} did not stop; ending it`));
        engine.kill();
      }, running ? KILL_GRACE_MS : 0);
    }, limitMs);
    return {
      expired: () => expired,
      why: `It ran for more than ${Math.round(limitMs / 60_000)} minutes, so it was stopped.`,
      done: () => { clearTimeout(timer); clearTimeout(kill); },
    };
  };

  // --- Approvals -------------------------------------------------------------

  type Request = {
    kind: "command" | "file";
    what: string;
    detail: string | null;
    cwd?: string;
    paths?: string[];
    /** The engine's proposed command prefix, which "Always allow" may remember instead of the exact command. */
    amendment?: string[];
    /** More for the reviewer to judge by than is worth storing, such as a diff. */
    evidence?: string;
  };

  /**
   * Whether something may run here. The hard deny list is checked before this
   * is called; Convex then applies the owner's saved rules and this runner's
   * policy, and says whether to run it, have the reviewer look, or ask.
   * `conversationId` is the chat that asked, whose access decides.
   */
  const approve = async (request: Request, conversationId?: Id<"conversations">, engine?: EngineKind): Promise<boolean> => {
    const { id, next } = await client.mutation(api.approvals.request, {
      token,
      kind: request.kind,
      title: request.what,
      detail: request.detail ?? undefined,
      cwd: request.cwd,
      paths: request.paths,
      amendment: request.amendment,
      conversationId,
    });
    if (next === "run") {
      console.log(`${cyan("  allowed")} ${request.what}`);
      return true;
    }
    if (next === "review") {
      // The chat's own engine reviews when it can; with none here that can, the owner is asked.
      const verdict = await review(quickEngine(engine), {
        kind: request.kind,
        title: request.what,
        cwd: request.cwd,
        workdir,
        paths: request.paths,
        detail: [request.detail, request.evidence].filter(Boolean).join("\n\n") || undefined,
      });
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

  /**
   * An engine asks before acting. The deny list goes first, then approve():
   * the answer is the id of the engine's own option to allow once or decline,
   * never one that allows for the rest of the session.
   */
  const answer = async (request: EngineRequest, conversationId: Id<"conversations">, engine: EngineKind): Promise<string> => {
    const { detail } = request;
    if (request.type === "exec_command_approval") {
      const command = detail.command ?? "command";
      const approved = !denied(command) && await approve({
        kind: "command",
        what: command,
        detail: detail.reason ?? null,
        cwd: detail.cwd,
        amendment: detail.proposedPrefix,
      }, conversationId, engine);
      return optionOf(request, approved ? "accept" : "decline");
    }
    if (request.type === "file_change_approval") {
      const changes = detail.changes ?? [];
      const paths = changes.map((change) => change.path);
      const listed = changes.map((change) => `${change.kind ?? "change"} ${change.path}`).join("\n");
      const approved = await approve({
        kind: "file",
        what: paths.length === 1 ? `change ${paths[0]}` : paths.length ? `change ${paths.length} files` : "file change",
        detail: [detail.reason, listed].filter(Boolean).join("\n") || null,
        paths,
        evidence: changes.map((change) => change.diff ?? "").join("\n").slice(0, 6000) || undefined,
      }, conversationId, engine);
      return optionOf(request, approved ? "accept" : "decline");
    }
    // Wider permissions, and questions from other tools, have no place to be asked yet.
    return optionOf(request, "decline");
  };

  const checkInAndShare = async () => { await checkIn(); };
  await client.mutation(api.engines.recoverAuth, { token });
  await refreshEngines();
  mkdirSync(TURN_RESULTS, { recursive: true });
  const resultPath = (id: string) => join(TURN_RESULTS, `${id}.json`);
  const savedResult = (id: string): TurnRecord | null => {
    try { return JSON.parse(readFileSync(resultPath(id), "utf8")); }
    catch { return null; }
  };
  const saveResult = (id: string, result: TurnRecord) => {
    const target = resultPath(id);
    const temporary = `${target}.tmp`;
    writeFileSync(temporary, JSON.stringify(result), { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, target);
    console.log(dim(`  saved turn ${id}`));
  };
  const recoverTurns = async (markIncomplete: boolean) => {
    const running = await client.query(api.codex.runningTurns, { token });
    for (const job of running) {
      const result = savedResult(job._id);
      if (result || markIncomplete) {
        await client.mutation(api.codex.finishTurn, {
          token, id: job._id,
          ...(result ?? { error: "Runner stopped during this turn. Gateway fallback will handle it." }),
        });
      }
    }
  };
  await recoverTurns(true);
  // The server rewrites runner.json when it connects this computer anew (a first start on the local
  // backend, say); a runner still holding the old address starts over, and perry run starts it again.
  const configWatch = setInterval(() => {
    const now = readRunnerConfig();
    if (now.url && now.token && (now.url !== url || now.token !== token)) {
      console.log(dim("  This computer's connection changed; restarting to use it."));
      process.exit(0);
    }
  }, 5_000);
  configWatch.unref?.();

  const heartbeat = setInterval(() => {
    void checkInAndShare();
    void refreshEngines();
    void recoverTurns(false).catch((error) => console.error(red(`  turn delivery retry failed: ${message(error)}`)));
  }, CHECKIN_MS);
  console.log(green("  connected.\n"));

  /** Sign an engine in or out, as asked in Settings, saying what the owner must do meanwhile. */
  const handleAuth = async (request: { engine: EngineKind; id: number; kind: "login" | "logout" }) => {
    const claimed = await client.mutation(api.engines.claimAuth, { token, engine: request.engine, id: request.id });
    if (!claimed) return;
    const update = (payload: Omit<FunctionArgs<typeof api.engines.updateAuth>, "token" | "engine" | "id">) =>
      client.mutation(api.engines.updateAuth, { token, engine: request.engine, id: request.id, ...payload });
    try {
      const engine = engines.get(request.engine);
      if (!engine) throw new Error(`${ENGINE_LABELS[request.engine]} is not on this computer's runner yet. Update Perry here.`);
      if (request.kind === "logout") {
        await engine.logout();
      } else {
        const flow = await engine.login();
        if (flow.interaction) await update({ status: "running", interaction: flow.interaction });
        await flow.done;
      }
      await refreshEngines(true);
      await update({ status: "done" });
    } catch (error) {
      await update({ status: "error", error: message(error) });
      await refreshEngines(true);
    }
  };

  watch(api.engines.queuedAuth, { token }, (requests) => {
    for (const request of requests ?? []) void handleAuth(request);
  });

  const upload = async (turnId: Id<"codexTurns">, bytes: Buffer<ArrayBuffer>, contentType: string) => {
    const uploadUrl = await client.mutation(api.codex.mediaUploadUrl, { token, id: turnId });
    const response = await fetch(client.resolve(uploadUrl), { method: "POST", headers: { "Content-Type": contentType }, body: bytes });
    if (!response.ok) throw new Error(`upload failed (${response.status})`);
    const { storageId } = await response.json() as { storageId: Id<"_storage"> };
    return storageId;
  };

  // Generated images and shared files stay where they are on this machine, and
  // web chats serve them from there. Telegram needs the bytes, so for a
  // Telegram chat both are uploaded to Convex too. Past Telegram's 50 MB the
  // chat gets a download link instead, so the upload stops somewhere sensible.
  // The web and WhatsApp read generated files from this machine; Telegram needs them uploaded.
  const keepMedia = async (turnId: Id<"codexTurns">, channel: "web" | "telegram" | "whatsapp", images: GeneratedImage[] = []) => {
    const media: NonNullable<TurnRecord["media"]> = [];
    for (const image of images) {
      try {
        if (channel !== "telegram") {
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
  // uploads folder first, so the engine reads every attachment from this disk.
  const localise = async (attachments: NonNullable<Doc<"codexTurns">["attachments"]> = []) => Promise.all(attachments.map(async (attachment) => {
    if (attachment.localPath || !attachment.url) return attachment;
    try {
      const response = await fetch(client.resolve(attachment.url));
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

  /** Perry's tools for a turn: over HTTP with this runner's token, or through the stdio bridge. */
  const toolsFor = (mcpUrl?: string): PerryTools | undefined => {
    if (!mcpUrl) return undefined;
    const address = client.resolve(mcpUrl);
    return {
      name: "assistant",
      http: { url: address, headers: { Authorization: `Bearer ${token}` } },
      stdio: { command: process.execPath, args: [MCP_BRIDGE], env: { PERRY_MCP_URL: address, PERRY_MCP_TOKEN: token } },
    };
  };

  /** Compact a chat's session the way its engine can: a command it takes as a prompt runs on the chat's model. */
  const compact = async (engine: Engine, cursor: string, access: Doc<"codexTurns">["access"], model?: string) => {
    const how = engine.capabilities.compaction;
    if (how.type === "native" && engine.compact) return await engine.compact(cursor, workdir);
    if (how.type === "slash-command") {
      const done = await engine.runTurn(
        { resumeCursor: cursor, instructions: "", prompt: how.command, attachments: [], cwd: workdir, model, access: access ?? "supervised" },
        { onSession: async () => {}, onRequest: async (request) => optionOf(request, "decline") },
      );
      if (done.state !== "completed") throw new Error(done.error ?? `${engine.label} did not compact.`);
      return;
    }
    throw new Error(`${engine.label} cannot compact a chat.`);
  };

  /**
   * A turn this runner has taken: being claimed, then running. Each keeps its
   * own engine handle, steers and stop, so turns of different engines run at
   * once without reaching into each other.
   */
  type Taken = {
    jobId: Id<"codexTurns">;
    conversationId: Id<"conversations">;
    kind: EngineKind;
    engine?: Engine;
    /** Set while the engine runs it: what interrupt() and steer() need. */
    handle?: TurnHandle;
    /** Asked to stop, and interrupted. */
    stopping?: boolean;
    /** Messages the owner sent into it, handed to the engine or being handed. */
    steered: Map<string, Promise<unknown>>;
  };
  type Claimed = NonNullable<FunctionReturnType<typeof api.codex.claimTurn>>;
  const taken = new Map<string, Taken>();
  let turnQueue: Doc<"codexTurns">[] = [];
  /** Queued turns the server would not hand over yet (their chat is busy, say); tried again when the queue changes. */
  let refused = new Set<string>();
  // The turns the owner asked to stop.
  let stopRequested = new Set<string>();
  const interruptIfAsked = () => {
    for (const turn of taken.values()) {
      const { engine, handle } = turn;
      if (!engine || !handle || turn.stopping || !stopRequested.has(turn.jobId)) continue;
      turn.stopping = true;
      console.log(yellow(`  stopping the ${engine.label} turn, as asked`));
      void engine.interrupt(handle).catch((error) => {
        turn.stopping = false;
        console.error(red(`  Could not stop the ${engine.label} turn: ${message(error)}`));
      });
    }
  };
  // Messages the owner sent while a turn runs, each for the turn it joins.
  let pendingSteers: Array<{ _id: Id<"codexSteers">; turnId: Id<"codexTurns">; prompt: string; attachments?: Doc<"codexTurns">["attachments"] }> = [];
  /**
   * Hand each new message for a running turn to its engine, then tell Convex
   * whether it took it. One it refused ("no active turn to steer", a turn id
   * mismatch), or an engine that takes one message at a time, is queued as a
   * turn of its own there.
   */
  const steerIfAsked = () => {
    for (const steer of pendingSteers) {
      const turn = taken.get(steer.turnId);
      if (!turn?.engine || !turn.handle || turn.steered.has(steer._id)) continue;
      const { engine, handle } = turn;
      turn.steered.set(steer._id, (async () => {
        try {
          const mode = engine.capabilities.steer;
          if (!engine.steer || (mode !== "native" && mode !== "concurrent-prompt")) throw new Error(`${engine.label} takes one message at a time`);
          await engine.steer(handle, { prompt: steer.prompt, attachments: await localise(steer.attachments) });
          console.log(dim(`  steered the ${engine.label} turn with a new message`));
          await client.mutation(api.codex.ackSteer, { token, id: steer._id, applied: true });
        } catch (error) {
          console.log(yellow(`  could not steer the ${engine.label} turn, so the message waits its turn: ${message(error)}`));
          await client.mutation(api.codex.ackSteer, { token, id: steer._id, applied: false, error: message(error) });
        }
      })().catch((error) => console.error(red(`  Could not report a steer: ${message(error)}`))));
    }
  };

  /** Run a claimed turn on its engine, and say how it went. */
  const work = async (job: Claimed, turn: Taken): Promise<TurnRecord> => {
    // The reply so far, and the trace of what the engine is doing, go to Convex
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
    const kind = job.engine;
    const engine = engines.get(kind);
    turn.engine = engine;
    // What the run records: the engine and model, the effort sent, and full access when it was.
    const label = runLabel(job.requestedModel, job.requestedEffort, job.access, kind);
    if (job.access === "full" && job.kind !== "compact") {
      console.log(yellow(`  full access: this turn runs without the sandbox, and ${engine?.label ?? "the engine"} does not ask`));
    } else if (job.access === "auto" && job.kind !== "compact") {
      console.log(dim("  auto: each command is reviewed before it runs; risky ones wait for you"));
    }
    let result: TurnRecord;
    let dog: ReturnType<typeof watchdog> | undefined;
    try {
      if (!engine) throw new Error(`${ENGINE_LABELS[kind]} is not on this computer's runner. Update Perry here, or pick another engine's model.`);
      if (job.kind === "compact") {
        if (!job.resumeCursor) throw new Error("This chat has no session to compact yet.");
        console.log(dim(`  compacting a chat's ${engine.label} session`));
        dog = watchdog(engine, COMPACT_TIMEOUT_MS, () => undefined);
        await compact(engine, job.resumeCursor, job.access, job.requestedModel).finally(dog.done);
        result = { response: "Compacted.", compacted: true, model: runLabel(undefined, undefined, undefined, kind) };
      } else {
        const sink: TurnSink = {
          onSession: (cursor, replaces) => client.mutation(api.codex.setResume, { token, id: job._id, cursor, ...(replaces ? { replaces } : {}) }),
          onStarted: (handle) => {
            turn.handle = handle;
            void client.mutation(api.codex.setCodexTurn, { token, id: job._id, codexTurnId: handle.turnId }).catch(() => {});
            interruptIfAsked();
            steerIfAsked();
          },
          onEvent: (event) => {
            if (event.type === "text") {
              if (event.stream !== "assistant") return;
              latest = event.text;
              schedule();
            } else if (event.type === "item") {
              if (trace.item(event.phase, event.item, event.atMs)) schedule();
            } else if (event.state !== "unavailable") {
              trace.addUsage(event.usage);
              schedule();
            }
          },
          onRequest: (request) => answer(request, job.conversationId, kind),
        };
        dog = watchdog(engine, TURN_TIMEOUT_MS, () => turn.handle);
        const outcome: TurnResult = await engine.runTurn({
          resumeCursor: job.resumeCursor,
          instructions: job.instructions,
          history: job.history,
          recalled: job.recalled,
          prompt: job.prompt,
          attachments: await localise(job.attachments),
          cwd: workdir,
          model: job.requestedModel,
          effort: job.requestedEffort,
          access: job.access ?? "supervised",
          tools: toolsFor(job.mcpUrl),
        }, sink).finally(dog.done);
        const media = await keepMedia(job._id, job.channel, outcome.images);
        // A late failure keeps what the turn had already produced.
        const failed = outcome.state === "failed" || dog.expired();
        result = {
          ...(failed ? { error: dog.expired() ? dog.why : outcome.error ?? `The ${engine.label} turn failed.` } : {}),
          ...(outcome.text || !failed ? { response: outcome.text } : {}),
          ...(!failed && outcome.state !== "completed" ? { stopped: true } : {}),
          ...(outcome.compacted ? { compacted: true } : {}),
          model: label,
          ...(media.length ? { media } : {}),
        };
      }
    } catch (error) {
      result = { error: dog?.expired() ? dog.why : message(error), model: label };
    } finally {
      // Stops and steers from now on find no turn to reach.
      turn.handle = undefined;
    }
    if (streamTimer) clearTimeout(streamTimer);
    // A steer still being answered must be recorded as applied or not
    // before finishTurn queues whatever the turn did not take.
    await Promise.all(turn.steered.values());
    saveResult(job._id, result);
    // The trace's last report goes before the turn ends; Convex takes reports only while it runs.
    trace.drain(Date.now());
    await report();
    return result;
  };

  /** Claim a queued turn, run it unless it already ran, deliver it, and start whatever may start next. */
  const take = async (next: Doc<"codexTurns">, turn: Taken) => {
    let claimed = false;
    try {
      const job = await client.mutation(api.codex.claimTurn, { token, id: next._id });
      if (!job) {
        refused.add(next._id);
        return;
      }
      claimed = true;
      const result = savedResult(job._id) ?? await work(job, turn);
      await client.mutation(api.codex.finishTurn, { token, id: job._id, ...result });
    } catch (error) {
      // Tried again when the queue changes; a result already saved is delivered by the heartbeat.
      if (!claimed) refused.add(next._id);
      console.error(red(`  turn failed: ${message(error)}`));
    } finally {
      taken.delete(next._id);
      if (claimed) {
        try {
          turnQueue = await client.query(api.codex.queuedTurns, { token });
          refused = new Set();
        } catch {}
      }
      pumpTurns();
    }
  };

  /**
   * Start what may start. Each engine has its own queue and runs one turn at a
   * time (or its capabilities.concurrentTurns), beside the other engines, so
   * a Claude reply never waits behind a Codex one. A chat's turns go in order
   * and never two at once, so one that waits holds back the chat's later ones,
   * whatever their engine.
   */
  const pumpTurns = () => {
    const busy = new Map<EngineKind, number>();
    const chats = new Set<string>();
    for (const turn of taken.values()) {
      busy.set(turn.kind, (busy.get(turn.kind) ?? 0) + 1);
      chats.add(turn.conversationId);
    }
    for (const next of turnQueue) {
      // One the server refused holds nothing back here; it keeps the chat's order itself (codex.claimTurn).
      if (taken.has(next._id) || refused.has(next._id)) continue;
      const kind = engineOf(next);
      const limit = Math.max(1, engines.get(kind)?.capabilities.concurrentTurns ?? 1);
      const free = !chats.has(next.conversationId) && (busy.get(kind) ?? 0) < limit;
      chats.add(next.conversationId);
      if (!free) continue;
      busy.set(kind, (busy.get(kind) ?? 0) + 1);
      const turn: Taken = { jobId: next._id, conversationId: next.conversationId, kind, steered: new Map() };
      taken.set(next._id, turn);
      void take(next, turn);
    }
  };
  watch(api.codex.queuedTurns, { token }, (jobs) => {
    turnQueue = jobs ?? [];
    refused = new Set();
    pumpTurns();
  });
  watch(api.codex.stopRequests, { token }, (ids) => {
    stopRequested = new Set(ids ?? []);
    interruptIfAsked();
  });
  watch(api.codex.pendingSteers, { token }, (steers) => {
    pendingSteers = steers ?? [];
    steerIfAsked();
  });

  // New web chats to name, beside whatever turn is running, by the chat's own
  // engine when it is signed in here. A failure leaves the chat titled with its
  // first message; so does a computer with no engine that runs quick turns,
  // which leaves the naming to one that has.
  const naming = new Set<string>();
  watch(api.titles.pending, { token }, (requests) => {
    for (const request of requests ?? []) {
      if (naming.has(request.id)) continue;
      const namer = quickEngine(request.engine);
      if (!namer) return;
      naming.add(request.id);
      void (async () => {
        if (!await client.mutation(api.titles.claim, { token, id: request.id })) return;
        let title: string | undefined;
        try {
          const named = await nameChat(namer, request.text);
          title = named.title;
          console.log(dim(`  named a chat "${title}" (${named.model ?? `${namer.label} default`})`));
        } catch (error) {
          console.log(yellow(`  could not name a chat: ${message(error)}`));
        }
        await client.mutation(api.titles.finish, { token, id: request.id, title });
      })()
        .catch((error) => console.error(red(`  Could not save a chat's name: ${message(error)}`)))
        .finally(() => naming.delete(request.id));
    }
  });

  const stop = async () => {
    clearInterval(heartbeat);
    for (const engine of engines.values()) engine.kill();
    rl?.close();
    client.close();
    console.log(dim("\n  runner stopped. Assistant has no hands here now.\n"));
    process.exit(0);
  };

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

/**
 * One process per runner token. Two would both claim that runner's turns,
 * and an engine lets only one process write to a session (Codex: "thread
 * already has an active writer"), so every other turn in a chat would fail.
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
