import { randomUUID } from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Writable, type Readable } from "node:stream";
import {
  client, ndJsonStream, PROTOCOL_VERSION,
  type ClientConnection, type ClientContext, type ContentBlock, type InitializeResponse, type McpServer, type PermissionOption,
  type PromptResponse, type RequestPermissionRequest, type RequestPermissionResponse, type SessionConfigOption,
  type SessionModeState, type SessionNotification, type SessionUpdate, type ToolCall,
} from "@agentclientprotocol/sdk";
import {
  type Access, type Engine, type EngineAttachment, type EngineCapabilities, type EngineItem, type EngineKind, type EngineModel,
  type EngineRequest, type EngineStatus, type ItemStatus, type ItemType, type LoginFlow, type PerryTools, type RequestOption,
  type TokenUsage, type TurnHandle, type TurnInput, type TurnResult, type TurnSink, type TurnState, toolsOfChat,
} from "../engine";
import { HOME, PATHS } from "../home";
import { describeMachine } from "../shell";
import { instructionsUpdate } from "../instructions";
import { killTree, spawnEngine } from "./process";

/**
 * Engines that speak the Agent Client Protocol (ACP, v1): a coding agent's own
 * CLI started as `<cli> acp` or the like, driven over stdio with the official
 * SDK (@agentclientprotocol/sdk). Grok Build and Antigravity each
 * extend AcpEngine with how to start their agent, what their modes are called,
 * and their own status, sign-in and sign-out, which ACP does not cover without
 * starting a session.
 *
 * One agent process per engine, started on first use and kept, since some
 * take many seconds to start (Antigravity). Its sessions stay loaded in it; a
 * chat's session is resumed from its id with session/resume, or session/load
 * where only that is offered (which replays the whole history as updates: they
 * are dropped, and the prompt waits until the replay goes quiet). A session the
 * agent lost is replaced by a new one (sink.onSession(new, old)).
 *
 * How a turn maps:
 *   - Perry's access is a session mode per agent (`modes`), and at Full access
 *     any permission the agent still asks for is answered "allow once" here.
 *   - The model and reasoning effort are session config options of category
 *     "model" and "thought_level", set before each prompt when they differ.
 *   - Instructions and the chat's history go into the session's first prompt,
 *     as ACP has no system prompt, ahead of the recalled memory and the message.
 *   - session/update becomes text, reasoning, items and usage; a tool's ACP
 *     `kind` says which item it is (execute is a command, edit/delete/move a
 *     file change, fetch a web search; read/search/think/other stay tool calls).
 *   - session/request_permission goes to the runner with the agent's own
 *     option ids; the answer is that exact id. "Allow always" is never chosen.
 *   - Stop is session/cancel. An agent that ignores it, or goes quiet in the
 *     middle of a reply, is ended (asked first, then made to) and resumed with
 *     its session on the next turn.
 *   - The client offers no file system or terminal of its own: agents use theirs.
 */

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const json = (value: unknown) => {
  try { return value === undefined || value === null ? undefined : JSON.stringify(value); }
  catch { return undefined; }
};
/** A promise that gives up after `ms`, saying what it waited for. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, fail) => { timer = setTimeout(() => fail(new Error(`${what} did not answer in ${Math.round(ms / 1000)}s.`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * JSON-RPC lines off the agent's stdout, each whole, none past `maxBytes`. A
 * session/load replays a whole session, and a long one can put tens of
 * megabytes on a line (T3 Code's client fell over at 16 MiB): such a line is
 * dropped and noted, rather than held without limit or allowed to end the
 * connection. Replays are dropped anyway, and a dropped answer times out.
 */
export function cappedLines(input: Readable, maxBytes: number, onDrop: (bytes: number) => void, onText: (line: string) => void = () => {}): ReadableStream<Uint8Array> {
  // A line that is not JSON (Antigravity prints its sign-in link on stdout) goes aside, not to the JSON-RPC parser.
  const pass = (controller: ReadableStreamDefaultController<Uint8Array>, line: Buffer) => {
    const first = line.find((byte) => byte !== 32 && byte !== 9 && byte !== 13 && byte !== 10);
    if (first === undefined) return;
    if (first === 123 || first === 91) controller.enqueue(new Uint8Array(line));
    else onText(line.toString("utf8").trim());
  };
  let parts: Buffer[] = [];
  let length = 0;
  let dropping = false;
  let dropped = 0;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      input.on("data", (chunk: Buffer) => {
        let start = 0;
        while (start < chunk.length) {
          const newline = chunk.indexOf(10, start);
          const end = newline === -1 ? chunk.length : newline + 1;
          const piece = chunk.subarray(start, end);
          start = end;
          if (dropping) dropped += piece.length;
          else if (length + piece.length > maxBytes) {
            dropping = true;
            dropped = length + piece.length;
            parts = [];
            length = 0;
          } else {
            parts.push(piece);
            length += piece.length;
          }
          if (newline === -1) continue;
          if (dropping) onDrop(dropped);
          else pass(controller, Buffer.concat(parts, length));
          parts = [];
          length = 0;
          dropping = false;
          dropped = 0;
        }
      });
      input.on("end", () => {
        if (!dropping && length) pass(controller, Buffer.concat(parts, length));
        try { controller.close(); } catch {}
      });
      input.on("error", (error) => { try { controller.error(error); } catch {} });
    },
  });
}

/**
 * What starts the agent's ACP server. `cwd` is where it starts (Antigravity
 * runs from its own folder). `env` adds to the runner's environment, or with
 * `fullEnv` is all of it, for an agent that must not see some of the owner's
 * variables (Antigravity).
 */
export type AcpLaunch = { command: string; args: string[]; env?: Record<string, string>; cwd?: string; fullEnv?: boolean };

