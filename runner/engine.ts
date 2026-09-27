/**
 * Perry's engines: the coding agents that do a chat's work on the owner's
 * computer, each signed in with the owner's own subscription. Codex is the
 * first (runner/engines/codex.ts, over its app-server). The runner
 * (runner/index.ts) knows engines only through this file.
 *
 * Adding an engine
 *
 *   1. Implement `Engine` in runner/engines/<kind>.ts and register it in
 *      runner/engines/index.ts. The kind is already one of lib/engines.ts's
 *      ENGINES, which the server's schema accepts. An engine may speak its
 *      vendor's own protocol (Codex's app-server) or the Agent Client Protocol
 *      (@agentclientprotocol/sdk: `grok agent stdio`, `cursor-agent acp`,
 *      Antigravity's ACP server, Claude's claude-agent-acp); the runner cannot
 *      tell, so one engine can move from ACP to a vendor SDK without it
 *      noticing.
 *   2. Say what it can do in `capabilities`. The runner steers, compacts,
 *      reviews and names chats by them, and does without what is missing.
 *   3. Map Perry's access (supervised / auto / full) to its own modes in
 *      runTurn. Codex's mapping is in engines/codex.ts; in T3 Code's words,
 *      supervised is approval-required, auto is auto-accept-edits with every
 *      command reviewed, full is full-access. List the ones it can honour on
 *      each OS in `capabilities.sandbox`.
 *
 * The contract
 *
 *   status()    Side-effect free: never starts a session to see whether the
 *               engine works. Reads the CLI's version, account and models.
 *               The runner never runs two probes at once.
 *   login()     Starts signing in and says what the owner must do, as a
 *               LoginInteraction: a device code (Codex), a page to open, a
 *               command to run on this computer ("grok login"), or
 *               credentials to set up there. Never proxy a vendor's web
 *               sign-in, and never read or store its tokens.
 *   runTurn()   One turn. Events stream to the sink as they happen: text,
 *               items started, updated and completed (canonical ItemType,
 *               with the engine's own `raw` for traces), and token usage.
 *               Approval requests go to sink.onRequest, which answers with
 *               the id of one of the request's own options; reply with that
 *               exact id, never a label. The runner never chooses an
 *               "acceptForSession" option on the owner's behalf. The result
 *               says how the turn ended: completed, failed (with what it had
 *               written), interrupted or cancelled. A turn that cannot even
 *               start throws.
 *   Sessions    A chat resumes its engine session by an opaque cursor the
 *               engine made (Codex: its thread id), stored per chat with a
 *               version the engine owns. With no cursor the engine starts a
 *               session, seeds it with `history`, and reports the cursor with
 *               sink.onSession before the turn runs. A session the engine
 *               can no longer resume may be replaced by a new one, reported
 *               with sink.onSession(new, old).
 *   Tools      Perry's own tools are an MCP server. `tools` offers it over
 *               HTTP (url and bearer header) and as a stdio command
 *               (runner/mcp-bridge.ts), for engines that ignore HTTP MCP.
 *   kill()      Ends the engine's processes, the whole group. The runner's
 *               watchdog interrupts a turn that runs too long, then kills.
 */

import type { Access } from "../convex/lib/commands";
import type { EngineKind, LoginInteraction } from "../convex/lib/engines";

export type { Access, EngineKind, LoginInteraction };

/** How a message the owner sends while a turn runs reaches it. */
export type SteerMode =
  /** The engine adds it to the running turn (Codex's turn/steer). */
  | "native"
  /** A second prompt may be sent into the running session. */
  | "concurrent-prompt"
  /** The turn is cancelled and sent again with the message added. */
  | "cancel-and-resend"
  /** It waits, and becomes the next turn. */
  | "queue";

export type EngineCapabilities = {
  steer: SteerMode;
  /** How /compact works: the engine's own call, a command it takes as a prompt, or not at all. */
  compaction: { type: "native" } | { type: "slash-command"; command: string } | { type: "none" };
  /** It asks before acting (approval requests reach onRequest); without them, access is its own. */
  approvals: boolean;
  /**
   * The access levels it can honour inside an OS sandbox, by OS. An OS left
   * out has no sandbox (Claude Code on native Windows): there Supervised is
   * honoured by approvals alone, and Auto and Full as usual.
   */
  sandbox: Partial<Record<NodeJS.Platform, readonly Access[]>>;
  /** It takes images as input. */
  images: boolean;
  /** A session can change model between turns. */
  modelSwitchInSession: boolean;
  /** How much of its token use it reports. */
  usage: "complete" | "partial" | "unavailable";
  /** It can run quick, tool-less side turns (the reviewer, chat names). */
  quickTurns: boolean;
};

/** A model an engine offers, with the reasoning efforts it takes. */
export type EngineModel = { id: string; name: string; isDefault: boolean; efforts?: string[]; defaultEffort?: string };

/** What a probe found. Only account metadata: never a token. */
export type EngineStatus = {
  kind: EngineKind;
  installed: boolean;
  version?: string;
  signedIn: boolean;
  auth: { type?: string; label?: string; email?: string; plan?: string };
  models: EngineModel[];
  /** What the owner should do next, such as "Run `grok login` on this computer". */
  message?: string;
  error?: string;
};

export type LoginFlow = {
  /** What the owner does to finish; null when the engine was already signed in. */
  interaction: LoginInteraction | null;
  /** Settles once signing in finished or failed. */
  done: Promise<void>;
  cancel(): void;
};

/** Perry's MCP server (convex/mcp.ts), both ways an engine may take it. */
export type PerryTools = {
  name: string;
  http: { url: string; headers: Record<string, string> };
  stdio: { command: string; args: string[]; env: Record<string, string> };
};

