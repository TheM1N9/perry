import { resolve } from "node:path";
import { ACCESSES } from "../../convex/lib/commands";
import {
  ASSISTANT_MCP, CodexAppServer, TurnFailed, WINDOWS_SANDBOX, sandboxMode, sandboxPolicy, userInput,
  type ItemEvent, type RpcMessage, type SandboxMode, type TokenUsage as CodexUsage, type TokenUsageEvent, type TurnItem,
} from "../codex";
import {
  optionOf, type Engine, type EngineAttachment, type EngineCapabilities, type EngineItem, type EngineRequest, type EngineStatus,
  type ItemStatus, type LoginFlow, type QuickTurn, type TokenUsage, type TurnHandle, type TurnInput, type TurnResult, type TurnSink,
} from "../engine";
import { HOME, PATHS } from "../home";
import { describeMachine } from "../shell";

/**
 * Codex, over its app-server (runner/codex.ts), signed in with the owner's
 * ChatGPT plan. Everything that is Codex's own lives here: how Perry's access
 * becomes Codex's sandbox and approval policy, what its approval requests and
 * items look like, its quick-turn models, and its sign-in by device code.
 */

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * Codex's tools, off for a quick turn: it answers from the text it is given
 * and has no reason to run, read, browse or delegate anything.
 */
const NO_TOOLS = Object.fromEntries([
  "shell_tool", "unified_exec", "apps", "plugins", "multi_agent", "image_generation", "computer_use", "browser_use",
].map((feature) => [`features.${feature}`, false]));

type ListedModel = { model: string; description?: string; hidden?: boolean; isDefault?: boolean; supportedReasoningEfforts?: Array<{ reasoningEffort: string }> };
type ModelChoice = { model?: string; effort?: string };

/** The owner's pick for chat names. PERRY_TITLE_MODEL picks another by id. */
const TITLE_MODEL = "gpt-6-luna";

/**
 * Which model a quick turn uses, from what the subscription offers. The
 * reviewer: PERRY_REVIEW_MODEL, else the first listed as fast, else the
 * default. Chat names: Luna, as the owner asked (PERRY_TITLE_MODEL), else the
 * first Luna listed, else a fast model, else the default.
 */
const QUICK_MODELS: Record<QuickTurn["purpose"], { wanted: () => string | undefined; pick: (all: ListedModel[], listed: ListedModel[], wanted?: string) => ListedModel | undefined }> = {
  review: {
    wanted: () => process.env.PERRY_REVIEW_MODEL,
    pick: (all, listed, wanted) => (wanted ? all.find((item) => item.model === wanted) : undefined)
      ?? listed.find((item) => /\bfast\b/i.test(item.description ?? ""))
      ?? listed.find((item) => item.isDefault)
      ?? listed[0],
  },
  title: {
    wanted: () => process.env.PERRY_TITLE_MODEL || TITLE_MODEL,
    pick: (all, listed, wanted) => all.find((item) => item.model === wanted)
      ?? listed.find((item) => /luna/i.test(item.model))
      ?? listed.find((item) => /\bfast\b/i.test(item.description ?? ""))
      ?? listed.find((item) => item.isDefault)
      ?? listed[0],
  },
};

/** Codex's item statuses: CommandExecutionStatus, PatchApplyStatus, McpToolCallStatus. */
const STATUS: Record<string, ItemStatus> = { inProgress: "running", completed: "completed", failed: "failed", declined: "declined" };
const json = (value: unknown) => {
  try { return value === undefined || value === null ? undefined : JSON.stringify(value); }
  catch { return undefined; }
};

/**
 * A Codex ThreadItem as a canonical item. Messages are the reply itself, and
 * the owner's own, so they are not items; an unknown kind is kept as unknown.
 */
