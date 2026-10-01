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
 *      The access is the chat's at the moment of asking: one changed while a
 *      turn runs applies to that turn, and its engine is told (setAccess).
 *   3. The engine's sandbox. Codex works in the directory you chose, and may
 *      write only there and in Perry's own folders (runner/engines/codex.ts).
 *   4. A denylist of commands that are never worth running.
 *
 *   A chat the owner put on Full access gives up 2 and 3 for its turns: the
 *   engine runs without its sandbox, and nothing waits for you. They still
 *   show in the run's trace. Codex still asks this process about each command,
 *   answered at once, so the chat can be put back on Ask or Auto mid-turn;
 *   Claude Code and ACP agents are switched back instead.
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
import { ACCESS_LABELS, runLabel } from "../convex/lib/commands";
import { ENGINE_LABELS, refusal, updateOf, versionIn } from "../convex/lib/engines";
import { skillsNamedIn } from "../convex/lib/skills";
import {
  optionOf, skillNote, type Access, type Engine, type EngineKind, type EngineRequest, type EngineStatus, type GeneratedImage, type NamedSkill, type PerryTools,
  type TurnHandle, type TurnResult, type TurnSink,
} from "./engine";
import { createEngines } from "./engines";
import { review } from "./review";
import { nameChat } from "./title";
import { ensureHome, HOME, PATHS, readRunnerConfig, writeRunnerConfig, type RunnerConfig } from "./home";
import { TurnTrace } from "./trace";
import { runUpdate, updatePlan, withVersions } from "./versions";
import { TURN_IDLE_MIN, TURN_MAX_MIN } from "../convex/lib/turnLimits";
import { LIMIT_HIT, LIMITS_EVERY_MS } from "../convex/lib/usage";

const CONFIG_DIR = HOME;
/** Finished turns not yet delivered. The folder keeps its name from before engines, so none is lost on update. */
const TURN_RESULTS = PATHS.codexResults;

const CHECKIN_MS = 30_000;
/** Matches APPROVAL_TTL_MS in convex/approvals.ts: an unanswered request is declined. */
const APPROVAL_TIMEOUT_MS = 10 * 60_000;
/** Shared files past this stay on the machine rather than go to Convex for Telegram. */
const SHARED_UPLOAD_LIMIT = 200 * 1024 * 1024;
/**
 * The turn watchdog, for a turn that is stuck rather than long: one quiet (no
 * words, no step, no approval waiting) for TURN_IDLE_MS, or running past
 * TURN_TIMEOUT_MS, is interrupted, and its engine ended, process group and
 * all, if it has not stopped KILL_GRACE_MS later. The agent can ask for longer
 * first (take_longer, convex/mcp.ts); both are in convex/lib/turnLimits.ts,
 * and PERRY_TURN_IDLE_MS and PERRY_TURN_TIMEOUT_MS change them here.
 */