/** How Perry's own tools (its MCP server) reach the agent's sessions. */
export type ToolsVia =
  /** Over HTTP when the agent says it takes HTTP servers, else through runner/mcp-bridge.ts. */
  | "auto"
  /** Always through the stdio bridge. */
  | "stdio"
  /** Not in session/new at all: the engine puts them where the agent reads them (Cursor's .cursor/mcp.json). */
  | "none";

export type AcpOptions = {
  kind: EngineKind;
  label: string;
  capabilities: EngineCapabilities;
  /** Authentication methods to try in this order before the first session; ones the agent does not offer are skipped. */
  authMethods: string[];
  /** Session modes for each access, most wanted first. None found leaves the agent's own. */
  modes: Record<Access, string[]>;
  toolsVia: ToolsVia;
  /** How long starting the agent and its initialize may take. */
  startupMs?: number;
  /** A reply that sends nothing for this long, and waits on nobody, is stopped. PERRY_ACP_IDLE_MS changes it. */
  idleMs?: number;
  /** After a cancel, how long before the agent is ended. */
  cancelGraceMs?: number;
  /** How quiet a session/load replay must go before the prompt, and the most to wait for it. */
  replayQuietMs?: number;
  replayMaxMs?: number;
  /** A session/update line past this is dropped (cappedLines). PERRY_ACP_MAX_LINE_MB changes it. */
  maxLineBytes?: number;
  /** `_meta` for session/new, load and resume: an agent's own switches (Grok Build's yoloMode). */
  sessionMeta?: Record<string, unknown>;
  /** How long `authenticate` may take: a sign-in in a browser takes minutes. */
  authMs?: number;
  /**
   * For an agent that may answer end_turn before it has said anything and
   * send the reply after (Antigravity): how long such a turn waits for it. 0
   * ends the turn at end_turn, as ACP says.
   */
  lateReplyMs?: number;
};

/** A session the agent has loaded, as this process knows it. */
type Session = {
  id: string;
  cwd: string;
  modes?: SessionModeState | null;
  config: SessionConfigOption[];
  /** The instructions a prompt of this session last gave it, in this process; unset, it has had none. */
  given?: string;
  /** A session/load is replaying it: its updates are dropped. The time of the last one. */
  replaying?: { lastAt: number };
  turn?: Turn;
};

/** One running turn and what it has produced. */
type Turn = {
  id: string;
  sink: TurnSink;
  access: Access;
  cwd: string;
  /** The reply: every message of the turn, in order. */
  reply: string;
  /** The message a chunk joins; a tool call between two ends the first. */
  replyBreak: boolean;
  thought: { id: string; text: string } | null;
  thoughts: number;
  tools: Map<string, ToolCall>;
  declined: Set<string>;
  plan?: string;
  prompts: Set<Promise<PromptResponse>>;
  lastActivity: number;
  /** Requests waiting on the owner; the idle watchdog waits with them. */
  asking: number;
  /** Aborted when the turn is stopped; answers every open permission request "cancelled". */
  stop: AbortController;
  interrupted: boolean;
  stalled: boolean;
};

type Connection = {
  child: ChildProcessWithoutNullStreams;
  connection: ClientConnection;
  agent: ClientContext;
  init: InitializeResponse;
  sessions: Map<string, Session>;
  closed: boolean;
  stderr: string;
};

/** ACP's permission option kinds as the runner's; "reject once" comes before "reject always", so declining picks it. */
const OPTION_KINDS: Record<PermissionOption["kind"], RequestOption["kind"]> = {
  allow_once: "accept", allow_always: "acceptForSession", reject_once: "decline", reject_always: "decline",
};
const OPTION_ORDER: PermissionOption["kind"][] = ["allow_once", "allow_always", "reject_once", "reject_always"];

/** Each ACP tool kind as a canonical item. `search` is the agent looking through files, not the web. */
const ITEM_OF_KIND: Record<string, ItemType> = {
  execute: "command_execution", edit: "file_change", delete: "file_change", move: "file_change", fetch: "web_search",
  read: "dynamic_tool_call", search: "dynamic_tool_call", think: "dynamic_tool_call", other: "dynamic_tool_call",
};
const STATUS: Record<string, ItemStatus> = { pending: "running", in_progress: "running", completed: "completed", failed: "failed" };

/**
 * A prompt's token use: ACP's `usage`, or the same counts in its `_meta`
 * (Grok Build puts them there). All of a prompt's model calls together, so
 * usage is "partial".
 */
export function usageOf(response?: PromptResponse): TokenUsage | undefined {
  const meta = response?._meta as Record<string, unknown> | null | undefined;
  const found = (response?.usage ?? (meta?.usage && typeof meta.usage === "object" ? meta.usage : meta)) as Record<string, unknown> | null | undefined;
  if (!found || typeof found.inputTokens !== "number" || typeof found.outputTokens !== "number") return undefined;
  const count = (...keys: string[]) => { for (const key of keys) if (typeof found[key] === "number") return found[key] as number; return 0; };
  const inputTokens = count("inputTokens");
  const outputTokens = count("outputTokens");
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: count("cachedReadTokens", "cachedInputTokens"),
    reasoningTokens: count("thoughtTokens", "reasoningTokens"),
    totalTokens: count("totalTokens") || inputTokens + outputTokens,
  };
}

/** The command of an execute tool call, whatever the agent calls the field. */
function commandOf(input: unknown): string | undefined {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return undefined;
  const fields = input as Record<string, unknown>;
  for (const key of ["command", "cmd", "commandLine", "command_line", "script"]) {
    const value = fields[key];
    if (typeof value === "string") return value;
    if (Array.isArray(value) && value.every((part) => typeof part === "string")) return value.join(" ");
  }
  return undefined;
}

/** The text of a tool call's content: its text blocks, and diffs as unified-style lines. */
function contentText(call: ToolCall): string | undefined {
  const parts = (call.content ?? []).map((content) => {
    if (content.type === "content") return content.content.type === "text" ? content.content.text : `[${content.content.type}]`;
    if (content.type === "diff") {
      const old = content.oldText ? content.oldText.split("\n").map((line) => `-${line}`).join("\n") + "\n" : "";
      return `--- ${content.path}\n+++ ${content.path}\n${old}${content.newText.split("\n").map((line) => `+${line}`).join("\n")}`;
    }
    return `[terminal ${content.terminalId}]`;
  }).filter(Boolean);
  return parts.length ? parts.join("\n") : undefined;
}