export function toItem(item: TurnItem, phase: "started" | "completed"): EngineItem | null {
  const done: ItemStatus = phase === "started" ? "running" : "completed";
  const status = (value: unknown) => STATUS[String(value)] ?? done;
  const base = { id: item.id, raw: item, ...(typeof item.durationMs === "number" ? { durationMs: item.durationMs } : {}) };
  switch (item.type) {
    case "agentMessage":
    case "userMessage":
      return null;
    case "commandExecution":
      return {
        ...base,
        type: "command_execution",
        title: item.command,
        status: item.status === "completed" && typeof item.exitCode === "number" && item.exitCode !== 0 ? "failed" : status(item.status),
        input: `$ ${item.command}\ncwd: ${item.cwd}`,
        output: phase === "started" ? undefined
          : `${item.exitCode === null || item.exitCode === undefined ? "" : `exit ${item.exitCode}\n`}${item.aggregatedOutput ?? ""}`,
      };
    case "fileChange": {
      const changes: Array<{ path: string; kind: { type: string; move_path?: string | null }; diff: string }> = item.changes ?? [];
      return {
        ...base,
        type: "file_change",
        title: changes.map((change) => change.path).join(", ") || "file change",
        status: status(item.status),
        input: changes.map((change) => `${change.kind.move_path ? `move to ${change.kind.move_path}` : change.kind.type} ${change.path}`).join("\n"),
        output: changes.some((change) => change.diff) ? changes.map((change) => change.diff).join("\n") : undefined,
      };
    }
    case "mcpToolCall":
      return {
        ...base,
        type: "mcp_tool_call",
        title: item.server === ASSISTANT_MCP ? item.tool : `${item.server}.${item.tool}`,
        status: status(item.status),
        input: json(item.arguments),
        output: item.error?.message ? String(item.error.message) : json(item.result?.content),
      };
    case "dynamicToolCall":
      return {
        ...base,
        type: "dynamic_tool_call",
        title: item.namespace ? `${item.namespace}.${item.tool}` : item.tool,
        status: item.success === false ? "failed" : status(item.status),
        input: json(item.arguments),
        output: json(item.contentItems),
      };
    case "webSearch":
      return { ...base, type: "web_search", title: item.query || item.action?.url || "web search", status: done, input: item.query || undefined, output: json(item.action) };
    case "imageGeneration":
      // `result` is the image itself, in base64; the path is enough.
      return {
        ...base,
        type: "image_generation",
        title: "image generation",
        status: item.failure ? "failed" : done,
        input: item.revisedPrompt || undefined,
        output: item.failure ? json(item.failure) : item.savedPath || undefined,
      };
    case "reasoning":
      return { ...base, type: "reasoning", title: "reasoning", status: done, output: item.summary?.length ? item.summary.join("\n\n") : undefined };
    case "contextCompaction":
      return { ...base, type: "context_compaction", title: "context compaction", status: done };
    case "plan":
      return { ...base, type: "plan", title: "plan", status: done, output: typeof item.text === "string" ? item.text : undefined };
    default:
      return { ...base, type: "unknown", title: String(item.type ?? "item"), status: done };
  }
}

const usageOf = (last: CodexUsage): TokenUsage => ({
  inputTokens: last.inputTokens ?? 0,
  cachedInputTokens: last.cachedInputTokens ?? 0,
  outputTokens: last.outputTokens ?? 0,
  reasoningTokens: last.reasoningOutputTokens ?? 0,
  totalTokens: last.totalTokens ?? 0,
});

/** A thread started before any chat asked for it; its id, or null if it failed to start. */
type Spare = { app: CodexAppServer; id: Promise<string | null> };
/** How many spare threads are kept: one per distinct way of starting a chat (a web chat, a job's, a phone's). */
const SPARES = 2;

export class CodexEngine implements Engine {
  readonly kind = "codex" as const;
  readonly label = "Codex";
  readonly capabilities: EngineCapabilities = {
    steer: "native",
    compaction: { type: "native" },
    approvals: true,
    // Seatbelt on macOS, bubblewrap on Linux, a restricted token on Windows (runner/codex.ts).
    sandbox: { win32: ACCESSES, darwin: ACCESSES, linux: ACCESSES },
    images: true,
    modelSwitchInSession: true,
    usage: "complete",
    quickTurns: true,
  };