/** A file the owner attached: on this disk, or at a URL. */
export type EngineAttachment = { url?: string; localPath?: string; fileName: string; contentType?: string };
export type GeneratedImage = { id: string; path?: string; base64?: string };

// --- What a turn does -------------------------------------------------------

export const ITEM_TYPES = [
  "command_execution", "file_change", "mcp_tool_call", "dynamic_tool_call", "web_search", "image_generation",
  "reasoning", "context_compaction", "plan", "error", "unknown",
] as const;
export type ItemType = (typeof ITEM_TYPES)[number];
export type ItemStatus = "running" | "completed" | "failed" | "declined";

/** One step of a turn, as the trace records it. `input` and `output` are whole; the trace cuts them. */
export type EngineItem = {
  id: string;
  type: ItemType;
  status: ItemStatus;
  /** One line naming it: the command, the files, the tool, the query. */
  title: string;
  input?: string;
  output?: string;
  /** How long it took, when the engine says. */
  durationMs?: number;
  /** The engine's own item, for traces. */
  raw: unknown;
};

/** One model response's tokens. Cached input is part of input, reasoning part of output. */
export type TokenUsage = { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningTokens: number; totalTokens: number };

export type TurnEvent =
  /** Text of one message as it is written: `text` is all of it so far. */
  | { type: "text"; stream: "assistant" | "reasoning"; itemId: string; delta: string; text: string }
  | { type: "item"; phase: "started" | "updated" | "completed"; item: EngineItem; atMs: number }
  | { type: "usage"; state: "complete" | "partial"; usage: TokenUsage }
  | { type: "usage"; state: "unavailable" };

export type RequestType = "exec_command_approval" | "file_change_approval" | "permission_approval" | "tool_user_input";
/** One answer to a request, by the engine's own id for it. */
export type RequestOption = { id: string; kind: "accept" | "acceptForSession" | "decline"; label: string };
export type FileChange = { path: string; kind?: string; diff?: string };

/** The engine asks before acting. Paths are absolute. */
export type EngineRequest = {
  type: RequestType;
  detail: {
    command?: string;
    cwd?: string;
    reason?: string;
    changes?: FileChange[];
    /** A command prefix the engine suggests allowing from now on. */
    proposedPrefix?: string[];
    /** The MCP server or tool asking, for a question from one. */
    server?: string;
    message?: string;
  };
  options: RequestOption[];
  raw: unknown;
};

/** The id of the option to answer with: allow once, or decline. Never "for the session". */
export function optionOf(request: EngineRequest, kind: "accept" | "decline"): string {
  const option = request.options.find((item) => item.kind === kind) ?? request.options.find((item) => item.kind === "decline");
  if (!option) throw new Error(`The ${request.type} request has no way to ${kind}.`);
  return option.id;
}

/** Where a running turn is, for interrupting and steering it. */
export type TurnHandle = { cursor: string; turnId: string };

export type TurnInput = {
  /** The chat's session; unset starts one. */
  resumeCursor?: string;
  instructions: string;
  /** The chat so far, for a session that has not seen it. */
  history?: string;
  /** Memory recalled for this turn: data, sent ahead of the prompt rather than as instructions. */
  recalled?: string;
  prompt: string;
  attachments: EngineAttachment[];
  cwd: string;
  /** One of the engine's models. Unset leaves the engine's own. */
  model?: string;
  /** A reasoning effort the model takes. Unset leaves the session's own. */
  effort?: string;
  access: Access;
  tools?: PerryTools;
};

export type TurnSink = {
  /**
   * A new session started for the chat; its next turns resume it. Called
   * before the turn runs. `replaces` is the chat's session it takes over from,
   * when that one could no longer be resumed (an ACP agent that lost it).
   */
  onSession(cursor: string, replaces?: string): Promise<unknown>;
  /** The turn is running, with what interrupt() and steer() need. */
  onStarted?(handle: TurnHandle): void;
  onEvent?(event: TurnEvent): void;
  /** Answer with the id of one of the request's options. */
  onRequest(request: EngineRequest): Promise<string>;
};

export type TurnState = "completed" | "failed" | "interrupted" | "cancelled";
export type TurnResult = {
  state: TurnState;
  cursor: string;
  /** The final reply, or what was written before the turn stopped or failed. */
  text: string;
  images: GeneratedImage[];
  /** The engine compacted the session's context during the turn. */
  compacted?: boolean;
  /** Why it failed. */
  error?: string;
};

/** A quick side turn: no tools, no approvals, only an answer. */
export type QuickTurn = {
  purpose: "review" | "title";
  instructions: string;
  text: string;
  /** JSON Schema the answer must match. */
  outputSchema?: object;
  timeoutMs: number;
};

export interface Engine {
  readonly kind: EngineKind;
  readonly label: string;
  readonly capabilities: EngineCapabilities;
  status(): Promise<EngineStatus>;
  login(): Promise<LoginFlow>;
  logout(): Promise<void>;
  runTurn(input: TurnInput, sink: TurnSink): Promise<TurnResult>;
  /** For `steer` "native" and "concurrent-prompt". */
  steer?(handle: TurnHandle, message: { prompt: string; attachments: EngineAttachment[] }): Promise<void>;
  /** Stop a turn; it ends as interrupted, keeping what it produced. */
  interrupt(handle: TurnHandle): Promise<void>;
  /** For `compaction` "native": summarise the session so it carries less. */
  compact?(cursor: string, cwd: string): Promise<void>;
  /** For `quickTurns`. Throws on failure or when out of time; the error may carry the `model` it tried. */
  quickTurn?(turn: QuickTurn): Promise<{ text: string; model?: string }>;
  /** End its processes, the whole group. Whatever runs fails; the next call starts it again. */
  kill(): void;
}