const TURN_IDLE_MS = Number(process.env.PERRY_TURN_IDLE_MS) || TURN_IDLE_MIN * 60_000;
const TURN_TIMEOUT_MS = Number(process.env.PERRY_TURN_TIMEOUT_MS) || TURN_MAX_MIN * 60_000;
/** How often the watchdog looks. */
const WATCHDOG_TICK_MS = 5_000;
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

  const engines = createEngines({
    warn: (line) => console.log(yellow(`  ${line}`)),
    // A key from Settings → Engines an engine needs on this computer (Antigravity's Gemini API key).
    secret: async (name) => name === "GEMINI_API_KEY" ? (await client.query(api.engines.secret, { token, name })) ?? undefined : undefined,
  });
  // However the runner ends (stopped, a crash, its console closed), the agents it started end with it.
  process.on("exit", () => { for (const engine of engines.values()) engine.kill(); });
  /** What each engine's last probe found. */
  const statuses = new Map<EngineKind, EngineStatus>();
  /** Engines with an update from Settings taken on (handleUpdate): no new turn starts on them here until it is done. */
  const updating = new Set<EngineKind>();
  /** Engines whose CLI is being replaced right now: not looked at, so nothing starts the old one or a half-installed one meanwhile. */
  const replacing = new Set<EngineKind>();
  /** Quick turns (the reviewer, chat names) running, by engine: an update waits for them as for a reply. */
  const quickRunning = new Map<EngineKind, number>();
  /** The engine of a turn being claimed (pumpTurns), not yet among those running: an update waits for it too. */
  let claiming: EngineKind | null = null;
  const probeEngines = async () => {
    const found = await Promise.all([...engines.values()].map((engine) => {
      const kept = replacing.has(engine.kind) ? statuses.get(engine.kind) : undefined;
      if (kept) return Promise.resolve(kept);
      return engine.status()
        .catch((error): EngineStatus => ({ kind: engine.kind, installed: false, signedIn: false, auth: {}, models: [], error: message(error) }))
        // With the newest release known and the command that updates it; never waiting to look it up.
        .then(withVersions);
    }));
    for (const status of found) {
      // Said here once, when an engine is found too old for Perry; Settings says it until it is updated.
      const update = updateOf(status);
      const before = statuses.get(status.kind);
      if (update?.need === "required" && (!before || updateOf(before)?.need !== "required")) console.log(yellow(`  ${refusal(ENGINE_LABELS[status.kind], update)}`));
      statuses.set(status.kind, status);
    }
    await client.mutation(api.engines.report, { token, engines: found });
  };
  /** An engine older than Perry works with, as its last probe found: it takes no turns until it is updated. */
  const tooOld = (kind: EngineKind) => {
    const status = statuses.get(kind);
    const update = status && updateOf(status);
    return update?.need === "required" ? update : undefined;
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
  /** When each engine's plan limits were last read, those being read, and reads waiting their minute. */
  const limitsRead = new Map<EngineKind, number>();
  const readingLimits = new Set<EngineKind>();
  const limitsLater = new Map<EngineKind, ReturnType<typeof setTimeout>>();
  /**
   * Read how much of an engine's plan is used and report it (convex/usage.ts):
   * every LIMITS_EVERY_MS while it is signed in, or now (`fresh`), for an
   * engine that can say. None of the plan is spent reading it.
   */
  const readLimits = async (engine: Engine, fresh = false) => {
    if (!engine.limits || !statuses.get(engine.kind)?.signedIn || readingLimits.has(engine.kind) || replacing.has(engine.kind)) return;
    if (!fresh && Date.now() - (limitsRead.get(engine.kind) ?? 0) < LIMITS_EVERY_MS) return;
    readingLimits.add(engine.kind);
    limitsRead.set(engine.kind, Date.now());
    try {
      const limits = await engine.limits();
      if (limits) await client.mutation(api.usage.report, { token, engine: engine.kind, limits });
    } catch (error) {
      console.log(dim(`  could not read ${engine.label}'s plan limits: ${message(error)}`));
    } finally {
      readingLimits.delete(engine.kind);
    }
  };
  /** After a turn, its engine's limits are read again: at once, or when a minute has passed since the last read. */
  const readLimitsSoon = (engine: Engine) => {
    if (!engine.limits || limitsLater.has(engine.kind)) return;
    const wait = Math.max(0, (limitsRead.get(engine.kind) ?? 0) + 60_000 - Date.now());
    limitsLater.set(engine.kind, setTimeout(() => {
      limitsLater.delete(engine.kind);
      void readLimits(engine, true);
    }, wait));
  };
  const readAllLimits = () => { for (const engine of engines.values()) void readLimits(engine); };
  /** The owner's default engine, as the server has it; unset until chosen. */
  let defaultEngine: EngineKind | undefined;
  watch(api.engines.preferred, { token }, (engine) => { defaultEngine = engine ?? undefined; });
  /**
   * An engine for quick side turns (the reviewer, chat names): the preferred
   * one (the chat's) when it runs them and is signed in, else the owner's
   * default engine, else any that is.
   */
  const quickEngine = (preferred?: EngineKind): Engine | undefined => {
    const ready = (engine?: Engine) => engine?.quickTurn && engine.capabilities.quickTurns && statuses.get(engine.kind)?.signedIn && !tooOld(engine.kind) && !updating.has(engine.kind) ? engine : undefined;
    return ready(preferred ? engines.get(preferred) : undefined) ?? ready(defaultEngine ? engines.get(defaultEngine) : undefined)
      ?? [...engines.values()].find((engine) => ready(engine));
  };
  /** A quick turn on an engine, counted while it runs. */
  const quickly = async <T,>(engine: Engine | undefined, work: () => Promise<T>): Promise<T> => {
    if (!engine) return work();
    quickRunning.set(engine.kind, (quickRunning.get(engine.kind) ?? 0) + 1);
    try { return await work(); }
    finally { quickRunning.set(engine.kind, (quickRunning.get(engine.kind) ?? 1) - 1); }
  };
  /** Until when each running turn may go past its limits, by turn: the agent asked (take_longer). */
  let patience: Record<string, number> = {};
  /**
   * The turn watchdog. A turn quiet for `idleMs` (unset: never), or running
   * past `maxMs`, is interrupted, and if it has not ended KILL_GRACE_MS later,
   * or never started, it is ended with `end` (by default its engine, process
   * group and all, which fails what it was doing). `active()` says it did
   * something; while `patient()` is in the future, or it is `waiting()` for
   * the owner's answer, it runs on, and the idle time after it starts afresh.
   */
  const watchdog = (
    engine: Engine, { idleMs, maxMs }: { idleMs?: number; maxMs: number }, handle: () => TurnHandle | undefined,
    { patient = () => 0, waiting = () => false, end = () => engine.kill() }: { patient?: () => number; waiting?: () => boolean; end?: () => void } = {},
  ) => {
    const started = Date.now();
    let lastActive = started;
    let grantedUntil = 0;
    let why: string | null = null;
    let kill: ReturnType<typeof setTimeout> | undefined;
    const span = (ms: number) => ms >= 60_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 1000)} seconds`;
    const stop = (reason: string, log: string) => {
      why = reason;
      const running = handle();
      console.log(yellow(`  ${engine.label} ${log}; stopping it`));
      if (running) void engine.interrupt(running).catch(() => {});
      kill = setTimeout(() => {
        console.log(yellow(`  ${engine.label} did not stop; ending it`));
        end();
      }, running ? KILL_GRACE_MS : 0);
    };
    const timer = setInterval(() => {
      if (why) return;
      const now = Date.now();
      const until = patient();
      if (until > now || waiting()) {
        grantedUntil = Math.max(grantedUntil, until);
        lastActive = now;
        return;
      }
      if (idleMs && now - lastActive > idleMs) stop(`It went quiet for more than ${span(idleMs)}, so it was stopped.`, `was quiet for ${span(idleMs)}`);
      // Past the time it asked for, it still has the usual quiet allowance before the cap.
      else if (now > Math.max(started + maxMs, grantedUntil + (idleMs ?? 0))) stop(`It ran for more than ${span(grantedUntil ? now - started : maxMs)}, so it was stopped.`, `ran past ${span(maxMs)}`);
    }, WATCHDOG_TICK_MS);
    return {
      active: () => { lastActive = Date.now(); },
      expired: () => why !== null,
      why: () => why ?? "",
      done: () => { clearInterval(timer); clearTimeout(kill); },
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
      const reviewer = quickEngine(engine);
      const verdict = await quickly(reviewer, () => review(reviewer, {
        kind: request.kind,
        title: request.what,
        cwd: request.cwd,
        workdir,
        paths: request.paths,
        detail: [request.detail, request.evidence].filter(Boolean).join("\n\n") || undefined,
      }));
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
        // "auto": the chat was put on Full access while this waited.
        if (status === "approved" || status === "auto" || status === "declined") settle(status !== "declined", "elsewhere");
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
  await client.mutation(api.engineUpdates.recover, { token });
  await refreshEngines();
  readAllLimits();
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
    void refreshEngines().then(readAllLimits);
    void recoverTurns(false).catch((error) => console.error(red(`  turn delivery retry failed: ${message(error)}`)));
  }, CHECKIN_MS);
  console.log(green("  connected.\n"));

  /** Sign an engine in or out, as asked in Settings, saying what the owner must do meanwhile. */
  const handleAuth = async (request: { engine: EngineKind; id: number; kind: "login" | "logout"; method?: string }) => {
    const claimed = await client.mutation(api.engines.claimAuth, { token, engine: request.engine, id: request.id });
    if (!claimed) return;
    const update = (payload: Omit<FunctionArgs<typeof api.engines.updateAuth>, "token" | "engine" | "id">) =>
      client.mutation(api.engines.updateAuth, { token, engine: request.engine, id: request.id, ...payload });
    try {
      const engine = engines.get(request.engine);
      if (!engine) throw new Error(`${ENGINE_LABELS[request.engine]} is not on this computer's runner yet. Update Perry here.`);
      // Its CLI may be half replaced, and its processes are ended as it is.
      if (updating.has(request.engine)) throw new Error(`${engine.label} is being updated on this computer. Sign in once that's done`);
      if (request.kind === "logout") {
        await engine.logout();
      } else {
        const flow = await engine.login(request.method);
        // A sign-in can fail before it is awaited below (a bad download, say); unhandled, that would end the runner.
        flow.done.catch(() => {});
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

  /** Where a chat with someone else runs: an empty folder, so nothing of the owner's is at hand. */
  const guestDir = () => { mkdirSync(PATHS.guest, { recursive: true }); return PATHS.guest; };

  /**
   * The skills a message of the owner's names ("$weekly-review", from the web
   * app, Telegram or WhatsApp alike), for its engine: as input of their own
   * where it takes them, else named after the message with where each
   * SKILL.md is. Someone else's message names none of the owner's skills.
   */
  const withSkills = (engine: Engine, prompt: string, guest?: boolean): { prompt: string; skills?: NamedSkill[] } => {
    const skills = guest ? [] : skillsNamedIn(prompt);
    if (!skills.length) return { prompt };
    console.log(dim(`  using ${skills.map((skill) => `$${skill.name}`).join(", ")}`));
    return engine.capabilities.skills ? { prompt, skills } : { prompt: `${prompt}\n\n${skillNote(skills)}` };
  };

  /** Perry's tools for a turn: over HTTP with this runner's token, or through the stdio bridge. */
  const toolsFor =(mcpUrl: string | undefined, chat: string): PerryTools | undefined => {
    if (!mcpUrl) return undefined;
    const address = client.resolve(mcpUrl);
    return {
      name: "assistant",
      http: { url: address, headers: { Authorization: `Bearer ${token}` } },
      stdio: { command: process.execPath, args: [MCP_BRIDGE], env: { PERRY_MCP_URL: address, PERRY_MCP_TOKEN: token } },
      chat,
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
   * The turns running now, by turn, from the claim until the result is
   * delivered. Chats, jobs and background tasks run side by side, up to
   * MAX_TURNS at once, so a reply does not wait for the heartbeat or a task.
   * A chat's own turns still run one after another (the server claims one per
   * chat), and an engine that cannot run several (capabilities.concurrentTurns)
   * runs one of its turns at a time.
   */
  type Active = {
    jobId: Id<"codexTurns">;
    conversationId: Id<"conversations">;
    engine: Engine | undefined;
    /** The engine's handle, while the turn runs there. */
    handle?: TurnHandle;
    /** Approvals being waited on: a turn waiting for the owner is not stuck. */
    asking: number;
    /** The access the engine was last given for the turn. */
    access?: Access;
    /** Stop waiting for the turn, which its engine may still be running. */
    abandon?: () => void;
    /** A chat with someone else, whose messages name none of the owner's skills. */
    guest?: boolean;
  };
  const active = new Map<string, Active>();
  let turnQueue: Doc<"codexTurns">[] = [];
  // The turns the owner asked to stop, those being stopped, and those whose engine had to be ended for it.
  let stopRequested = new Set<string>();
  const stopping = new Set<string>();
  const endedOnStop = new Set<string>();
  /**
   * End a turn that will not stop. Its engine is ended, process group and all,
   * when no other turn runs on it; otherwise the turn is given up on, and the
   * other turns go on.
   */
  const endTurn = (jobId: string) => {
    const turn = active.get(jobId);
    if (!turn?.engine) return;
    const shared = [...active.values()].some((other) => other.jobId !== jobId && other.engine === turn.engine && other.handle);
    if (shared && turn.abandon) turn.abandon();
    else turn.engine.kill();
  };
  const interruptIfAsked = () => {
    for (const { jobId, engine, handle } of active.values()) {
      if (!engine || !handle || !stopRequested.has(jobId) || stopping.has(jobId)) continue;
      stopping.add(jobId);
      console.log(yellow(`  stopping the ${engine.label} turn, as asked`));
      void engine.interrupt(handle).catch((error) => console.error(red(`  Could not stop the ${engine.label} turn: ${message(error)}`)));
      // An engine too stuck to hear it is ended, as the watchdog does, and the turn counts as stopped.
      setTimeout(() => {
        if (!active.get(jobId)?.handle) return;
        console.log(yellow(`  ${engine.label} did not stop; ending it`));
        endedOnStop.add(jobId);
        endTurn(jobId);
      }, KILL_GRACE_MS);
    }
  };
  /**
   * The owner changed a running turn's access: tell its engine, which acts on
   * it from the turn's next step. Approvals follow the new access regardless.
   */
  let accessNow: Record<string, Access> = {};
  const applyAccess = () => {
    for (const turn of active.values()) {
      const wanted = accessNow[turn.jobId];
      const { engine, handle } = turn;
      if (!wanted || wanted === turn.access || !engine || !handle) continue;
      turn.access = wanted;
      console.log(dim(`  this chat is on ${ACCESS_LABELS[wanted]} now; the ${engine.label} turn follows it from its next step`));
      void engine.setAccess?.(handle, wanted).catch((error) => console.error(red(`  Could not change the ${engine.label} turn's access: ${message(error)}`)));
    }
  };
  // Messages the owner sent while a turn runs, and those already handed to its engine, by steer.
  let pendingSteers: Array<{ _id: Id<"codexSteers">; turnId: Id<"codexTurns">; prompt: string; attachments?: Doc<"codexTurns">["attachments"] }> = [];
  const steered = new Map<string, { turnId: string; done: Promise<unknown> }>();
  /**
   * Hand each new message for a running turn to its engine, then tell Convex
   * whether it took it. One it refused ("no active turn to steer", a turn id
   * mismatch), or an engine that takes one message at a time, is queued as a
   * turn of its own there.
   */
  const steerIfAsked = () => {
    for (const steer of pendingSteers) {
      const turn = active.get(steer.turnId);
      if (!turn?.engine || !turn.handle || steered.has(steer._id)) continue;
      const { engine, handle } = turn;
      steered.set(steer._id, { turnId: steer.turnId, done: (async () => {
        try {
          const mode = engine.capabilities.steer;
          if (!engine.steer || (mode !== "native" && mode !== "concurrent-prompt")) throw new Error(`${engine.label} takes one message at a time`);
          await engine.steer(handle, { ...withSkills(engine, steer.prompt, turn.guest), attachments: await localise(steer.attachments) });
          console.log(dim(`  steered the ${engine.label} turn with a new message`));
          await client.mutation(api.codex.ackSteer, { token, id: steer._id, applied: true });
        } catch (error) {
          console.log(yellow(`  could not steer the ${engine.label} turn, so the message waits its turn: ${message(error)}`));
          await client.mutation(api.codex.ackSteer, { token, id: steer._id, applied: false, error: message(error) });
        }
      })().catch((error) => console.error(red(`  Could not report a steer: ${message(error)}`))) });
    }
  };

  /** Run a claimed turn on its engine, or deliver the result a runner saved before it stopped. */
  const runJob = async (job: NonNullable<FunctionReturnType<typeof api.codex.claimTurn>>, turn: Active) => {
    let result = savedResult(job._id);
    if (!result) {
      // The reply so far, and the trace of what the engine is doing, go to Convex
      // about three times a second while the turn runs; the first words go at once.
      let latest = "";
      let sent = "";
      let streamTimer: ReturnType<typeof setTimeout> | null = null;
      const trace = new TurnTrace();
      // One report at a time: one still on its way when the turn ends would arrive after it, and be dropped.
      let reporting = Promise.resolve();
      const report = () => (reporting = reporting.then(async () => {
        const changes = trace.take();
        if (!changes) return;
        await client.mutation(api.codex.traceTurn, { token, id: job._id, ...changes }).catch(() => trace.retry(changes));
      }));
      const flush = () => {
        streamTimer = null;
        void report();
        if (latest === sent) return;
        sent = latest;
        void client.mutation(api.codex.streamTurn, { token, id: job._id, text: latest }).catch(() => {});
      };
      const schedule = () => {
        if (sent || !latest) streamTimer ??= setTimeout(flush, 300);
        else { if (streamTimer) clearTimeout(streamTimer); flush(); }
      };
      const kind = job.engine;
      const engine = engines.get(kind);
      // What the run records: the engine and model, the effort sent, and full access when it was.
      const label = runLabel(job.requestedModel, job.requestedEffort, job.access, kind);
      if (job.access === "full" && job.kind !== "compact") {
        console.log(yellow(`  full access: this turn runs without the sandbox, and nothing waits for you`));
      } else if (job.access === "auto" && job.kind !== "compact") {
        console.log(dim("  auto: each command is reviewed before it runs; risky ones wait for you"));
      }
      // Given up on (endTurn), a turn ends here while its engine goes on with the others.
      const givenUp = new Promise<never>((_, reject) => {
        turn.abandon = () => reject(new Error(`${engine?.label ?? "The engine"} did not stop, so Perry stopped waiting for it.`));
      });
      givenUp.catch(() => {});
      const unlessGivenUp = <T,>(work: Promise<T>) => {
        work.catch(() => {});
        return Promise.race([work, givenUp]);
      };
      let dog: ReturnType<typeof watchdog> | undefined;
      try {
        if (!engine) throw new Error(`${ENGINE_LABELS[kind]} is not on this computer's runner. Update Perry here, or pick another engine's model.`);
        // Refused before it starts, rather than failing half-way in ways an old CLI would.
        const update = tooOld(kind);
        if (update) throw new Error(refusal(engine.label, update));
        if (job.kind === "compact") {
          if (!job.resumeCursor) throw new Error("This chat has no session to compact yet.");
          console.log(dim(`  compacting a chat's ${engine.label} session`));
          dog = watchdog(engine, { maxMs: COMPACT_TIMEOUT_MS }, () => undefined, { end: () => endTurn(job._id) });
          await unlessGivenUp(compact(engine, job.resumeCursor, job.access, job.requestedModel)).finally(dog.done);
          result = { response: "Compacted.", compacted: true, model: runLabel(undefined, undefined, undefined, kind) };
        } else {
          const sink: TurnSink = {
            onSession: (cursor, replaces) => client.mutation(api.codex.setResume, { token, id: job._id, cursor, ...(replaces ? { replaces } : {}) }),
            onStarted: (handle) => {
              dog?.active();
              turn.handle = handle;
              void client.mutation(api.codex.setCodexTurn, { token, id: job._id, codexTurnId: handle.turnId }).catch(() => {});
              interruptIfAsked();
              steerIfAsked();
              applyAccess();
            },
            onEvent: (event) => {
              dog?.active();
              if (event.type === "text") {
                if (event.stream !== "assistant") return;
                latest = event.text;
                schedule();
              } else if (event.type === "item") {
                if (trace.item(event.phase, event.item, event.atMs)) schedule();
              } else if (event.state !== "unavailable") {
                trace.addUsage(event.usage, event.contextWindow);
                schedule();
              }
            },
            onRequest: (request) => {
              turn.asking += 1;
              return answer(request, job.conversationId, kind).finally(() => { turn.asking -= 1; dog?.active(); });
            },
          };
          dog = watchdog(engine, { idleMs: TURN_IDLE_MS, maxMs: TURN_TIMEOUT_MS }, () => turn.handle, {
            patient: () => patience[job._id] ?? 0,
            waiting: () => turn.asking > 0,
            end: () => endTurn(job._id),
          });
          const outcome: TurnResult = await unlessGivenUp(engine.runTurn({
            resumeCursor: job.resumeCursor,
            instructions: job.instructions,
            history: job.history,
            recalled: job.recalled,
            ...withSkills(engine, job.prompt, job.guest),
            attachments: await localise(job.attachments),
            cwd: job.guest ? guestDir() : workdir,
            model: job.requestedModel,
            effort: job.requestedEffort,
            access: job.access ?? "supervised",
            tools: toolsFor(job.mcpUrl, job.conversationId),
            ...(job.guest ? { guest: true } : {}),
          }, sink)).catch((error) => {
            // What it wrote before it was given up on is kept, as for a failed turn.
            if (!dog?.expired() && !endedOnStop.has(job._id)) throw error;
            return { state: "failed", cursor: job.resumeCursor ?? "", text: latest, images: [], error: message(error) } satisfies TurnResult;
          }).finally(dog.done);
          const media = await keepMedia(job._id, job.channel, outcome.images);
          // A late failure keeps what the turn had already produced.
          const ended = endedOnStop.has(job._id);
          const failed = (outcome.state === "failed" && !ended) || dog.expired();
          result = {
            ...(failed ? { error: dog.expired() ? dog.why() : outcome.error ?? `The ${engine.label} turn failed.` } : {}),
            ...(outcome.text || !failed ? { response: outcome.text } : {}),
            ...(ended || (!failed && outcome.state !== "completed") ? { stopped: true } : {}),
            ...(outcome.compacted ? { compacted: true } : {}),
            model: label,
            ...(media.length ? { media } : {}),
          };
        }
      } catch (error) {
        result = endedOnStop.has(job._id) ? { stopped: true, model: label } : { error: dog?.expired() ? dog.why() : message(error), model: label };
      } finally {
        turn.handle = undefined;
        turn.abandon = undefined;
        stopping.delete(job._id);
        endedOnStop.delete(job._id);
      }
      if (streamTimer) clearTimeout(streamTimer);
      // A steer still being answered must be recorded as applied or not
      // before finishTurn queues whatever the turn did not take.
      const steers = [...steered].filter(([, steer]) => steer.turnId === job._id);
      await Promise.all(steers.map(([, steer]) => steer.done));
      for (const [id] of steers) steered.delete(id);
      saveResult(job._id, result);
      // Where the engine's plan stands after the turn: a limit it refused the turn for, or, as it went through, none.
      if (engine && job.kind !== "compact") {
        const hit = result.error && LIMIT_HIT.test(result.error) ? { at: Date.now(), message: result.error } : result.error || result.stopped ? undefined : null;
        if (hit !== undefined) void client.mutation(api.usage.report, { token, engine: kind, hit }).catch(() => {});
        if (hit) console.log(yellow(`  ${engine.label} refused the turn for your plan's limit`));
        readLimitsSoon(engine);
      }
      // The trace's last report goes before the turn ends; Convex takes reports only while it runs.
      trace.drain(Date.now());
      await report();
    }
    await client.mutation(api.codex.finishTurn, { token, id: job._id, ...result });
  };

  /** How many turns run at once on this computer (PERRY_MAX_TURNS). */
  const MAX_TURNS = Math.max(1, Math.floor(Number(process.env.PERRY_MAX_TURNS)) || 4);
  let pumping = false;
  let pumpAgain = false;
  /** Start every queued turn that can start now, oldest first. */
  const pumpTurns = async () => {
    if (pumping) { pumpAgain = true; return; }
    pumping = true;
    try {
      do {
        pumpAgain = false;
        // A chat's turns go in order: one running or waiting holds back the chat's later ones.
        const held = new Set<string>([...active.values()].map((turn) => turn.conversationId));
        for (const next of turnQueue) {
          if (active.size >= MAX_TURNS) break;
          if (active.has(next._id) || held.has(next.conversationId)) continue;
          held.add(next.conversationId);
          // An engine being updated here starts nothing new until it is done (handleUpdate).
          if (next.engine && updating.has(next.engine)) continue;
          const engine = next.engine ? engines.get(next.engine) : undefined;
          if (engine && !engine.capabilities.concurrentTurns && [...active.values()].some((turn) => turn.engine === engine)) continue;
          claiming = next.engine ?? null;
          const job = await client.mutation(api.codex.claimTurn, { token, id: next._id })
            .catch((error) => { console.error(red(`  could not claim a turn: ${message(error)}`)); return null; });
          if (!job) { claiming = null; continue; }
          const turn: Active = { jobId: job._id, conversationId: job.conversationId, engine: engines.get(job.engine), asking: 0, access: job.access ?? "supervised", ...(job.guest ? { guest: true } : {}) };
          active.set(job._id, turn);
          claiming = null;
          void runJob(job, turn)
            .catch((error) => console.error(red(`  turn failed: ${message(error)}`)))
            .finally(async () => {
              active.delete(job._id);
              turnQueue = await client.query(api.codex.queuedTurns, { token }).catch(() => turnQueue);
              void pumpTurns();
            });
        }
      } while (pumpAgain);
    } finally {
      pumping = false;
    }
  };
  watch(api.codex.queuedTurns, { token }, (jobs) => {
    turnQueue = jobs ?? [];
    void pumpTurns();
  });
  watch(api.codex.turnPatience, { token }, (until) => {
    patience = until ?? {};
  });
  watch(api.codex.stopRequests, { token }, (ids) => {
    stopRequested = new Set(ids ?? []);
    interruptIfAsked();
  });
  watch(api.codex.turnAccess, { token }, (access) => {
    accessNow = access ?? {};
    applyAccess();
  });
  watch(api.codex.pendingSteers, { token }, (steers) => {
    pendingSteers = steers ?? [];
    steerIfAsked();
  });

  // --- Updating an engine's CLI, as asked in Settings -----------------------------

  /** How long an update may run (PERRY_ENGINE_UPDATE_MS): past it, it is ended, and said to have failed. */
  const UPDATE_MS = Number(process.env.PERRY_ENGINE_UPDATE_MS) || 10 * 60_000;
  /** What runs on an engine here: its turns (a reply, a compaction) and quick turns. An update waits for all of them. */
  const busyOn = (kind: EngineKind) =>
    [...active.values()].filter((turn) => turn.engine?.kind === kind).length + (quickRunning.get(kind) ?? 0) + (claiming === kind ? 1 : 0);
  /**
   * Update an engine's CLI the way it was installed here (versions.ts,
   * updatePlan), and look at it again. Never while anything runs on it: from
   * the moment it is taken on no new turn starts on that engine (pumpTurns),
   * and it waits for the ones running, saying so. One that would need admin
   * rights is not run: the owner is shown the command to run themselves.
   */
  const handleUpdate = async (request: { id: Id<"engineUpdates">; engine: EngineKind }) => {
    if (updating.has(request.engine)) return;
    if (!await client.mutation(api.engineUpdates.claim, { token, id: request.id }).catch(() => false)) return;
    const kind = request.engine;
    const engine = engines.get(kind);
    const label = ENGINE_LABELS[kind];
    // One report at a time, in order, so what it printed last is never overwritten by what came before.
    // How it ended is tried again for a while: lost, Settings would say it was still updating.
    let reporting = Promise.resolve();
    const progress = (payload: Omit<FunctionArgs<typeof api.engineUpdates.progress>, "token" | "id">) => (reporting = reporting.then(async () => {
      for (let tries = payload.status === "waiting" || payload.status === "running" ? 1 : 10; tries > 0; tries--) {
        try {
          await client.mutation(api.engineUpdates.progress, { token, id: request.id, ...payload });
          return;
        } catch (error) {
          if (tries === 1) console.error(red(`  could not report ${label}'s update: ${message(error)}`));
          else await new Promise((resolve) => setTimeout(resolve, 3_000));
        }
      }
    }));
    updating.add(kind);
    try {
      const where = engine?.where?.();
      const plan = where ? updatePlan(kind, where) : undefined;
      if (!engine || !plan) throw new Error(`${label} can't be updated from Perry on this computer.`);
      if (plan.locked.length) {
        console.log(yellow(`  ${label}'s update needs admin rights here (it writes to ${plan.locked.join(", ")}), so it was not run`));
        await progress({
          status: "elevate", command: plan.elevated,
          error: `Updating ${label} here writes to ${plan.locked.join(" and ")}, which needs ${process.platform === "win32" ? "administrator rights" : "sudo"}. Perry doesn't run anything with those.`,
        });
        return;
      }
      for (let said = "", busy = busyOn(kind); busy; busy = busyOn(kind)) {
        const waitingFor = `${busy === 1 ? "a reply" : `${busy} replies`} on ${label}`;
        if (waitingFor !== said) {
          said = waitingFor;
          console.log(dim(`  ${label}'s update waits for ${waitingFor} to finish`));
          await progress({ status: "waiting", waitingFor });
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      // A look at the engines already under way ends first; after it, nothing looks at this one until it is done.
      await refreshEngines();
      const before = versionIn(statuses.get(kind)?.version);
      console.log(dim(`  updating ${label}: ${plan.command}`));
      // Its processes hold the old CLI's files: they end first.
      replacing.add(kind);
      engine.reload?.();
      await progress({ status: "running", command: plan.command, output: "" });
      let sent = 0;
      let later: ReturnType<typeof setTimeout> | undefined;
      let latest = "";
      const ran = await runUpdate(plan, UPDATE_MS, (output) => {
        latest = output;
        // What it prints goes to Settings about twice a second.
        later ??= setTimeout(() => { later = undefined; sent = Date.now(); void progress({ status: "running", output: latest }); }, Math.max(0, sent + 500 - Date.now()));
      });
      clearTimeout(later);
      engine.reload?.();
      replacing.delete(kind);
      await refreshEngines(true);
      const after = versionIn(statuses.get(kind)?.version);
      if (ran.timedOut || ran.code !== 0) {
        const limit = UPDATE_MS >= 120_000 ? `${Math.round(UPDATE_MS / 60_000)} minutes` : `${Math.round(UPDATE_MS / 1000)} seconds`;
        const why = ran.timedOut ? `It didn't finish within ${limit}, so Perry stopped it.` : ran.code === null ? "It couldn't start." : `It stopped with exit code ${ran.code}.`;
        console.log(yellow(`  ${label}'s update failed: ${why}`));
        await progress({ status: "error", output: ran.output, error: why });
      } else if (!after || after === before) {
        console.log(yellow(`  ${label}'s update finished, but it is still ${after ?? "not answering"}`));
        await progress({ status: "error", output: ran.output, error: after ? `It finished, but ${label} still says ${after}.` : `It finished, but ${label} doesn't answer now.` });
      } else {
        console.log(green(`  updated ${label} from ${before ?? "?"} to ${after}`));
        await progress({ status: "done", output: ran.output, to: after });
      }
    } catch (error) {
      await progress({ status: "error", error: message(error) });
    } finally {
      if (replacing.delete(kind)) {
        engine?.reload?.();
        void refreshEngines(true);
      }
      updating.delete(kind);
      void pumpTurns();
    }
  };
  watch(api.engineUpdates.queued, { token }, (requests) => {
    for (const request of requests ?? []) void handleUpdate(request);
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
      // Counted from here, so an update of its engine waits for the whole of it.
      void quickly(namer, async () => {
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
      })
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
  // Its terminal or console window closed.
  process.on("SIGHUP", stop);
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