  private app: CodexAppServer | null = null;
  private starting: Promise<CodexAppServer> | null = null;
  private lastAttempt = 0;
  /** Running chat turns by thread, and where their approval requests go. */
  private turns = new Map<string, { sink: TurnSink; cwd: string }>();
  /** Threads quick turns started. Any request Codex makes from one is refused. */
  private quickThreads = new Set<string>();
  /** A quick-turn model per app-server and purpose, picked once. */
  private picks = new WeakMap<CodexAppServer, Map<string, Promise<ModelChoice>>>();
  /** Threads started ahead of a new chat's first message, by what they were started with (takeSpare). */
  private spares = new Map<string, Spare>();

  /** `warn` says what the owner should know, such as skills that could not load. */
  constructor(private readonly warn: (line: string) => void = () => {}) {}

  /** The app-server, started when first needed and again after it exits, at most every 30 seconds. */
  private ensure(): Promise<CodexAppServer> {
    if (this.app && !this.app.closed) return Promise.resolve(this.app);
    if (this.starting) return this.starting;
    if (Date.now() - this.lastAttempt < 30_000) return Promise.reject(new Error("Codex app-server is unavailable. Retrying shortly."));
    this.lastAttempt = Date.now();
    this.starting = (async () => {
      const app = new CodexAppServer();
      try {
        await app.start();
        // Without them Codex still works, just without the agent's own skills.
        await app.useSkills().catch((error) => this.warn(/unknown variant/.test(message(error))
          ? "Perry's skills are unavailable: this Codex is too old to load them. Update it: npm install -g @openai/codex"
          : `skills unavailable: ${message(error)}`));
        app.on("serverRequest", (request: RpcMessage) => {
          void this.answer(app, request).catch((error) => app.rejectRequest(request.id, message(error)));
        });
        app.on("closed", () => { if (this.app === app) this.app = null; });
        this.app = app;
        return app;
      } catch (error) {
        app.close();
        throw error;
      }
    })().finally(() => { this.starting = null; });
    return this.starting;
  }

  async status(): Promise<EngineStatus> {
    try {
      const app = await this.ensure();
      const account = await app.account();
      const signedIn = account.authMode === "chatgpt";
      return {
        kind: "codex",
        installed: true,
        version: app.version,
        signedIn,
        auth: { type: account.authMode, label: signedIn ? "ChatGPT" : account.authMode, email: account.email, plan: account.planType },
        models: signedIn ? await app.models().catch(() => []) : [],
      };
    } catch (error) {
      return { kind: "codex", installed: false, signedIn: false, auth: {}, models: [], error: message(error) };
    }
  }

  /** ChatGPT's device code: the owner opens a page, signs in and types the code. */
  async login(): Promise<LoginFlow> {
    const app = await this.ensure();
    if ((await app.account()).authMode === "chatgpt") return { interaction: null, done: Promise.resolve(), cancel: () => {} };
    const login = await app.request<{ type?: string; loginId?: string; verificationUrl?: string; userCode?: string }>("account/login/start", { type: "chatgptDeviceCode" });
    if (login.type !== "chatgptDeviceCode" || !login.loginId || !login.verificationUrl || !login.userCode) {
      throw new Error("Codex did not return a device code.");
    }
    const loginId = login.loginId;
    return {
      interaction: { type: "deviceCode", verificationUrl: login.verificationUrl, userCode: login.userCode },
      done: app.waitForLogin(loginId),
      cancel: () => void app.request("account/login/cancel", { loginId }).catch(() => {}),
    };
  }

  async logout(): Promise<void> {
    await (await this.ensure()).request("account/logout", {});
  }