export abstract class AcpEngine implements Engine {
  readonly kind: EngineKind;
  readonly label: string;
  readonly capabilities: EngineCapabilities;
  protected readonly options: Required<AcpOptions>;
  private conn: Connection | null = null;
  private starting: Promise<Connection> | null = null;
  /**
   * Every agent process this engine started and has not seen exit. One still
   * starting, or being closed, is not `conn`, and must not outlive the runner
   * either.
   */
  private readonly children = new Set<ChildProcessWithoutNullStreams>();
  /** Models and efforts seen in a session's config options: what status() reports when the CLI cannot list them. */
  private learned: EngineModel[] | null = null;

  constructor(options: AcpOptions, protected readonly warn: (line: string) => void = () => {}) {
    this.kind = options.kind;
    this.label = options.label;
    this.capabilities = options.capabilities;
    this.options = {
      startupMs: 60_000,
      cancelGraceMs: 15_000,
      replayQuietMs: 500,
      replayMaxMs: 15_000,
      sessionMeta: {},
      authMs: options.startupMs ?? 60_000,
      lateReplyMs: 0,
      ...options,
      // The owner's settings win over the engine's own.
      idleMs: Number(process.env.PERRY_ACP_IDLE_MS) || options.idleMs || 5 * 60_000,
      maxLineBytes: Number(process.env.PERRY_ACP_MAX_LINE_MB) * 1048576 || options.maxLineBytes || 64 * 1048576,
    };
  }

  /** The agent's ACP server command. It may prepare what the agent needs first (a download, a config file). */
  protected abstract launch(): Promise<AcpLaunch> | AcpLaunch;
  abstract status(): Promise<EngineStatus>;
  abstract login(): Promise<LoginFlow>;
  abstract logout(): Promise<void>;

  /** Before a session starts in `cwd`: where an agent that ignores session/new's MCP servers reads them from. */
  protected async prepareSession(_cwd: string, _tools: PerryTools | undefined): Promise<void> {}

  /** The auth methods to try, in order; an engine whose way in the owner picks says so here. */
  protected authMethods(): string[] {
    return this.options.authMethods;
  }

  /** A line the agent printed on stdout that is not JSON-RPC, such as a sign-in link. */
  protected onText(_line: string): void {}

  /** Whether an error means the agent is not signed in. */
  protected isAuthError(error: unknown): boolean {
    return /auth|sign.?in|log.?in|unauthori[sz]ed|credential/i.test(message(error));
  }

  // --- The agent process ------------------------------------------------------

  /** The agent's process, started and initialized when first needed and again after it exits. */
  protected ensure(): Promise<Connection> {
    if (this.conn && !this.conn.closed) return Promise.resolve(this.conn);
    this.starting ??= this.start().finally(() => { this.starting = null; });
    return this.starting;
  }

  /** Whether the agent is running now, for a status that must not start it. */
  protected get running(): boolean { return Boolean(this.conn && !this.conn.closed); }

