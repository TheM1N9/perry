import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, extname, join, resolve } from "node:path";
import {
  query, type ModelInfo, type Options, type PermissionMode, type PermissionResult, type Query, type SDKMessage, type SDKResultMessage,
  type SDKUserMessage, type SpawnOptions, type SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import { ACCESSES } from "../../convex/lib/commands";
import { updateOf } from "../../convex/lib/engines";
import type {
  Access, Engine, EngineAttachment, EngineCapabilities, EngineItem, EngineModel, EngineRequest, EngineStatus, ItemStatus, ItemType,
  LoginFlow, PlanLimits, PlanWindow, QuickTurn, TokenUsage, TurnHandle, TurnInput, TurnResult, TurnSink,
} from "../engine";
import { toolsOfChat } from "../engine";
import { HOME, PATHS } from "../home";
import { describeMachine } from "../shell";
import { updateCommand } from "../versions";
import { killTree } from "./process";

/**
 * Claude Code, driven through Anthropic's Claude Agent SDK, running the
 * owner's own `claude` and signed in the way they signed it in themselves
 * (`claude auth login`, a Claude subscription). Perry never signs Claude Code
 * in, never reads or copies its credentials and never stands between the
 * owner and claude.ai: it starts the official binary and reads what
 * `claude auth status` says. So it never starts Claude Code in bare mode,
 * which would ignore that sign-in.
 *
 * Each chat has one `claude` process in streaming-input mode, kept between
 * its turns: the prompt goes in, the reply streams out, a message the owner
 * sends meanwhile joins the turn at its next step, and the process waits for
 * the chat's next message. Sessions resume by their id, which Perry picks
 * when it starts one.
 */

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const json = (value: unknown) => {
  try { return value === undefined || value === null ? undefined : JSON.stringify(value); }
  catch { return undefined; }
};
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** The model quick turns use unless PERRY_CLAUDE_REVIEW_MODEL or PERRY_CLAUDE_TITLE_MODEL says otherwise: the fastest. */
const QUICK_MODEL = "haiku";
/** How long a sign-in in the terminal is waited for. */
const LOGIN_WAIT_MS = 10 * 60_000;
const VERSION_TTL_MS = 10 * 60_000;
/** How long reading the plan's limits may take: a second, usually. */
const LIMITS_TIMEOUT_MS = 20_000;
/** Image types Claude reads; other attachments are named by their path. */
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
/**
 * The models offered before any session has said which this account has. A
 * session's own list (supportedModels) replaces them once one has run; no
 * session is started just to ask.
 */
const SEED_MODELS: EngineModel[] = [
  { id: "default", name: "Default (recommended)", isDefault: true, efforts: EFFORTS, defaultEffort: "high" },
  { id: "sonnet", name: "Sonnet", isDefault: false, efforts: EFFORTS, defaultEffort: "high" },
  { id: "opus", name: "Opus", isDefault: false, efforts: EFFORTS, defaultEffort: "high" },
  { id: "haiku", name: "Haiku", isDefault: false },
  { id: "claude-sonnet-5", name: "Sonnet 5", isDefault: false, efforts: EFFORTS, defaultEffort: "high" },
  { id: "claude-haiku-4-5", name: "Haiku 4.5", isDefault: false },
];

/**
 * Tools that need someone at Claude Code's own prompt, or a session that
 * outlives the turn: Perry has neither. Claude asks in its reply instead, and
 * Perry's own tools schedule things.
 */
const DISALLOWED = [
  "AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "CronCreate", "CronDelete", "CronList", "ScheduleWakeup",
  "RemoteTrigger", "PushNotification",
];
const COMMAND_TOOLS = new Set(["Bash", "PowerShell"]);
const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

// --- The owner's own claude --------------------------------------------------

/** How to run the owner's `claude`: a command and the arguments before its own. */
type Binary = {
  /** Where it was found: on PATH, or where the native installer puts it. */
  file: string;
  command: string;
  prefix: string[];
  /** For the SDK: the native binary or cli.js. Unset when only a shim was found, and the SDK's own copy of the same CLI runs. */
  sdkPath?: string;
};

/**
 * npm's Windows shim runs `"%dp0%\node_modules\...\claude.exe" %*` (or node
 * with cli.js); the SDK cannot spawn a .cmd, so the file it runs is used.
 */
function throughShim(shim: string): string | undefined {
  try {
    for (const match of readFileSync(shim, "utf8").matchAll(/"%~?dp0%?\\?([^"%]+?\.(?:exe|js|cjs|mjs))"/gi)) {
      const target = resolve(dirname(shim), match[1]);
      if (existsSync(target)) return target;
    }
  } catch {}
  return undefined;
}

const runnable = (file: string, path: string): Binary => /\.(?:c|m)?js$/i.test(path)
  ? { file, command: process.execPath, prefix: [path], sdkPath: path }
  : { file, command: path, prefix: [], sdkPath: path };

/**
 * The owner's `claude`, as installed: on PATH, or where the native installer
 * puts it (a service may run with a thinner PATH). Undefined when it is not on
 * this computer.
 */