  /**
   * A request from Codex, as one the runner answers: a command or file change
   * to approve, a permission grant, or a question from an MCP server. Perry's
   * own tools are answered here, and quick turns are never allowed to ask.
   */
  private async answer(app: CodexAppServer, request: RpcMessage) {
    const method = request.method ?? "";
    const params = request.params ?? {};
    if (this.quickThreads.has(params.threadId)) {
      // The reviewer and chat names only answer; they never get to act or ask.
      app.rejectRequest(request.id, "This turn only answers.");
      return;
    }
    if (method === "mcpServer/elicitation/request" && params.serverName === ASSISTANT_MCP) {
      // Our own tools. Consequential actions are gated in chat, as on the gateway path.
      app.respond(request.id, { action: "accept", content: {}, _meta: null });
      return;
    }
    const turn = this.turns.get(params.threadId);
    const decisions = [
      { id: "accept", kind: "accept" as const, label: "Allow once" },
      { id: "acceptForSession", kind: "acceptForSession" as const, label: "Allow for this session" },
      { id: "decline", kind: "decline" as const, label: "Decline" },
    ];
    let normalized: EngineRequest;
    let reply: (option: string) => void;
    if (method === "item/commandExecution/requestApproval") {
      normalized = {
        type: "exec_command_approval",
        detail: { command: params.command ?? "Codex command", cwd: params.cwd ?? undefined, reason: params.reason ?? undefined, proposedPrefix: params.proposedExecpolicyAmendment ?? undefined },
        options: decisions,
        raw: params,
      };
      reply = (option) => app.respond(request.id, { decision: option });
    } else if (method === "item/fileChange/requestApproval") {
      // Codex names only the item; its changes were kept from when it started.
      const cwd = turn?.cwd ?? process.cwd();
      normalized = {
        type: "file_change_approval",
        detail: {
          reason: params.reason ?? undefined,
          changes: app.changesFor(params.itemId).map((change) => ({ path: resolve(cwd, change.path), kind: change.kind?.type, diff: change.diff })),
        },
        options: decisions,
        raw: params,
      };
      reply = (option) => app.respond(request.id, { decision: option });
    } else if (method === "item/permissions/requestApproval") {
      normalized = {
        type: "permission_approval",
        detail: { cwd: params.cwd ?? undefined, reason: params.reason ?? undefined },
        options: [
          { id: "turn", kind: "accept", label: "Allow for this turn" },
          { id: "session", kind: "acceptForSession", label: "Allow for this session" },
          { id: "none", kind: "decline", label: "Decline" },
        ],
        raw: params,
      };
      // Declining grants nothing.
      reply = (option) => app.respond(request.id, option === "none"
        ? { permissions: {} }
        : { permissions: { ...(params.permissions?.network ? { network: params.permissions.network } : {}), ...(params.permissions?.fileSystem ? { fileSystem: params.permissions.fileSystem } : {}) }, scope: option });
    } else if (method === "mcpServer/elicitation/request") {
      normalized = {
        type: "tool_user_input",
        detail: { server: params.serverName, message: params.message },
        options: [{ id: "accept", kind: "accept", label: "Accept" }, { id: "decline", kind: "decline", label: "Decline" }],
        raw: params,
      };
      reply = (option) => option === "accept"
        ? app.respond(request.id, { action: "accept", content: {}, _meta: null })
        : app.rejectRequest(request.id, "Declined.");
    } else {
      app.rejectRequest(request.id, `Assistant does not support ${method}.`);
      return;
    }
    // A request from no running chat turn is declined: nobody would see it.
    reply(turn ? await turn.sink.onRequest(normalized) : optionOf(normalized, "decline"));
  }