  private async start(): Promise<Connection> {
    const launch = await this.launch();
    const child = spawnEngine(launch.command, launch.args, launch.fullEnv ? launch.env as NodeJS.ProcessEnv : { ...process.env, ...launch.env }, launch.cwd);
    this.children.add(child);
    child.once("exit", () => this.children.delete(child));
    child.once("error", () => this.children.delete(child));
    const state = { closed: false, stderr: "" };
    child.stderr.on("data", (chunk: Buffer) => { state.stderr = (state.stderr + chunk).slice(-4000); });
    const lines = cappedLines(child.stdout, this.options.maxLineBytes, (bytes) =>
      this.warn(`${this.label} sent a message of ${Math.round(bytes / 1048576)} MB; it was skipped.`),
      (line) => { state.stderr = `${state.stderr}
${line}`.slice(-4000); this.onText(line); });
    const stream = ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, lines);
    const sessions = new Map<string, Session>();
    // Params pass through as sent: an agent a version ahead may add fields the SDK's schema does not know.
    const connection = client({ name: "perry" })
      .onNotification("session/update", (params: unknown) => params as SessionNotification, ({ params }) => this.onUpdate(sessions, params))
      .onRequest("session/request_permission", (params: unknown) => params as RequestPermissionRequest, ({ params }) => this.onPermission(sessions, params))
      .connect(stream);
    const conn: Connection = { child, connection, agent: connection.agent, init: { protocolVersion: PROTOCOL_VERSION }, sessions, closed: false, get stderr() { return state.stderr; } };
    const exited = new Promise<never>((_, fail) => {
      const end = (why: string) => {
        conn.closed = true;
        state.closed = true;
        connection.close(new Error(why));
        fail(new Error(why));
        if (this.conn === conn) this.conn = null;
      };
      child.on("error", (error) => end(`${this.label} could not start: ${message(error)}`));
      child.on("exit", (code, signal) => end(`${this.label} exited (${signal ?? `code ${code}`})${state.stderr.trim() ? `: ${state.stderr.trim().split("\n").slice(-3).join(" ")}` : ""}.`));
    });
    exited.catch(() => {});
    try {
      conn.init = await within(Promise.race([exited, conn.agent.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        // No file system or terminal of Perry's: the agent reads, writes and runs with its own.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "perry", title: "Perry", version: "0.1.0" },
      })]), this.options.startupMs, `${this.label}'s ACP server`);
      await this.authenticate(conn);
      this.conn = conn;
      return conn;
    } catch (error) {
      this.close(conn, false);
      throw error;
    }
  }

  /** Sign the connection in with the first of our methods the agent offers, as its CLI already is. */
  private async authenticate(conn: Connection) {
    const offered = new Set((conn.init.authMethods ?? []).map((method) => method.id));
    const methodId = this.authMethods().find((id) => offered.has(id));
    if (!methodId) return;
    await within(conn.agent.request("authenticate", { methodId }), this.options.authMs, `${this.label}'s sign-in`);
  }

  /**
   * End the agent: its stdin closes and it is asked to stop (SIGTERM on macOS
   * and Linux), so it can save its sessions; if still there a few seconds
   * later, its whole process tree is ended.
   */
  private close(conn: Connection, graceful = true) {
    if (conn.closed && !graceful) return;
    conn.closed = true;
    if (this.conn === conn) this.conn = null;
    try { conn.child.stdin.end(); } catch {}
    if (!graceful) { killTree(conn.child, "SIGKILL"); return; }
    if (process.platform !== "win32") killTree(conn.child, "SIGTERM");
    const force = setTimeout(() => { if (conn.child.exitCode === null) killTree(conn.child, "SIGKILL"); }, 3_000);
    force.unref?.();
  }

  /**
   * End every agent process now, each with its whole tree. The runner calls
   * this as it exits, so there is no waiting for the agent to save and stop:
   * a timer to end it later would never fire, and on Windows an agent that
   * ignores its stdin closing (Antigravity's server) would be left running.
   */
  kill(): void {
    if (this.conn) this.close(this.conn, false);
    for (const child of this.children) killTree(child, "SIGKILL");
    this.children.clear();
  }

  // --- Models learned from sessions -------------------------------------------

  private get learnedPath() { return join(HOME, "engines", `${this.kind}.json`); }

  /** Models a session offered, kept under Perry's home so a status after a restart still has them. */
  protected learnedModels(): EngineModel[] {
    if (this.learned) return this.learned;
    try { this.learned = (JSON.parse(readFileSync(this.learnedPath, "utf8")) as { models?: EngineModel[] }).models ?? []; }
    catch { this.learned = []; }
    return this.learned;
  }

  private learn(config: SessionConfigOption[]) {
    const model = this.option(config, "model");
    if (!model || model.type !== "select") return;
    const effort = this.option(config, "thought_level");
    const efforts = effort?.type === "select" ? this.values(effort) : [];
    const models = this.values(model).map((value): EngineModel => ({
      id: value.value,
      name: value.name,
      isDefault: value.value === model.currentValue,
      ...(efforts.length ? { efforts: efforts.map((item) => item.value), ...(effort?.type === "select" ? { defaultEffort: String(effort.currentValue) } : {}) } : {}),
    }));
    if (!models.length || json(models) === json(this.learned)) return;
    this.learned = models;
    try {
      mkdirSync(dirname(this.learnedPath), { recursive: true });
      writeFileSync(this.learnedPath, JSON.stringify({ models, updatedAt: Date.now() }, null, 2));
    } catch {}
  }

  // --- Sessions ---------------------------------------------------------------

  private option(config: SessionConfigOption[], category: "model" | "thought_level" | "mode"): SessionConfigOption | undefined {
    const byId: Record<string, RegExp> = { model: /^model$/i, thought_level: /effort|thought|reasoning|thinking/i, mode: /^mode$/i };
    return config.find((option) => option.category === category) ?? config.find((option) => !option.category && byId[category].test(option.id));
  }

  private values(option: SessionConfigOption): Array<{ value: string; name: string }> {
    if (option.type !== "select") return [];
    return option.options.flatMap((item) => "options" in item ? item.options : [item]).map((item) => ({ value: item.value, name: item.name }));
  }

  private get meta() {
    return Object.keys(this.options.sessionMeta).length ? { _meta: this.options.sessionMeta } : {};
  }

  private mcpServers(conn: Connection, perry?: PerryTools): McpServer[] {
    const tools = perry && toolsOfChat(perry);
    if (!tools || this.options.toolsVia === "none") return [];
    if (this.options.toolsVia === "auto" && conn.init.agentCapabilities?.mcpCapabilities?.http) {
      return [{ type: "http", name: tools.name, url: tools.http.url, headers: Object.entries(tools.http.headers).map(([name, value]) => ({ name, value })) }];
    }
    return [{ name: tools.name, command: tools.stdio.command, args: tools.stdio.args, env: Object.entries(tools.stdio.env).map(([name, value]) => ({ name, value })) }];
  }

  private track(conn: Connection, id: string, cwd: string, response: { modes?: SessionModeState | null; configOptions?: SessionConfigOption[] | null }): Session {
    const session: Session = { id, cwd, modes: response.modes, config: response.configOptions ?? [] };
    conn.sessions.set(id, session);
    this.learn(session.config);
    return session;
  }

  /**
   * The chat's session in this agent process: already loaded, resumed or
   * loaded by its id, or new. A session the agent no longer has is replaced
   * by a new one, which the chat keeps from then on.
   */
  private async session(conn: Connection, input: TurnInput, sink: TurnSink): Promise<Session> {
    const { resumeCursor: cursor, cwd, tools } = input;
    const loaded = cursor ? conn.sessions.get(cursor) : undefined;
    if (loaded) return loaded;
    await this.prepareSession(cwd, tools);
    const mcpServers = this.mcpServers(conn, tools);
    const capabilities = conn.init.agentCapabilities;
    if (cursor) {
      try {
        if (capabilities?.sessionCapabilities?.resume) {
          const resumed = await within(conn.agent.request("session/resume", { sessionId: cursor, cwd, mcpServers, ...this.meta }), this.options.startupMs, `${this.label}'s session/resume`);
          return this.track(conn, cursor, cwd, resumed);
        }
        if (capabilities?.loadSession) return await this.load(conn, cursor, cwd, mcpServers);
        throw new Error(`${this.label} cannot resume a session.`);
      } catch (error) {
        if (this.isAuthError(error) || conn.closed) throw error;
        this.warn(`${this.label} could not resume this chat's session (${message(error)}); starting a new one.`);
        const fresh = await this.newSession(conn, cwd, mcpServers);
        await sink.onSession(fresh.id, cursor);
        return fresh;
      }
    }
    const fresh = await this.newSession(conn, cwd, mcpServers);
    await sink.onSession(fresh.id);
    return fresh;
  }

  private async newSession(conn: Connection, cwd: string, mcpServers: McpServer[]): Promise<Session> {
    const created = await within(conn.agent.request("session/new", { cwd, mcpServers, ...this.meta }), this.options.startupMs, `${this.label}'s session/new`);
    return this.track(conn, created.sessionId, cwd, created);
  }

  /** session/load, whose replay of the session is dropped; the prompt goes once it has been quiet a moment. */
  private async load(conn: Connection, id: string, cwd: string, mcpServers: McpServer[]): Promise<Session> {
    const session: Session = { id, cwd, config: [], replaying: { lastAt: Date.now() } };
    conn.sessions.set(id, session);
    try {
      // A long session takes a while to replay; the answer comes after it.
      const loaded = await within(conn.agent.request("session/load", { sessionId: id, cwd, mcpServers, ...this.meta }), Math.max(this.options.startupMs, 120_000), `${this.label}'s session/load`);
      session.modes = loaded.modes;
      session.config = loaded.configOptions ?? [];
      this.learn(session.config);
      const began = Date.now();
      while (Date.now() - session.replaying!.lastAt < this.options.replayQuietMs && Date.now() - began < this.options.replayMaxMs) {
        await new Promise((done) => setTimeout(done, 100));
      }
      return session;
    } catch (error) {
      conn.sessions.delete(id);
      throw error;
    } finally {
      delete session.replaying;
    }
  }

  /** The mode for the chat's access, its model and effort: each set only when it differs from the session's. */
  private async configure(conn: Connection, session: Session, input: TurnInput) {
    const wanted = this.options.modes[input.access];
    const modeOption = this.option(session.config, "mode");
    if (session.modes?.availableModes.length) {
      const mode = wanted.find((id) => session.modes!.availableModes.some((item) => item.id === id));
      if (mode && mode !== session.modes.currentModeId) {
        await within(conn.agent.request("session/set_mode", { sessionId: session.id, modeId: mode }), 30_000, `${this.label}'s session/set_mode`);
        session.modes = { ...session.modes, currentModeId: mode };
      }
    } else if (modeOption?.type === "select") {
      const mode = wanted.find((id) => this.values(modeOption).some((item) => item.value === id));
      if (mode) await this.setOption(conn, session, modeOption, mode);
    }
    const model = this.option(session.config, "model");
    if (input.model && input.model !== DEFAULT_MODEL && model?.type === "select") {
      if (this.values(model).some((item) => item.value === input.model)) await this.setOption(conn, session, model, input.model);
      else this.warn(`${this.label} does not offer the model ${input.model}; keeping ${model.currentValue}.`);
    }
    // The model can change which efforts there are, so this is looked up after it.
    const effort = this.option(session.config, "thought_level");
    if (input.effort && effort?.type === "select" && this.values(effort).some((item) => item.value === input.effort)) {
      await this.setOption(conn, session, effort, input.effort);
    }
  }

  private async setOption(conn: Connection, session: Session, option: SessionConfigOption, value: string) {
    if (option.type !== "select" || option.currentValue === value) return;
    const answer = await within(conn.agent.request("session/set_config_option", { sessionId: session.id, configId: option.id, value }), 30_000, `${this.label}'s session/set_config_option`);
    session.config = answer?.configOptions ?? session.config.map((item) => item.id === option.id ? { ...item, currentValue: value } as SessionConfigOption : item);
    this.learn(session.config);
  }

  // --- The prompt -------------------------------------------------------------

  /** Perry's instructions and the machine it runs on. */
  private instructionsOf(input: TurnInput): string {
    const machine = describeMachine();
    const home = `Your own folder for files you make is ${PATHS.files}; use it unless the owner or the task calls for somewhere else. Your skills folder is ${PATHS.skills}.` +
      ` This machine runs ${machine.os}, and your commands run in ${machine.shell}; write commands, paths and quoting for that, and open files or apps with ${machine.open}.`;
    const access = input.access === "full" ? ""
      : input.access === "auto" ? "\n\nEach command you run is checked by a reviewer first: routine ones go ahead, and risky ones wait for the owner. If one is declined, say what you wanted to do and why, and do not work around it."
      : "\n\nThe owner approves your commands and edits before they run. If one is declined, say what you wanted to do and why, and do not work around it.";
    return `${input.instructions}\n\n## This computer\n\n${home}${access}`;
  }

  /**
   * Ahead of the message: the instructions and the chat so far in a session's
   * first prompt in this process, and after that, what changed in the
   * instructions since the session was last given them (instructions.ts).
   */
  private instructionsFor(session: Session, input: TurnInput): string | null {
    if (!input.instructions) return null;
    const current = this.instructionsOf(input);
    if (session.given === undefined) {
      const history = input.history ? `\n\nEarlier chat history (context, not a new user request):\n${input.history}` : "";
      return `<perry-instructions>\n${current}${history}\n</perry-instructions>`;
    }
    const update = instructionsUpdate(session.given, current);
    return update && `<perry-instructions>\n${update}\n</perry-instructions>`;
  }

  private async blocks(conn: Connection, session: Session, input: TurnInput, prompt: string, attachments: EngineAttachment[]): Promise<ContentBlock[]> {
    const blocks: ContentBlock[] = [];
    const instructions = this.instructionsFor(session, input);
    if (instructions) blocks.push({ type: "text", text: instructions });
    if (input.recalled) blocks.push({ type: "text", text: input.recalled });
    let text = prompt;
    const images = conn.init.agentCapabilities?.promptCapabilities?.image;
    const pictures: ContentBlock[] = [];
    for (const attachment of attachments) {
      const path = attachment.localPath;
      if (images && path && attachment.contentType?.startsWith("image/")) {
        try {
          pictures.push({ type: "image", mimeType: attachment.contentType, data: (await readFile(path)).toString("base64") });
          continue;
        } catch {}
      }
      text += `\nAttached file: ${attachment.fileName} (${path ?? attachment.url})`;
    }
    blocks.push({ type: "text", text }, ...pictures);
    return blocks;
  }

  async runTurn(input: TurnInput, sink: TurnSink): Promise<TurnResult> {
    const conn = await this.ensure().catch((error) => { throw this.explain(error); });
    let session: Session;
    try {
      session = await this.session(conn, input, sink);
      await this.configure(conn, session, input);
    } catch (error) {
      throw this.explain(error);
    }
    if (session.turn) throw new Error(`${this.label} is still working on this chat's last message.`);
    const turn: Turn = {
      id: randomUUID(), sink, access: input.access, cwd: input.cwd, reply: "", replyBreak: false, thought: null, thoughts: 0,
      tools: new Map(), declined: new Set(), prompts: new Set(), lastActivity: Date.now(), asking: 0,
      stop: new AbortController(), interrupted: false, stalled: false,
    };
    session.turn = turn;
    const blocks = await this.blocks(conn, session, input, input.prompt, input.attachments);
    const watchdog = setInterval(() => this.checkIdle(conn, session, turn), 5_000);
    let failure: string | undefined;
    let last: PromptResponse | undefined;
    try {
      this.send(conn, session, turn, blocks);
      if (input.instructions) session.given = this.instructionsOf(input);
      sink.onStarted?.({ cursor: session.id, turnId: turn.id });
      // A steer is a prompt of its own; the turn ends once every prompt in it has.
      while (turn.prompts.size) {
        const settled = await Promise.race([...turn.prompts].map((prompt) => prompt.then(
          (response) => ({ prompt, response, error: undefined }),
          (error: unknown) => ({ prompt, response: undefined, error }),
        )));
        turn.prompts.delete(settled.prompt);
        if (settled.error !== undefined) failure ??= message(settled.error);
        else last = settled.response;
        // A steer queued behind a stopped reply would start next: it is stopped too.
        if ((turn.interrupted || turn.stalled) && turn.prompts.size && !conn.closed) void conn.agent.notify("session/cancel", { sessionId: session.id }).catch(() => {});
      }
      if (this.options.lateReplyMs && last?.stopReason === "end_turn" && !turn.reply && !turn.tools.size) await this.lateReply(conn, turn);
    } finally {
      clearInterval(watchdog);
      this.endThought(turn);
      if (turn.plan) turn.sink.onEvent?.({ type: "item", phase: "completed", item: this.planItem(turn, true), atMs: Date.now() });
      if (session.turn === turn) delete session.turn;
    }
    const usage = usageOf(last);
    if (usage) {
      sink.onEvent?.({ type: "usage", state: "partial", usage });
    } else {
      sink.onEvent?.({ type: "usage", state: "unavailable" });
    }
    const result = (state: TurnState, error?: string): TurnResult => ({ state, cursor: session.id, text: turn.reply, images: [], ...(error ? { error } : {}) });
    if (turn.stalled) return result("failed", `${this.label} stopped responding, so Perry stopped it. Send another message to carry on; the chat's session is kept.`);
    if (turn.interrupted) return result("interrupted");
    if (failure && !last) return result("failed", this.explain(failure).message);
    switch (last?.stopReason) {
      case "cancelled": return result("interrupted");
      case "refusal": return result("failed", `${this.label} refused to answer this.`);
      case "max_tokens": return result("failed", `${this.label} ran out of room for its answer.`);
      case "max_turn_requests": return result("failed", `${this.label} reached its limit of steps for one message.`);
      default: return result("completed");
    }
  }

  /**
   * An empty end_turn from an agent that sends its reply after it: the turn
   * stays open until the reply has come and gone quiet for a few seconds, or
   * nothing has come in `lateReplyMs`. A stop or the watchdog still ends it.
   */
  private async lateReply(conn: Connection, turn: Turn) {
    const since = Date.now();
    turn.lastActivity = since;
    const quietMs = Math.min(5_000, this.options.lateReplyMs);
    while (!conn.closed && !turn.interrupted && !turn.stalled) {
      await new Promise((done) => setTimeout(done, 250));
      const heard = turn.lastActivity > since;
      if (Date.now() - turn.lastActivity >= (heard ? quietMs : this.options.lateReplyMs)) return;
    }
  }

  /** Send one prompt into the turn's session; the turn waits for it with the others. */
  private send(conn: Connection, session: Session, turn: Turn, prompt: ContentBlock[]) {
    const sent = conn.agent.request("session/prompt", { sessionId: session.id, prompt });
    turn.prompts.add(sent);
    sent.catch(() => {});
    turn.lastActivity = Date.now();
  }

  /** An error as the owner should read it: a sign-in problem says how to sign in. */
  protected explain(error: unknown): Error {
    const text = message(error);
    if (this.isAuthError(error)) return new Error(`${this.label} isn't signed in on this computer. Sign in from Settings → Engines. (${text})`);
    return error instanceof Error ? error : new Error(text);
  }

  /**
   * The idle watchdog: a reply that has sent nothing for `idleMs`, and waits on
   * nobody, is cancelled; if it still has not ended `cancelGraceMs` later, the
   * agent is ended and the session resumed on the next turn.
   */
  private checkIdle(conn: Connection, session: Session, turn: Turn) {
    // A reply the owner stopped is already being ended: it stays "stopped", not "stopped responding".
    if (turn.stalled || turn.interrupted || turn.asking > 0 || Date.now() - turn.lastActivity < this.options.idleMs) return;
    turn.stalled = true;
    this.warn(`${this.label} sent nothing for ${Math.round(this.options.idleMs / 1000)}s; stopping the reply.`);
    this.cancel(conn, session, turn);
  }

  /** session/cancel, and the agent ended if the reply has not stopped after the grace period. */
  private cancel(conn: Connection, session: Session, turn: Turn) {
    turn.stop.abort();
    void conn.agent.notify("session/cancel", { sessionId: session.id }).catch(() => {});
    const force = setTimeout(() => {
      if (session.turn !== turn || conn.closed) return;
      this.warn(`${this.label} did not stop; ending it. The chat's session resumes with the next message.`);
      this.close(conn);
    }, this.options.cancelGraceMs);
    force.unref?.();
  }

  async interrupt(handle: TurnHandle): Promise<void> {
    const conn = this.conn;
    const session = conn?.sessions.get(handle.cursor);
    const turn = session?.turn;
    if (!conn || !session || !turn || turn.id !== handle.turnId) return;
    turn.interrupted = true;
    this.cancel(conn, session, turn);
  }

  /** "concurrent-prompt": the message goes to the running session as a prompt of its own. */
  async steer(handle: TurnHandle, message: { prompt: string; attachments: EngineAttachment[] }): Promise<void> {
    if (this.capabilities.steer !== "concurrent-prompt") throw new Error(`${this.label} takes one message at a time`);
    const conn = this.conn;
    const session = conn?.sessions.get(handle.cursor);
    const turn = session?.turn;
    if (!conn || !session || !turn || turn.id !== handle.turnId || turn.interrupted || turn.stalled) throw new Error("no active turn to steer");
    this.send(conn, session, turn, await this.blocks(conn, session, { instructions: "", prompt: message.prompt, attachments: message.attachments, cwd: turn.cwd, access: turn.access }, message.prompt, message.attachments));
  }

  // --- What the agent sends ---------------------------------------------------

  private onUpdate(sessions: Map<string, Session>, notification: SessionNotification) {
    const session = sessions.get(notification.sessionId);
    if (!session) return;
    if (session.replaying) { session.replaying.lastAt = Date.now(); return; }
    const update = notification.update as SessionUpdate;
    // What the agent says about the session holds whether or not a turn runs.
    if (update.sessionUpdate === "current_mode_update" && session.modes) session.modes = { ...session.modes, currentModeId: update.currentModeId };
    if (update.sessionUpdate === "config_option_update") { session.config = update.configOptions; this.learn(session.config); }
    const turn = session.turn;
    if (!turn) return;
    turn.lastActivity = Date.now();
    const sink = turn.sink;
    const now = Date.now();
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        this.endThought(turn);
        if (update.content.type !== "text" || !update.content.text) return;
        const delta = `${turn.replyBreak && turn.reply ? "\n\n" : ""}${update.content.text}`;
        turn.replyBreak = false;
        turn.reply += delta;
        sink.onEvent?.({ type: "text", stream: "assistant", itemId: `${turn.id}:reply`, delta, text: turn.reply });
        return;
      }
      case "agent_thought_chunk": {
        if (update.content.type !== "text" || !update.content.text) return;
        turn.thought ??= { id: `${turn.id}:thought:${++turn.thoughts}`, text: "" };
        turn.thought.text += update.content.text;
        sink.onEvent?.({ type: "text", stream: "reasoning", itemId: turn.thought.id, delta: update.content.text, text: turn.thought.text });
        return;
      }
      case "tool_call":
      case "tool_call_update": {
        this.endThought(turn);
        turn.replyBreak = true;
        const { sessionUpdate: _, ...fields } = update;
        const before = turn.tools.get(update.toolCallId);
        const call = { ...before, ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== null)) } as ToolCall;
        call.title ??= before?.title ?? "tool";
        turn.tools.set(call.toolCallId, call);
        const item = this.toItem(turn, call);
        const phase = !before ? (item.status === "running" ? "started" : "completed") : item.status === "running" ? "updated" : "completed";
        sink.onEvent?.({ type: "item", phase, item, atMs: now });
        return;
      }
      case "plan": {
        const started = turn.plan === undefined;
        turn.plan = update.entries.map((entry) => `- [${entry.status === "completed" ? "x" : entry.status === "in_progress" ? "~" : " "}] ${entry.content}`).join("\n");
        sink.onEvent?.({ type: "item", phase: started ? "started" : "updated", item: this.planItem(turn), atMs: now });
        return;
      }
      case "usage_update":
        // How full the context window is, not tokens spent: PromptResponse.usage carries those.
        return;
      default:
        return;
    }
  }

  /** The agent's plan, one item for the turn, running until the turn ends. */
  private planItem(turn: Turn, done = false): EngineItem {
    return { id: `${turn.id}:plan`, type: "plan", status: done ? "completed" : "running", title: "plan", output: turn.plan, raw: { plan: turn.plan } };
  }

  /** A run of thought chunks is over: it becomes a reasoning item. */
  private endThought(turn: Turn) {
    const thought = turn.thought;
    if (!thought) return;
    turn.thought = null;
    turn.sink.onEvent?.({ type: "item", phase: "completed", item: { id: thought.id, type: "reasoning", status: "completed", title: "reasoning", output: thought.text, raw: { thought: thought.text } }, atMs: Date.now() });
  }

  /** Whether a tool call is to Perry's own MCP server, however the agent names it. */
  private perryTool(call: Pick<ToolCall, "title" | "name">): string | undefined {
    const name = `${call.name ?? ""} ${call.title ?? ""}`;
    return name.match(/\bassistant(?:__|[./:_-]|\s+)(\w+)/i)?.[1] ?? name.match(/mcp__assistant__(\w+)/i)?.[1];
  }

  private toItem(turn: Turn, call: ToolCall): EngineItem {
    const perry = this.perryTool(call);
    const type: ItemType = perry ? "mcp_tool_call" : ITEM_OF_KIND[call.kind ?? "other"] ?? "unknown";
    const status: ItemStatus = turn.declined.has(call.toolCallId) ? "declined" : STATUS[call.status ?? "pending"] ?? "running";
    const text = contentText(call);
    const base = { id: call.toolCallId, type, status, raw: call };
    if (type === "command_execution") {
      const command = commandOf(call.rawInput) ?? call.title;
      const cwd = (call.rawInput as { cwd?: string } | undefined)?.cwd ?? turn.cwd;
      return { ...base, title: command, input: `$ ${command}\ncwd: ${cwd}`, output: text ?? json(call.rawOutput) };
    }
    if (type === "file_change") {
      const paths = [...new Set([...(call.locations ?? []).map((location) => location.path), ...(call.content ?? []).flatMap((content) => content.type === "diff" ? [content.path] : [])])];
      return { ...base, title: paths.join(", ") || call.title, input: paths.map((path) => `${call.kind} ${path}`).join("\n") || json(call.rawInput), output: text };
    }
    return { ...base, title: perry ?? call.title, input: json(call.rawInput), output: text ?? json(call.rawOutput) };
  }

  /**
   * The agent asks before acting. At Full access, and for Perry's own tools,
   * it is allowed once here; otherwise the runner decides with the chat's
   * access, and the answer is the agent's own option id. A stopped turn
   * answers "cancelled", as ACP asks.
   */
  private async onPermission(sessions: Map<string, Session>, request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const session = sessions.get(request.sessionId);
    const turn = session?.turn;
    const options = [...request.options].sort((a, b) => OPTION_ORDER.indexOf(a.kind) - OPTION_ORDER.indexOf(b.kind));
    const pick = (kind: RequestOption["kind"]) => options.find((option) => OPTION_KINDS[option.kind] === kind)?.optionId;
    const selected = (optionId: string): RequestPermissionResponse => ({ outcome: { outcome: "selected", optionId } });
    const cancelled: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };
    const decline = () => { const id = pick("decline"); return id ? selected(id) : cancelled; };
    if (!session || !turn || turn.stop.signal.aborted) return turn ? cancelled : decline();
    turn.lastActivity = Date.now();
    const known = turn.tools.get(request.toolCall.toolCallId);
    const call = { ...known, ...Object.fromEntries(Object.entries(request.toolCall).filter(([, value]) => value !== undefined && value !== null)) } as ToolCall;
    const allowOnce = pick("accept");
    if ((turn.access === "full" || this.perryTool(call)) && allowOnce) return selected(allowOnce);
    const normalized = this.toRequest(turn, call, options);
    turn.asking += 1;
    try {
      const stopped = new Promise<null>((done) => turn.stop.signal.addEventListener("abort", () => done(null), { once: true }));
      const chosen = await Promise.race([turn.sink.onRequest(normalized), stopped]);
      if (chosen === null) return cancelled;
      if (OPTION_KINDS[options.find((option) => option.optionId === chosen)?.kind ?? "reject_once"] === "decline") turn.declined.add(call.toolCallId);
      return selected(chosen);
    } catch (error) {
      this.warn(`could not ask about ${call.title}: ${message(error)}`);
      turn.declined.add(call.toolCallId);
      return decline();
    } finally {
      turn.asking -= 1;
      turn.lastActivity = Date.now();
    }
  }

  private toRequest(turn: Turn, call: ToolCall, options: PermissionOption[]): EngineRequest {
    const choices: RequestOption[] = options.map((option) => ({ id: option.optionId, kind: OPTION_KINDS[option.kind], label: option.name }));
    const reason = typeof (call.rawInput as { description?: unknown } | undefined)?.description === "string" ? (call.rawInput as { description: string }).description : undefined;
    if (call.kind === "execute") {
      const cwd = (call.rawInput as { cwd?: string } | undefined)?.cwd;
      return { type: "exec_command_approval", detail: { command: commandOf(call.rawInput) ?? call.title, cwd: cwd ? resolve(turn.cwd, cwd) : turn.cwd, reason }, options: choices, raw: call };
    }
    if (call.kind === "edit" || call.kind === "delete" || call.kind === "move") {
      const diffs = (call.content ?? []).flatMap((content) => content.type === "diff" ? [content] : []);
      const paths = [...new Set([...(call.locations ?? []).map((location) => location.path), ...diffs.map((diff) => diff.path)])];
      const absolute = (path: string) => isAbsolute(path) ? path : resolve(turn.cwd, path);
      return {
        type: "file_change_approval",
        detail: {
          reason: reason ?? call.title,
          changes: paths.map((path) => {
            const diff = diffs.find((item) => item.path === path);
            return { path: absolute(path), kind: call.kind === "edit" ? (diff && !diff.oldText ? "add" : "update") : call.kind, diff: diff ? contentText({ ...call, content: [diff] }) : undefined };
          }),
        },
        options: choices,
        raw: call,
      };
    }
    // Reading, fetching and the rest: shown to the owner as what the agent says it will do.
    return { type: "exec_command_approval", detail: { command: `${call.kind ?? "tool"}: ${call.title}`, cwd: turn.cwd, reason }, options: choices, raw: call };
  }
}

/** The model a status reports for an agent whose models are known only from a session: its own default. */
export const DEFAULT_MODEL = "default";

/** An engine's models, else its default as the one choice, so a chat can still be moved to it. */
export function modelsOr(models: EngineModel[], label: string): EngineModel[] {
  return models.length ? models : [{ id: DEFAULT_MODEL, name: `${label} (its default model)`, isDefault: true }];
}

/**
 * Sign-in finished once `signedIn` says so: checked every few seconds, for up
 * to ten minutes, until cancelled.
 */
export function waitForSignIn(signedIn: () => Promise<boolean>, what: string): { done: Promise<void>; cancel(): void } {
  let cancelled = false;
  const done = (async () => {
    const until = Date.now() + 10 * 60_000;
    while (!cancelled && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      if (await signedIn().catch(() => false)) return;
    }
    throw new Error(cancelled ? "Sign-in was cancelled." : `${what} did not finish in ten minutes.`);
  })();
  return { done, cancel: () => { cancelled = true; } };
}