export function findClaude(): Binary | undefined {
  const windows = process.platform === "win32";
  const dirs = [...(process.env.PATH ?? "").split(delimiter).filter(Boolean), join(homedir(), ".local", "bin"), join(homedir(), ".claude", "local")];
  const names = windows ? ["claude.exe", "claude.cmd"] : ["claude"];
  let shim: string | undefined;
  for (const dir of dirs) {
    for (const name of names) {
      const file = join(dir, name);
      try { if (!statSync(file).isFile()) continue; } catch { continue; }
      if (!windows) return runnable(file, realpathSync(file));
      if (extname(file).toLowerCase() === ".exe") return runnable(file, file);
      const target = throughShim(file);
      if (target) return runnable(file, target);
      shim ??= file;
    }
  }
  // A shim whose target could not be read still signs in and reports; the SDK's own copy of Claude Code runs the turns.
  return shim ? { file: shim, command: process.env.COMSPEC || "cmd.exe", prefix: ["/d", "/s", "/c", shim] } : undefined;
}

function run(binary: Binary, args: string[], timeoutMs = 20_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(binary.command, [...binary.prefix, ...args], { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      done({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** What `claude auth status` says: account metadata only, never a token. */
type Account = { loggedIn?: boolean; authMethod?: string; apiProvider?: string; email?: string; orgName?: string; subscriptionType?: string };

async function account(binary: Binary): Promise<Account> {
  const { stdout, stderr } = await run(binary, ["auth", "status", "--json"]);
  try { return JSON.parse(stdout) as Account; }
  catch { throw new Error(`claude auth status answered: ${(stdout || stderr).trim().slice(0, 200) || "nothing"}`); }
}

// --- Turns -------------------------------------------------------------------

/** Messages for a running `claude`, as the SDK's streaming input: pushed as they come, until closed. */
class Inbox implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  closed = false;
  push(item: SDKUserMessage) { this.queue.push(item); this.wake?.(); }
  close() { this.closed = true; this.wake?.(); }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      while (this.queue.length) yield this.queue.shift()!;
      if (this.closed) return;
      await new Promise<void>((done) => { this.wake = done; });
      this.wake = null;
    }
  }
}

type Block = { type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

/** The owner's message: history, recalled memory and any note from Perry ahead of it, images as images, other files by their path. */
async function userMessage(prompt: string, attachments: EngineAttachment[], extra: { recalled?: string; history?: string; note?: string } = {}): Promise<SDKUserMessage> {
  const text = { type: "text" as const, text: prompt };
  const blocks: Block[] = [];
  if (extra.history) blocks.push({ type: "text", text: `Earlier chat history (context, not a new user request):\n${extra.history}` });
  // Recalled memory goes first, as its own part of the owner's message.
  if (extra.recalled) blocks.push({ type: "text", text: extra.recalled });
  // A note from Perry about the chat (its access changed) comes right before the owner's words.
  if (extra.note) blocks.push({ type: "text", text: extra.note });
  blocks.push(text);
  for (const attachment of attachments) {
    const path = attachment.localPath;
    if (path && attachment.contentType && IMAGE_TYPES.has(attachment.contentType)) {
      try {
        blocks.push({ type: "image", source: { type: "base64", media_type: attachment.contentType, data: (await readFile(path)).toString("base64") } });
        continue;
      } catch {}
    }
    text.text += `\nAttached file: ${attachment.fileName} (${path ?? attachment.url})`;
  }
  return { type: "user", message: { role: "user", content: blocks as never }, parent_tool_use_id: null };
}

/** A tool call as a canonical item: what kind of step it is, and one line naming it. */
function describe(name: string, input: Record<string, unknown>, perry?: string): { type: ItemType; title: string; input?: string } {
  const text = (value: unknown) => typeof value === "string" ? value : undefined;
  if (COMMAND_TOOLS.has(name)) {
    const command = text(input.command) ?? name;
    return { type: "command_execution", title: command, input: `$ ${command}` };
  }
  if (FILE_TOOLS.has(name)) {
    const path = text(input.file_path) ?? text(input.notebook_path) ?? "file";
    return { type: "file_change", title: path, input: `${name === "Write" ? "write" : "edit"} ${path}` };
  }
  if (name.startsWith("mcp__")) {
    const [, server = "", ...rest] = name.split("__");
    const tool = rest.join("__");
    return { type: "mcp_tool_call", title: server === perry ? tool : `${server}.${tool}`, input: json(input) };
  }
  if (name === "WebSearch") return { type: "web_search", title: text(input.query) ?? "web search", input: text(input.query) };
  if (name === "WebFetch") return { type: "web_search", title: text(input.url) ?? "web fetch", input: json(input) };
  if (name === "Task" || name === "Agent") return { type: "dynamic_tool_call", title: `${name}: ${text(input.description) ?? "subagent"}`, input: json(input) };
  return { type: "dynamic_tool_call", title: name, input: json(input) };
}

/** A tool result's text, whatever shape it came in. */
function resultText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return json(content);
  return content.map((part: { type?: string; text?: string }) => part.type === "text" ? part.text ?? "" : `[${part.type ?? "content"}]`).join("\n");
}

/**
 * What Claude asks to do, as a request the runner answers: a command, a file
 * change, or anything else as a command-like line (a fetch, another MCP
 * server's tool), so the owner or the reviewer sees exactly what would run.
 */
function requestFor(tool: string, input: Record<string, unknown>, asked: { title?: string; decisionReason?: string; blockedPath?: string }, cwd: string): EngineRequest {
  const reason = [asked.title, asked.decisionReason, asked.blockedPath && `Path: ${asked.blockedPath}`].filter(Boolean).join(". ") || undefined;
  // Allow once or decline: Perry never lets Claude Code remember a yes.
  const choices = [
    { id: "allow", kind: "accept" as const, label: "Allow once" },
    { id: "deny", kind: "decline" as const, label: "Decline" },
  ];
  const raw = { tool, input, title: asked.title, decisionReason: asked.decisionReason, blockedPath: asked.blockedPath };
  if (FILE_TOOLS.has(tool)) {
    const path = String(input.file_path ?? input.notebook_path ?? "");
    const diff = tool === "Write" ? `+${String(input.content ?? "").split("\n").join("\n+")}`
      : tool === "Edit" ? `-${String(input.old_string ?? "").split("\n").join("\n-")}\n+${String(input.new_string ?? "").split("\n").join("\n+")}`
      : json(input.edits ?? input.new_source);
    return { type: "file_change_approval", detail: { reason, changes: [{ path: path ? resolve(cwd, path) : cwd, kind: tool === "Write" ? "add" : "update", diff }] }, options: choices, raw };
  }
  const described = describe(tool, input);
  const command = COMMAND_TOOLS.has(tool) ? described.title : `${described.title}${described.type === "mcp_tool_call" || described.type === "dynamic_tool_call" ? ` ${json(input) ?? ""}` : ""}`.slice(0, 2000);
  return { type: "exec_command_approval", detail: { command, cwd, reason: reason ?? (typeof input.description === "string" ? input.description : undefined) }, options: choices, raw };
}

/** One turn's tokens, from its result: the main loop's, so a subagent's are not in it. */
function usageOf(result: SDKResultMessage): TokenUsage {
  const usage = result.usage as { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number; output_tokens_details?: { thinking_tokens?: number } };
  const input = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  const output = usage.output_tokens ?? 0;
  return { inputTokens: input, cachedInputTokens: usage.cache_read_input_tokens ?? 0, outputTokens: output, reasoningTokens: usage.output_tokens_details?.thinking_tokens ?? 0, totalTokens: input + output };
}

const modelOf = (model: ModelInfo): EngineModel => ({
  id: model.value,
  name: model.displayName,
  isDefault: model.value === "default",
  ...(model.supportedEffortLevels?.length ? { efforts: [...model.supportedEffortLevels], defaultEffort: model.supportedEffortLevels.includes("high") ? "high" : undefined } : {}),
});

/** A message the owner sent while the turn runs, until Claude has read it or the turn ended without. */
type Steer = { uuid: string; taken: () => void; missed: (error: Error) => void };

/** A turn of a chat's live `claude`: what it has streamed and said, until its result. */
type Turn = {
  id: string;
  handle: TurnHandle;
  sink: TurnSink;
  /** It told the runner it started (onStarted). */
  begun: boolean;
  ending: boolean;
  interrupted: boolean;
  steers: Steer[];
  written: Map<string, string>;
  latest: string;
  messageId: string;
  replies: string[];
  failures: string[];
  results: number;
  compacted: boolean;
  /** Anything from Claude for this turn: until then, a live `claude` that ended can be started again. */
  heard: boolean;
  open: Map<string, EngineItem & { at: number }>;
  finished: Promise<void>;
  finish: () => void;
};

/**
 * A chat's `claude`, kept running between its turns so a turn after the first
 * starts without a new process (T3 Code does the same). What a process is
 * started with and cannot change (the instructions, model, effort, folder,
 * tools, and whether Claude Code's sandbox is on) is its `key`: a turn that
 * needs another starts afresh. Access is not in it, as the permission mode
 * switches in a running process (setPermissionMode) and canUseTool reads
 * `access` as it is now.
 */
type Live = {
  cursor: string;
  key: string;
  q: Query;
  inbox: Inbox;
  stderr: string;
  /** The chat's access now: the owner can change it while a turn runs (setAccess), or between turns. */
  access: Access;
  /** The access its instructions describe, from when it started, or the last note that told it of a change. */
  told: Access;
  /** It said it started (system init). */
  started: boolean;
  ended: boolean;
  /** Why its stream ended, when it failed. */
  error?: string;
  turn: Turn | null;
  lastUsed: number;
  idle?: ReturnType<typeof setTimeout>;
};

/** How long a chat's `claude` waits for its next message before it is closed (PERRY_CLAUDE_IDLE_MIN). */
const IDLE_MS = (Number(process.env.PERRY_CLAUDE_IDLE_MIN) || 10) * 60_000;
/** How many chats' `claude` stay running at once, each a few hundred MB (PERRY_CLAUDE_LIVE): the one idle longest goes first. */
const LIVE_MAX = Math.max(1, Math.floor(Number(process.env.PERRY_CLAUDE_LIVE)) || 4);

/**
 * Claude Code's permission mode for an access. Full is not bypassPermissions,
 * which could not be taken back mid-turn and never consults canUseTool: it
 * accepts edits, and canUseTool allows the rest without asking.
 */
const modeOf = (access: Access): PermissionMode => access === "supervised" ? "default" : "acceptEdits";

/** What the instructions say about approvals, for an access. */
const gateOf = (access: Access): string => access === "full" ? ""
  : access === "auto" ? "Each command you run is checked by a reviewer first: routine ones go ahead, and risky ones wait for the owner. If one is declined, say what you wanted to do and why, and do not work around it."
  : "Anything you do that changes something waits for the owner's approval. If one is declined, say what you wanted to do and why, and do not work around it.";

/**
 * A kept `claude`'s instructions still describe the access it started with,
 * so a turn after the owner changed it says what holds now, ahead of their
 * message, as skills are named.
 */
const accessNote = (access: Access): string => `The owner changed this chat's access, and this replaces what your instructions say about approvals: ${
  access === "full" ? "nothing you do waits for their approval now." : gateOf(access)}`;

export class ClaudeEngine implements Engine {
  readonly kind = "claude" as const;
  readonly label = "Claude Code";
  readonly capabilities: EngineCapabilities = {
    // A message sent meanwhile joins the running turn at its next step (priority "next").
    steer: "native",
    compaction: { type: "slash-command", command: "/compact" },
    approvals: true,
    // Claude Code's own sandbox runs on macOS, Linux and WSL. Native Windows has none, so it is left out:
    // there, supervised rests on approvals alone, and anything that is not read-only is asked.
    sandbox: { darwin: ACCESSES, linux: ACCESSES },
    images: true,
    modelSwitchInSession: true,
    // Each turn's main loop; a subagent's tokens are not counted.
    usage: "partial",
    quickTurns: true,
    // Each chat has a `claude` of its own.
    concurrentTurns: true,
  };

  /** Each chat's live `claude`, by session. */
  private live = new Map<string, Live>();
  /** Every `claude` this engine started and has not seen exit, for kill(). */
  private children = new Set<ChildProcess>();
  private models: EngineModel[] | null = null;
  private version: { path: string; value?: string; at: number } | null = null;
  private warned = false;

  constructor(private readonly warn: (line: string) => void = () => {}) {}

  /** Spawn `claude` the way the SDK would, but as a process group this engine can end. */
  private spawner(stderr: (text: string) => void) {
    return (options: SpawnOptions): SpawnedProcess => {
      const child = spawn(options.command, options.args, {
        cwd: options.cwd, env: options.env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32",
      });
      this.children.add(child);
      child.once("exit", () => this.children.delete(child));
      child.stderr.on("data", (chunk: Buffer) => stderr(String(chunk)));
      options.signal.addEventListener("abort", () => killTree(child), { once: true });
      return child;
    };
  }

  /** The options every `claude` Perry starts shares. */
  private base(binary: Binary, stderr: (text: string) => void): Options {
    return {
      ...(binary.sdkPath ? { pathToClaudeCodeExecutable: binary.sdkPath } : {}),
      // A background command would be ended with the turn's process, so commands run in the foreground.
      env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "perry", CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" },
      spawnClaudeCodeProcess: this.spawner(stderr),
    };
  }

  /** The models this account offers, from the last session; the seed list until one has run. */
  private listed(): EngineModel[] {
    if (!this.models) {
      try { this.models = JSON.parse(readFileSync(PATHS.claudeModels, "utf8")) as EngineModel[]; }
      catch { this.models = null; }
    }
    return this.models?.length ? this.models : SEED_MODELS;
  }

  private remember(models: ModelInfo[]) {
    if (!models.length) return;
    this.models = models.map(modelOf);
    try {
      mkdirSync(dirname(PATHS.claudeModels), { recursive: true });
      writeFileSync(PATHS.claudeModels, JSON.stringify(this.models), { encoding: "utf8", mode: 0o600 });
    } catch {}
  }

  async status(): Promise<EngineStatus> {
    const binary = findClaude();
    if (!binary) {
      return {
        kind: "claude", installed: false, signedIn: false, auth: {}, models: [],
        message: "Install Claude Code on this computer (https://code.claude.com), then run “claude auth login” there.",
      };
    }
    try {
      const path = binary.sdkPath ?? binary.prefix.at(-1) ?? binary.command;
      // One too old for Perry is asked again at every look, so its update is seen at once.
      const tooOld = updateOf({ kind: "claude", version: this.version?.value })?.need === "required";
      if (this.version?.path !== path || tooOld || Date.now() - this.version.at > VERSION_TTL_MS) {
        const { stdout } = await run(binary, ["--version"]);
        this.version = { path, value: stdout.trim().split(/\s+/)[0] || undefined, at: Date.now() };
      }
      const found = await account(binary);
      const signedIn = found.loggedIn === true;
      const subscription = found.authMethod === "claude.ai";
      return {
        kind: "claude",
        installed: true,
        version: this.version.value,
        update: updateCommand("claude", path),
        signedIn,
        // Signed out, it says "none"; that is no account.
        auth: signedIn ? {
          type: found.authMethod,
          label: subscription ? "Claude" : found.authMethod === "console" || found.authMethod === "api_key" ? "Anthropic API" : found.authMethod,
          email: found.email,
          plan: found.subscriptionType,
        } : {},
        models: signedIn ? this.listed() : [],
        message: !signedIn ? "Run “claude auth login” in a terminal on this computer to sign in."
          : subscription ? "Runs on your own Claude subscription through the official Claude Code; its use counts against your plan's limits."
          : "Runs through the official Claude Code, on the account it is signed in with.",
      };
    } catch (error) {
      return { kind: "claude", installed: true, version: this.version?.value, signedIn: false, auth: {}, models: [], error: message(error), update: updateCommand("claude", binary.sdkPath ?? binary.prefix.at(-1) ?? binary.command) };
    }
  }

  /**
   * Claude Code signs in only in its own terminal flow: the owner runs `claude
   * auth login` on the computer. Perry shows the command and waits for
   * `claude auth status` to say it worked.
   */
  async login(): Promise<LoginFlow> {
    const binary = findClaude();
    if (!binary) throw new Error("Claude Code isn't installed on this computer. Install it, then run “claude auth login” there");
    if ((await account(binary)).loggedIn) return { interaction: null, done: Promise.resolve(), cancel: () => {} };
    let cancelled = false;
    const done = (async () => {
      for (const until = Date.now() + LOGIN_WAIT_MS; !cancelled && Date.now() < until;) {
        await sleep(3_000);
        if ((await account(binary).catch(() => null))?.loggedIn) return;
      }
      throw new Error(cancelled ? "Signing in was cancelled" : "Claude Code was not signed in within ten minutes");
    })();
    return { interaction: { type: "terminal", command: "claude auth login" }, done, cancel: () => { cancelled = true; } };
  }

  /**
   * Signing Claude Code out would sign the owner out of it everywhere on this
   * computer, their own terminal included, so Perry leaves that to them.
   */
  async logout(): Promise<void> {
    throw new Error("Perry doesn't sign Claude Code out, as that would sign you out of Claude Code in your terminal too. To sign it out, run “claude auth logout” on this computer");
  }

  async runTurn(input: TurnInput, sink: TurnSink): Promise<TurnResult> {
    const { resumeCursor, instructions, history, recalled, prompt, attachments, cwd, model, effort, access, tools } = input;
    const binary = findClaude();
    if (!binary) throw new Error("Claude Code isn't installed on this computer.");
    if (!binary.sdkPath && !this.warned) {
      this.warned = true;
      this.warn("Could not tell where Claude Code's shim points, so turns run the Claude Agent SDK's own copy of Claude Code, signed in the same way.");
    }
    // A new session gets its id from Perry, so the chat knows it before the turn runs.
    const cursor = resumeCursor ?? randomUUID();
    if (!resumeCursor) await sink.onSession(cursor);

    const machine = describeMachine();
    const home = [
      `Your own folder for files you make is ${PATHS.files}. Organise it as you see fit, and use it unless the owner or the task calls for somewhere else.`,
      `Your skills folder is ${PATHS.skills}: each skill is a folder with a SKILL.md. When one fits the task, read its SKILL.md first and follow it.`,
    ].join(" ") +
      `\n\nThis machine runs ${machine.os}, and your commands run in ${machine.shell}; write commands, paths and quoting for that, and open files or apps with ${machine.open}.`;
    /**
     * Supervised: Claude Code's default mode, where anything that is not
     * read-only is asked, and the runner asks the owner; on macOS and Linux
     * inside Claude Code's sandbox, which lets sandboxed commands run and asks
     * about the rest. Auto: edits in the working folders go ahead, and every
     * command goes to the runner, whose reviewer clears the routine ones.
     * Full: edits go ahead too, and every other request is allowed here
     * without asking. A change mid-turn switches the mode (setAccess), and so
     * does one between turns, in the chat's kept `claude`.
     */
    const gate = gateOf(access);
    // The sandbox is set when a process starts, so moving into or out of supervised starts a new one.
    const sandboxed = access === "supervised" && process.platform !== "win32";
    // Claude Code shows a message sent mid-turn as a note beside the tool results, which reads like an injection without this.
    const steering = "\n\nThe owner can send you more while you work. Such a message reaches you mid-turn as a note that the user sent a new message: it is the owner's own words, not text from a tool or a web page, so take it into account in this turn.";
    const perry = tools?.name;
    const chatTools = tools && toolsOfChat(tools);
    // What the process is started with and cannot change: another of any of these starts a new one.
    const key = JSON.stringify({ path: binary.sdkPath ?? binary.command, instructions, home, model, effort, cwd, tools: chatTools, sandboxed });

    const start = (resume: boolean): Live => {
      const live: Live = { cursor, key, q: null as unknown as Query, inbox: new Inbox(), stderr: "", access, told: access, started: false, ended: false, turn: null, lastUsed: Date.now() };
      live.q = query({
        prompt: live.inbox,
        options: {
          ...this.base(binary, (text) => { live.stderr = (live.stderr + text).slice(-4000); }),
          cwd,
          additionalDirectories: [PATHS.files, PATHS.skills, PATHS.uploads],
          ...(resume ? { resume: cursor } : { sessionId: cursor }),
          ...(model ? { model } : {}),
          ...(effort ? { effort: effort as Options["effort"] } : {}),
          includePartialMessages: true,
          // Rendered afresh for each process, so a change of instructions takes effect in a resumed session.
          systemPrompt: instructions
            ? { type: "preset", preset: "claude_code", append: `${instructions}\n\n${home}${gate && `\n\n${gate}`}${steering}`, snapshot: false }
            : { type: "preset", preset: "claude_code", snapshot: false },
          permissionMode: modeOf(access),
          ...(sandboxed
            ? { sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: true, failIfUnavailable: false } }
            : {}),
          // Perry's own tools and web search run without asking, as they do on Codex.
          allowedTools: [...(perry ? [`mcp__${perry}`] : []), "WebSearch"],
          disallowedTools: DISALLOWED,
          ...(chatTools ? {
            mcpServers: {
              [chatTools.name]: process.env.PERRY_CLAUDE_MCP === "stdio"
                ? { type: "stdio", command: chatTools.stdio.command, args: chatTools.stdio.args, env: chatTools.stdio.env }
                : { type: "http", url: chatTools.http.url, headers: chatTools.http.headers },
            },
          } : {}),
          canUseTool: async (tool, toolInput, options): Promise<PermissionResult> => {
            const allow: PermissionResult = { behavior: "allow", updatedInput: toolInput };
            // The chat's access as it is now, not as the process started.
            if (live.access === "full") return allow;
            // Asked for by the turn that is running: its owner answers.
            const turn = live.turn;
            if (!turn) return { behavior: "deny", message: "No turn is running to ask for this." };
            const request = requestFor(tool, toolInput, options, cwd);
            // A turn stopped while its request waits takes it as declined.
            const stopped = new Promise<string>((done) => options.signal.addEventListener("abort", () => done("deny"), { once: true }));
            const answer = await Promise.race([turn.sink.onRequest(request), stopped]).catch(() => "deny");
            return answer === "allow" ? allow : { behavior: "deny", message: "The owner declined this." };
          },
        },
      });
      this.live.set(cursor, live);
      void this.listen(live, perry);
      return live;
    };

    const kept = this.live.get(cursor);
    let warm = kept && !kept.ended && !kept.turn && kept.key === key ? kept : undefined;
    if (warm) clearTimeout(warm.idle);
    // The access changed since its last turn: the kept process switches mode, as it would mid-turn.
    if (warm && modeOf(warm.access) !== modeOf(access)) {
      try { await warm.q.setPermissionMode(modeOf(access)); }
      catch { warm = undefined; }
    }
    if (warm) warm.access = access;
    if (kept && !warm) this.close(kept);
    if (!warm) this.makeRoom();
    const note = warm && instructions && warm.told !== access ? accessNote(access) : undefined;
    if (warm) warm.told = access;
    let live = warm ?? start(Boolean(resumeCursor));
    let turn = this.begin(live, sink, await userMessage(prompt, attachments, { recalled, history, note }));
    await turn.finished;
    // A kept `claude` that had ended by the time it was asked: the turn runs on a new one instead, whose instructions are the chat's now.
    if (warm && !turn.heard && live.ended && !turn.interrupted) {
      live = start(true);
      turn = this.begin(live, sink, await userMessage(prompt, attachments, { recalled, history }));
      await turn.finished;
    }
    // Stopped, the SDK ends the process's stream: the next turn starts a new one.
    if (turn.interrupted) this.close(live);
    else if (!live.ended) this.rest(live);

    const text = turn.replies.join("\n\n") || (turn.interrupted || turn.failures.length ? turn.latest : "");
    const compacted = turn.compacted ? { compacted: true } : {};
    if (!turn.results && !turn.interrupted && live.ended) {
      if (!live.started) throw new Error(`Claude Code did not start: ${live.error ?? "it ended"}${live.stderr.trim() ? `\n${live.stderr.trim().slice(-800)}` : ""}`);
      turn.failures.push(live.error ?? "Claude Code ended during the turn.");
    }
    if (turn.interrupted) return { state: "interrupted", cursor, text, images: [], ...compacted };
    if (turn.failures.length) return { state: "failed", cursor, text, images: [], ...compacted, error: turn.failures.join("; ").slice(0, 2000) };
    return { state: "completed", cursor, text, images: [], ...compacted };
  }

  /** Give a chat's `claude` the owner's message as a turn of its own. */
  private begin(live: Live, sink: TurnSink, message: SDKUserMessage): Turn {
    clearTimeout(live.idle);
    live.lastUsed = Date.now();
    let finish = () => {};
    const finished = new Promise<void>((done) => { finish = done; });
    const id = randomUUID();
    const turn: Turn = {
      id, handle: { cursor: live.cursor, turnId: id }, sink, begun: false, ending: false, interrupted: false, steers: [],
      written: new Map(), latest: "", messageId: "", replies: [], failures: [], results: 0, compacted: false, heard: false,
      open: new Map(), finished, finish: () => {},
    };
    turn.finish = () => {
      if (live.turn === turn) live.turn = null;
      turn.ending = true;
      // Unread, as when the turn was stopped first: the runner makes each the next turn.
      for (const steer of turn.steers.splice(0)) steer.missed(new Error("The turn ended before Claude Code read the message."));
      finish();
    };
    live.turn = turn;
    // A process already running takes the message at once; a new one says so when it starts (system init).
    if (live.started) this.started(turn);
    if (live.ended) turn.finish();
    else live.inbox.push(message);
    return turn;
  }

  private started(turn: Turn) {
    if (turn.begun) return;
    turn.begun = true;
    turn.sink.onStarted?.(turn.handle);
  }

  /** Read a chat's `claude` for as long as it runs, handing what it says to the turn it is on. */
  private async listen(live: Live, perry?: string) {
    try {
      for await (const event of live.q as AsyncIterable<SDKMessage>) {
        const turn = live.turn;
        if (event.type === "system" && event.subtype === "init") {
          if (!live.started) void live.q.supportedModels().then((models) => this.remember(models)).catch(() => {});
          live.started = true;
          if (turn) this.started(turn);
          continue;
        }
        if (!turn) continue;
        turn.heard = true;
        if (event.type === "system" && event.subtype === "compact_boundary") {
          turn.compacted = true;
          turn.sink.onEvent?.({ type: "item", phase: "completed", item: { id: event.uuid, type: "context_compaction", status: "completed", title: "context compaction", raw: event }, atMs: Date.now() });
        } else if (event.type === "stream_event") {
          if (event.parent_tool_use_id) continue;
          const stream = event.event as { type: string; index?: number; message?: { id?: string }; delta?: { type?: string; text?: string } };
          if (stream.type === "message_start") turn.messageId = stream.message?.id ?? randomUUID();
          if (stream.type === "content_block_delta" && stream.delta?.type === "text_delta" && stream.delta.text) {
            const itemId = `${turn.messageId}:${stream.index ?? 0}`;
            turn.latest = (turn.written.get(itemId) ?? "") + stream.delta.text;
            turn.written.set(itemId, turn.latest);
            turn.sink.onEvent?.({ type: "text", stream: "assistant", itemId, delta: stream.delta.text, text: turn.latest });
          }
        } else if (event.type === "assistant") {
          for (const block of event.message.content as Array<{ type: string; id?: string; name?: string; input?: Record<string, unknown> }>) {
            if (block.type !== "tool_use" || !block.id || !block.name) continue;
            const item = { id: block.id, ...describe(block.name, block.input ?? {}, perry), status: "running" as ItemStatus, raw: block, at: Date.now() };
            turn.open.set(block.id, item);
            const { at, ...shown } = item;
            turn.sink.onEvent?.({ type: "item", phase: "started", item: shown, atMs: at });
          }
        } else if (event.type === "user" && Array.isArray(event.message.content)) {
          const kinds = new Map(((event as { tool_result_meta?: Array<{ id: string; non_execution_kind?: string }> }).tool_result_meta ?? []).map((meta) => [meta.id, meta.non_execution_kind]));
          for (const block of event.message.content as Array<{ type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }>) {
            if (block.type !== "tool_result" || !block.tool_use_id) continue;
            const begun = turn.open.get(block.tool_use_id);
            if (!begun) continue;
            turn.open.delete(block.tool_use_id);
            const { at, ...item } = begun;
            const status: ItemStatus = kinds.get(block.tool_use_id) ? "declined" : block.is_error ? "failed" : "completed";
            turn.sink.onEvent?.({ type: "item", phase: "completed", item: { ...item, status, output: resultText(block.content), durationMs: Date.now() - at, raw: { use: item.raw, result: block } }, atMs: Date.now() });
          }
        } else if (event.type === "result") {
          turn.results++;
          // The result names every message of the owner's it read; a CLI too old to say is taken to have read them.
          const read = event.user_message_uuids ?? (event.user_message_uuid ? [event.user_message_uuid] : undefined);
          turn.steers = turn.steers.filter((steer) => {
            if (read ? !read.includes(steer.uuid) : turn.interrupted) return true;
            steer.taken();
            return false;
          });
          turn.sink.onEvent?.({ type: "usage", state: "partial", usage: usageOf(event) });
          if (event.subtype === "success" && !event.is_error) { if (event.result) turn.replies.push(event.result); }
          else if (!turn.interrupted) turn.failures.push(event.subtype === "success" ? event.result : event.errors.join("; ") || event.subtype);
          // A message the owner sent too late to join becomes a turn of its own in this process; it is read too.
          if (turn.interrupted || !(event.queued_turn_count && event.queued_turn_count > 0)) turn.finish();
        }
      }
    } catch (error) {
      // The SDK throws once an errored or interrupted turn has ended; what the results said stands.
      live.error = message(error);
    } finally {
      live.ended = true;
      clearTimeout(live.idle);
      if (this.live.get(live.cursor) === live) this.live.delete(live.cursor);
      live.turn?.finish();
    }
  }

  /** Between turns: closed once it has waited IDLE_MS for the chat's next message. */
  private rest(live: Live) {
    clearTimeout(live.idle);
    live.lastUsed = Date.now();
    live.idle = setTimeout(() => this.close(live), IDLE_MS);
    live.idle.unref?.();
  }

  private close(live: Live) {
    clearTimeout(live.idle);
    if (this.live.get(live.cursor) === live) this.live.delete(live.cursor);
    live.inbox.close();
    try { live.q.close(); } catch {}
  }

  /** Room for one more `claude`: the one idle longest is closed when LIVE_MAX run. */
  private makeRoom() {
    const idle = [...this.live.values()].filter((live) => !live.turn).sort((a, b) => a.lastUsed - b.lastUsed);
    while (this.live.size >= LIVE_MAX && idle.length) this.close(idle.shift()!);
  }

  /**
   * The message joins the running turn at its next step (priority "next",
   * which neither stops what runs nor waits for the turn to end), as the
   * owner's words. It settles once the turn's result says Claude read it, and
   * fails when the turn ended first or is ending, so the runner queues it as
   * the next turn instead.
   */
  async steer(handle: TurnHandle, steer: { prompt: string; attachments: EngineAttachment[] }): Promise<void> {
    const live = this.live.get(handle.cursor);
    const turn = live?.turn;
    if (!live || !turn || turn.id !== handle.turnId || turn.ending || live.inbox.closed) throw new Error("no active turn to steer");
    const uuid = randomUUID();
    const read = new Promise<void>((taken, missed) => turn.steers.push({ uuid, taken, missed }));
    live.inbox.push({ ...(await userMessage(steer.prompt, steer.attachments)), uuid, priority: "next" });
    await read;
  }

  /**
   * The chat's access changed mid-turn: Claude Code switches mode at its next
   * step, and canUseTool answers by the new one. The process keeps the new
   * mode for the chat's later turns.
   */
  async setAccess(handle: TurnHandle, access: Access): Promise<void> {
    const live = this.live.get(handle.cursor);
    if (!live || live.turn?.id !== handle.turnId || live.access === access) return;
    const before = modeOf(live.access);
    live.access = access;
    if (modeOf(access) !== before) await live.q.setPermissionMode(modeOf(access));
  }

  async interrupt(handle: TurnHandle): Promise<void> {
    const live = this.live.get(handle.cursor);
    const turn = live?.turn;
    if (!live || !turn || turn.id !== handle.turnId) return;
    turn.interrupted = true;
    await live.q.interrupt();
  }

  /**
   * One tool-less, sessionless Claude Code turn on a fast model, with none of
   * the owner's settings, MCP servers or hooks: it only answers.
   */
  async quickTurn(turn: QuickTurn): Promise<{ text: string; model?: string }> {
    const model = (turn.purpose === "review" ? process.env.PERRY_CLAUDE_REVIEW_MODEL : process.env.PERRY_CLAUDE_TITLE_MODEL) || QUICK_MODEL;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), turn.timeoutMs);
    try {
      const binary = findClaude();
      if (!binary) throw new Error("Claude Code isn't installed on this computer.");
      const q = query({
        prompt: turn.text,
        options: {
          ...this.base(binary, () => {}),
          abortController: abort,
          cwd: HOME,
          model,
          tools: [],
          strictMcpConfig: true,
          mcpServers: {},
          settingSources: [],
          permissionMode: "dontAsk",
          canUseTool: async () => ({ behavior: "deny", message: "This turn only answers." }),
          persistSession: false,
          thinking: { type: "disabled" },
          systemPrompt: turn.instructions,
          maxTurns: 3,
          ...(turn.outputSchema ? { outputFormat: { type: "json_schema", schema: turn.outputSchema as Record<string, unknown> } } : {}),
        },
      });
      for await (const event of q) {
        if (event.type !== "result") continue;
        if (event.subtype !== "success" || event.is_error) throw new Error(event.subtype === "success" ? event.result : event.errors.join("; ") || event.subtype);
        return { text: event.structured_output !== undefined ? JSON.stringify(event.structured_output) : event.result, model };
      }
      throw new Error("Claude Code gave no answer.");
    } catch (error) {
      const failed = abort.signal.aborted ? new Error(`Claude Code took longer than ${Math.round(turn.timeoutMs / 1000)}s.`) : error instanceof Error ? error : new Error(message(error));
      throw Object.assign(failed, { model });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The Claude plan's limits, from the data behind Claude Code's /usage: a
   * `claude` with no message and no session, asked once and ended, so none of
   * the plan is spent. The SDK marks the call experimental; should it change
   * or go, this fails, and Perry shows only the limits Claude Code hits.
   * Signed in with an API key, there are none.
   */
  async limits(): Promise<PlanLimits | null> {
    const binary = findClaude();
    if (!binary) return null;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), LIMITS_TIMEOUT_MS);
    const idle = new Inbox();
    const q = query({
      prompt: idle,
      options: {
        ...this.base(binary, () => {}), abortController: abort, cwd: HOME,
        tools: [], strictMcpConfig: true, mcpServers: {}, settingSources: [], persistSession: false,
      },
    });
    try {
      const usage = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
      if (!usage.rate_limits_available || !usage.rate_limits) return null;
      const limits = usage.rate_limits;
      const windows: PlanWindow[] = [];
      const add = (id: string, label: string, minutes: number | undefined, window?: { utilization: number | null; resets_at: string | null } | null) => {
        if (!window || window.utilization === null) return;
        const resetsAt = window.resets_at ? Date.parse(window.resets_at) : NaN;
        windows.push({ id, label, usedPercent: Math.max(0, Math.min(100, window.utilization)), ...(Number.isFinite(resetsAt) ? { resetsAt } : {}), ...(minutes ? { minutes } : {}) });
      };
      add("five_hour", "5-hour", 5 * 60, limits.five_hour);
      add("seven_day", "Weekly", 7 * 24 * 60, limits.seven_day);
      add("seven_day_opus", "Weekly (Opus)", 7 * 24 * 60, limits.seven_day_opus);
      add("seven_day_sonnet", "Weekly (Sonnet)", 7 * 24 * 60, limits.seven_day_sonnet);
      for (const model of limits.model_scoped ?? []) add(`model:${model.display_name}`, `Weekly (${model.display_name})`, 7 * 24 * 60, model);
      return { windows, ...(usage.subscription_type ? { plan: usage.subscription_type } : {}), at: Date.now() };
    } catch (error) {
      throw new Error(abort.signal.aborted ? `Claude Code took longer than ${LIMITS_TIMEOUT_MS / 1000}s to say its limits.` : message(error));
    } finally {
      clearTimeout(timer);
      idle.close();
      q.close();
    }
  }

  kill(): void {
    for (const child of this.children) killTree(child, "SIGKILL");
    this.children.clear();
  }

  /** The `claude` found on PATH or where its installer puts it. */
  where(): string | undefined {
    return findClaude()?.file;
  }

  /** Chats' idle sessions end with the old Claude Code, and its version is asked again. */
  reload(): void {
    for (const live of [...this.live.values()]) if (!live.turn) this.close(live);
    this.kill();
    this.version = null;
  }
}