  async runTurn(input: TurnInput, sink: TurnSink): Promise<TurnResult> {
    const { resumeCursor: threadId, instructions, history, recalled, prompt, cwd, model, effort, access, tools, attachments } = input;
    const app = await this.ensure();
    const broken = await app.reloadSkills(cwd).catch(() => []);
    const machine = describeMachine();
    // The owner's OS and shell, so commands, paths and "open it" requests fit this machine.
    const home = [
      `Your own folder for files you make is ${PATHS.files}. Organise it as you see fit, and use it unless the owner or the task calls for somewhere else.`,
      `Your skills folder is ${PATHS.skills}.`,
      ...(broken.length ? [`These skills failed to load, so they are not listed:\n${broken.map((line) => `- ${line}`).join("\n")}`] : []),
    ].join(" ") +
      `\n\nThis machine runs ${machine.os}, and your commands run in ${machine.shell}; write commands, paths and quoting for that, and open files or apps with ${machine.open}.`;
    /**
     * Supervised ("Ask"): the sandbox (PERRY_CODEX_SANDBOX, workspace-write by
     * default) and on-request approvals, which reach the owner through the
     * runner. Auto: no sandbox, and every command that is not plainly
     * read-only is asked about, which the runner has a reviewer answer
     * (approvals.ts). Full: no sandbox, and Codex never asks.
     */
    const full = access === "full";
    // Auto has no sandbox either: the gate is the reviewer, which Codex's "untrusted" policy sends
    // every command that is not plainly read-only to (approvals.ts, review.ts). A sandbox would
    // only make commands fail quietly, since Codex does not reliably ask to leave it.
    const auto = access === "auto";
    const sandboxed = full ? "" : auto
      ? "\n\nEach command you run is checked by a reviewer first: routine ones go ahead, and risky ones wait for the owner. If one is declined, say what you wanted to do and why, and do not work around it."
      // Sandboxed, Codex tends to give up when a command is blocked (no network, a folder outside
      // the workspace) rather than ask; the owner's access setting is what should decide, so it asks.
      : "\n\nYour commands run in a sandbox: no network, and writes only in the working folder and your own folders. " +
        "A command that fails with a network, connection or permission error was blocked by the sandbox. When the task needs it, " +
        "do not report the failure or work around it: run the same command again with sandbox_permissions \"require_escalated\" " +
        "and a one-line justification, and the owner is asked. Ask this way only for what the task needs.";
    const fullInstructions = history
      ? `${instructions}\n\n${home}${sandboxed}\n\nEarlier chat history (context, not a new user request):\n${history}`
      : `${instructions}\n\n${home}${sandboxed}`;
    const policy = full ? "never" : auto ? "untrusted" : "on-request";
    const sandbox: SandboxMode = full || auto ? "danger-full-access" : sandboxMode();
    // Perry's own tools (convex/mcp.ts): memory, connected accounts, the web, jobs, tasks and the rest. Codex takes them over HTTP.
    const config = {
      ...(tools ? {
        [`mcp_servers.${ASSISTANT_MCP}`]: {
          url: tools.http.url,
          http_headers: tools.http.headers,
          default_tools_approval_mode: "approve",
          // Long enough for a browser step to wait for the owner's yes (approvals.APPROVAL_TTL_MS).
          tool_timeout_sec: 660,
        },
      } : {}),
      ...WINDOWS_SANDBOX,
      // The Codex desktop app's own browser works only inside that app. Where it is installed, Codex
      // reaches for it instead of Perry's `browser`, finds no browser, and tells the owner there is none.
      // Naming a plugin that is not installed does nothing. Its computer use for other apps stays.
      "plugins.browser@openai-bundled.enabled": false,
      "plugins.unified-computer-use@openai-bundled.enabled": false,
    };
    const start = { cwd, approvalPolicy: policy, sandbox, config, developerInstructions: fullInstructions, serviceName: "perry" };
    const spare = threadId ? null : await this.takeSpare(app, start);
    const thread = threadId
      ? await app.request<{ thread?: { id?: string } }>("thread/resume", { threadId, cwd, approvalPolicy: policy, sandbox, config, developerInstructions: fullInstructions }, 30_000)
      : spare ? { thread: { id: spare } } : await app.request<{ thread?: { id?: string } }>("thread/start", start, 30_000);
    const id = thread.thread?.id;
    if (!id) throw new Error("Codex did not return a thread ID.");
    if (!threadId) await sink.onSession(id);
    // The next new chat is most likely started the same way (the same instructions, access and folder): have its thread ready.
    if (!threadId && !history) this.keepSpare(app, start);
    const turnInput = userInput(prompt, attachments, recalled);
    // Deltas can arrive before turn/start answers, so match them by thread.
    const written = new Map<string, string>();
    let latest = "";
    const onDelta = (event: { threadId?: string; itemId?: string; delta?: string }) => {
      if (event.threadId !== id || !event.itemId || !event.delta) return;
      latest = (written.get(event.itemId) ?? "") + event.delta;
      written.set(event.itemId, latest);
      sink.onEvent?.({ type: "text", stream: "assistant", itemId: event.itemId, delta: event.delta, text: latest });
    };
    // Items and usage carry the turn's id, which is known only once turn/start
    // answers; anything of this thread that comes earlier waits until then.
    let turnId: string | undefined;
    const early: Array<() => void> = [];
    const ofTurn = <T extends { threadId?: string; turnId?: string }>(handle: (event: T) => void) => {
      const listener = (event: T) => {
        if (event?.threadId !== id) return;
        if (!turnId) early.push(() => listener(event));
        else if (event.turnId === turnId) handle(event);
      };
      return listener;
    };
    const item = (phase: "started" | "completed") => ofTurn((event: ItemEvent) => {
      const normalized = toItem(event.item, phase);
      const atMs = (phase === "started" ? event.startedAtMs : event.completedAtMs) ?? Date.now();
      if (normalized) sink.onEvent?.({ type: "item", phase, item: normalized, atMs });
    });
    const onItemStarted = item("started");
    const onItemCompleted = item("completed");
    const onTokens = ofTurn((event: TokenUsageEvent) => {
      if (event.tokenUsage?.last) sink.onEvent?.({ type: "usage", state: "complete", usage: usageOf(event.tokenUsage.last), ...(event.tokenUsage.modelContextWindow ? { contextWindow: event.tokenUsage.modelContextWindow } : {}) });
    });
    app.on("item/agentMessage/delta", onDelta);
    app.on("item/started", onItemStarted);
    app.on("item/completed", onItemCompleted);
    app.on("thread/tokenUsage/updated", onTokens);
    this.turns.set(id, { sink, cwd });
    try {
      // turn/start's overrides hold "for this turn and subsequent turns", and
      // thread/resume of a thread this app-server still has loaded just rejoins
      // it, so every turn states its access and effort: a chat switched mid-way
      // takes the new ones, and nothing lingers from an earlier turn.
      const started = await app.request<{ turn?: { id?: string } }>("turn/start", {
        threadId: id,
        input: turnInput,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        cwd,
        approvalPolicy: policy,
        sandboxPolicy: sandboxPolicy(sandbox, [cwd, PATHS.files, PATHS.skills]),
      }, 30_000);
      if (!started.turn?.id) throw new Error("Codex did not start a turn.");
      turnId = started.turn.id;
      for (const replay of early.splice(0)) replay();
      sink.onStarted?.({ cursor: id, turnId });
      try {
        // No timeout of its own: the runner's watchdog keeps the time.
        const { text, images, interrupted, compacted } = await app.waitForTurn(turnId, 0);
        // A stopped turn may not have finished its message; the streamed text is the best record of it.
        return { state: interrupted ? "interrupted" : "completed", cursor: id, text: text || (interrupted ? latest : ""), images, ...(compacted ? { compacted } : {}) };
      } catch (error) {
        if (!(error instanceof TurnFailed)) throw error;
        return { state: "failed", cursor: id, text: error.partial.text || latest, images: error.partial.images, ...(error.partial.compacted ? { compacted: true } : {}), error: error.message };
      }
    } finally {
      this.turns.delete(id);
      app.off("item/agentMessage/delta", onDelta);
      app.off("item/started", onItemStarted);
      app.off("item/completed", onItemCompleted);
      app.off("thread/tokenUsage/updated", onTokens);
    }
  }

  /**
   * Codex reads the message at its next step and carries on in the same turn.
   * Fails with "no active turn to steer" once the turn has ended, and when the
   * turn is no longer the active one.
   */
  async steer(handle: TurnHandle, steer: { prompt: string; attachments: EngineAttachment[] }): Promise<void> {
    await (await this.ensure()).steer(handle.cursor, handle.turnId, steer.prompt, steer.attachments);
  }

  async interrupt(handle: TurnHandle): Promise<void> {
    if (this.app && !this.app.closed) await this.app.interrupt(handle.cursor, handle.turnId);
  }

  async compact(cursor: string, cwd: string): Promise<void> {
    await (await this.ensure()).compact(cursor, cwd);
  }

  /** One ephemeral, read-only Codex turn with no tools, on a model picked for its purpose. */
  async quickTurn(turn: QuickTurn): Promise<{ text: string; model?: string }> {
    const started = Date.now();
    const left = () => Math.max(1, turn.timeoutMs - (Date.now() - started));
    const app = await this.ensure();
    const choice = await this.quickModel(app, turn.purpose);
    let running: TurnHandle | undefined;
    try {
      const thread = await app.request<{ thread?: { id?: string } }>("thread/start", {
        cwd: HOME,
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: true,
        baseInstructions: turn.instructions,
        config: { ...WINDOWS_SANDBOX, ...NO_TOOLS },
        serviceName: "perry",
      }, left());
      const threadId = thread.thread?.id;
      if (!threadId) throw new Error("Codex did not return a thread ID.");
      this.quickThreads.add(threadId);
      const begun = await app.request<{ turn?: { id?: string } }>("turn/start", {
        threadId,
        input: [{ type: "text", text: turn.text }],
        ...(choice.model ? { model: choice.model } : {}),
        ...(choice.effort ? { effort: choice.effort } : {}),
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        ...(turn.outputSchema ? { outputSchema: turn.outputSchema } : {}),
      }, left());
      if (!begun.turn?.id) throw new Error("Codex did not start the turn.");
      running = { cursor: threadId, turnId: begun.turn.id };
      return { text: (await app.waitForTurn(begun.turn.id, left())).text, model: choice.model };
    } catch (error) {
      // Stop a turn that ran out of time, so it does not keep using the subscription.
      if (running) void app.interrupt(running.cursor, running.turnId).catch(() => {});
      throw Object.assign(error instanceof Error ? error : new Error(message(error)), { model: choice.model });
    }
  }

  /** A model from what the subscription offers, picked once per app-server and purpose, at low effort where it has it. */
  private quickModel(app: CodexAppServer, purpose: QuickTurn["purpose"]): Promise<ModelChoice> {
    let picks = this.picks.get(app);
    if (!picks) this.picks.set(app, picks = new Map());
    let choice = picks.get(purpose);
    if (!choice) {
      const rule = QUICK_MODELS[purpose];
      const wanted = rule.wanted();
      choice = (async () => {
        const { data = [] } = await app.request<{ data?: ListedModel[] }>("model/list", { limit: 100 });
        const model = rule.pick(data, data.filter((item) => !item.hidden), wanted);
        const effort = model?.supportedReasoningEfforts?.some((option) => option.reasoningEffort === "low") ? "low" : undefined;
        return { model: model?.model ?? wanted, effort };
      })();
      choice.catch(() => picks.delete(purpose));
      picks.set(purpose, choice);
    }
    return choice;
  }

  /**
   * A new Codex thread spends two seconds or more getting ready (its MCP
   * servers, its tools, its environment) before it takes the first message,
   * and does that in the background once started. So a thread is started
   * ahead of the next new chat, with what the last new chat was started with,
   * and taken when a new chat's first message matches it exactly. A thread
   * keeps the instructions it started with (convex/brain.ts prepareTurn keeps
   * what changes per turn out of them), and one with no turns is never saved,
   * so a spare that is not taken leaves nothing behind.
   */
  private async takeSpare(app: CodexAppServer, start: object): Promise<string | null> {
    const key = JSON.stringify(start);
    const spare = this.spares.get(key);
    if (!spare) return null;
    this.spares.delete(key);
    if (spare.app !== app || app.closed) return null;
    return await spare.id;
  }

  private keepSpare(app: CodexAppServer, start: object) {
    const key = JSON.stringify(start);
    if (this.spares.has(key)) return;
    for (const [old, spare] of [...this.spares].slice(0, Math.max(0, this.spares.size - SPARES + 1))) {
      this.spares.delete(old);
      if (spare.app === app && !app.closed) void spare.id.then((id) => id && app.request("thread/unsubscribe", { threadId: id })).catch(() => {});
    }
    const id = app.request<{ thread?: { id?: string } }>("thread/start", start, 30_000).then((thread) => thread.thread?.id ?? null, () => null);
    this.spares.set(key, { app, id });
  }

  kill(): void {
    this.app?.close("SIGKILL");
  }
}
