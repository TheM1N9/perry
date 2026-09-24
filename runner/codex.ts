import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { isAbsolute, relative } from "node:path";
import { createInterface } from "node:readline";
import { PATHS } from "./home";
import { describeMachine } from "./shell";

/**
 * Codex's "elevated" Windows sandbox runs a setup check over every file its
 * runtimes need, and that check cannot open paths longer than 260 characters
 * even with long paths enabled; one deep path in Codex's own computer-use
 * runtime then fails every sandboxed command with "CreateProcess: Rejected -
 * helper_unknown_error: setup refresh had errors". The unelevated sandbox
 * (a restricted token) has no such check, so the runner's threads use it.
 * PERRY_CODEX_WINDOWS_SANDBOX=elevated restores Codex's own choice.
 */
export const WINDOWS_SANDBOX = process.platform === "win32"
  ? { "windows.sandbox": process.env.PERRY_CODEX_WINDOWS_SANDBOX ?? "unelevated" }
  : {};

/**
 * How Codex fences in the commands it runs. workspace-write lets it write in
 * the workspace, Perry's files folder and the temp folder, keeps the network
 * off, and asks the owner for anything else. Codex enforces it with Seatbelt
 * (sandbox-exec) on macOS, with its bundled bubblewrap on Linux (Landlock is
 * its legacy fallback), and with a restricted token on Windows.
 *
 * Where that cannot work, such as a container without user namespaces,
 * PERRY_CODEX_SANDBOX picks another mode on any OS: read-only, or
 * danger-full-access for a machine that is already isolated, where Codex then
 * asks for almost nothing.
 *
 * That is the mode of a Supervised chat. A chat on Full access ignores it and
 * always runs danger-full-access with approval policy never (see runTurn).
 */
export const SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;
export type SandboxMode = (typeof SANDBOX_MODES)[number];

export function sandboxMode(value = process.env.PERRY_CODEX_SANDBOX): SandboxMode {
  if (!value) return "workspace-write";
  if (!(SANDBOX_MODES as readonly string[]).includes(value)) {
    throw new Error(`PERRY_CODEX_SANDBOX must be one of ${SANDBOX_MODES.join(", ")}; it is "${value}".`);
  }
  return value as SandboxMode;
}

/** The per-turn policy for a mode, as the app-server's SandboxPolicy. */
function sandboxPolicy(mode: SandboxMode, writableRoots: string[]) {
  if (mode === "read-only") return { type: "readOnly", networkAccess: false };
  if (mode === "danger-full-access") return { type: "dangerFullAccess" };
  return { type: "workspaceWrite", writableRoots, networkAccess: false };
}

/** Name of the MCP server that serves the deployment's tools to Codex. */
export const ASSISTANT_MCP = "assistant";

/**
 * The slice of the app-server protocol this runner uses. Codex's own generated
 * types (`codex app-server generate-ts`) are the full reference.
 */
type Json = Record<string, any>;
export type RpcMessage = { id?: number | string; method?: string; params?: Json; result?: any; error?: { message?: string } };
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
export type TurnItem = Json & { id: string; type?: string };
type TurnEvent = { turn: { id: string; status: string; items?: TurnItem[]; error?: { message?: string } } };
type LoginEvent = { loginId: string; success: boolean; error?: string };
type TurnErrorEvent = { turnId: string; willRetry?: boolean; error?: { message?: string } };
/** item/started carries startedAtMs, item/completed completedAtMs. */
type ItemEvent = { threadId: string; turnId: string; item: TurnItem; startedAtMs?: number; completedAtMs?: number };
/** TokenUsageBreakdown: cached input is part of input, reasoning part of output. */
export type TokenUsage = {
  totalTokens: number; inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number;
  outputTokens: number; reasoningOutputTokens: number;
};
/** thread/tokenUsage/updated: the thread's running total, and the latest model response's share. */
type TokenUsageEvent = { threadId: string; turnId: string; tokenUsage: { total: TokenUsage; last: TokenUsage } };

export type GeneratedImage = { id: string; path?: string; base64?: string };
/** `compacted`: Codex compacted the thread's context during the turn (a contextCompaction item). */
export type TurnOutput = { text: string; images: GeneratedImage[]; interrupted?: boolean; compacted?: boolean };

/** A turn that failed, with whatever it had produced before it did. */
export class TurnFailed extends Error {
  constructor(message: string, readonly partial: TurnOutput) {
    super(message);
  }
}
export type CodexAttachment = { url?: string; localPath?: string; fileName: string; contentType?: string };
export type CodexModel = { id: string; name: string; isDefault: boolean; efforts: string[]; defaultEffort?: string };
export type ChatgptToken = { accessToken: string; accountId?: string; expiresAt: number };

/** Refresh a token this close to expiry before handing it out, as eve does. */
const TOKEN_REFRESH_WINDOW_MS = 5 * 60_000;

// Adapted from vercel/eve (Apache-2.0): packages/eve/src/public/models/openai/chatgpt/auth.ts
/**
 * The account id and expiry are claims in the access token, a JWT. They are
 * read, not verified: ChatGPT verifies the token, this only needs to know
 * which account it is for and when to stop using it.
 */
function tokenFromCodex(accessToken: string): ChatgptToken | null {
  let claims: Record<string, any>;
  try { claims = JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString("utf8")); }
  catch { return null; }
  if (typeof claims?.exp !== "number") return null;
  const auth = claims["https://api.openai.com/auth"];
  const text = (value: unknown) => typeof value === "string" && value.trim() ? value : undefined;
  const accountId = text(claims.chatgpt_account_id) ?? text(auth?.chatgpt_account_id)
    ?? text(Array.isArray(claims.organizations) ? claims.organizations[0]?.id : undefined);
  return { accessToken, accountId, expiresAt: claims.exp * 1000 };
}

/** A message as Codex input: its text, images inline, other files named by where they are. */
function userInput(prompt: string, attachments: CodexAttachment[], recalled?: string): object[] {
  const text = { type: "text", text: prompt, text_elements: [] };
  // Recalled memory goes first, as its own part of the owner's message.
  const input: object[] = recalled ? [{ type: "text", text: recalled, text_elements: [] }, text] : [text];
  for (const attachment of attachments) {
    // Local files are read straight from where they are on this machine.
    const path = attachment.localPath ?? null;
    if (attachment.contentType?.startsWith("image/")) {
      input.push(path ? { type: "localImage", path } : { type: "image", url: attachment.url });
    } else {
      text.text += `\nAttached file: ${attachment.fileName} (${path ?? attachment.url})`;
    }
  }
  return input;
}

/** One file in a fileChange item: add, delete or update, with its diff. */
export type FileChange = { path: string; kind?: { type?: string }; diff?: string };

/** A stdio client for the official Codex app-server protocol. */
export class CodexAppServer extends EventEmitter {
  private nextId = 1;
  private pending = new Map<number | string, Pending>();
  private completedLogins = new Map<string, LoginEvent>();
  private completedTurns = new Map<string, TurnEvent>();
  private turnItems = new Map<string, TurnItem[]>();
  private tokenTotals = new Map<string, number>();
  private fileChanges = new Map<string, FileChange[]>();
  private child?: ChildProcessWithoutNullStreams;
  closed = false;

  /** What a file-change item is about to change, for its approval request. */
  changesFor(itemId?: string): FileChange[] {
    return (itemId && this.fileChanges.get(itemId)) || [];
  }

  async start(): Promise<this> {
    // A mistyped escape hatch fails here, where the runner reports it, not mid-turn.
    sandboxMode();
    const windows = process.platform === "win32";
    const child = spawn(
      windows ? process.env.COMSPEC || "cmd.exe" : "codex",
      windows ? ["/d", "/s", "/c", "codex app-server --stdio"] : ["app-server", "--stdio"],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    this.child = child;
    createInterface({ input: child.stdout }).on("line", (line) => {
      let message: RpcMessage;
      try { message = JSON.parse(line); } catch { return; }
      const pending = message.id !== undefined ? this.pending.get(message.id) : undefined;
      if (message.id !== undefined && pending) {
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        message.error ? pending.reject(new Error(message.error.message || "Codex request failed.")) : pending.resolve(message.result);
      } else if (message.method && message.id !== undefined) {
        this.emit("serverRequest", message);
      } else if (message.method) {
        const params = message.params ?? {};
        if (message.method === "account/login/completed" && params.loginId) {
          this.completedLogins.set(params.loginId, params as LoginEvent);
        }
        // A file change's approval request names only its item, so keep the
        // item's paths from when it starts (and as its patch is updated).
        if (message.method === "item/started" && params.item?.type === "fileChange") {
          this.fileChanges.set(params.item.id, params.item.changes ?? []);
        }
        if (message.method === "item/fileChange/patchUpdated" && params.itemId) {
          this.fileChanges.set(params.itemId, params.changes ?? []);
        }
        if (message.method === "item/completed" && params.turnId) {
          this.fileChanges.delete(params.item?.id);
          const items = this.turnItems.get(params.turnId) ?? [];
          items.push(params.item);
          this.turnItems.set(params.turnId, items);
        }
        if (message.method === "turn/completed" && params.turn?.id) {
          this.completedTurns.set(params.turn.id, params as TurnEvent);
        }
        // Codex can report a thread's usage again without a new model response,
        // such as when rate limits change. Only a changed total is new usage.
        if (message.method === "thread/tokenUsage/updated" && params.threadId) {
          const total = params.tokenUsage?.total?.totalTokens;
          if (total === this.tokenTotals.get(params.threadId)) return;
          this.tokenTotals.set(params.threadId, total);
        }
        // Codex reports turn failures, such as a usage limit, as an "error"
        // notification. Re-emitting that as Node's special "error" event would
        // crash the runner, so it travels as "turn/error" instead.
        this.emit(message.method === "error" ? "turn/error" : message.method, params);
      }
    });
    child.on("error", (error) => this.fail(error));
    child.on("close", (code) => this.fail(new Error(`Codex app-server exited (${code}).`)));
    await this.request("initialize", {
      clientInfo: { name: "perry", title: "Assistant", version: "0.1.0" },
    });
    this.notify("initialized", {});
    return this;
  }

  private fail(error: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
    this.emit("closed", error);
  }

  private write(message: object) {
    if (!this.child || this.closed) throw new Error("Codex app-server is not running.");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  notify(method: string, params: object) {
    this.write({ method, params });
  }

  respond(id: RpcMessage["id"], result: object) {
    this.write({ id, result });
  }

  rejectRequest(id: RpcMessage["id"], message: string) {
    this.write({ id, error: { code: -32601, message } });
  }

  request<T = any>(method: string, params: object, timeoutMs = 15_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Codex app-server is not running."));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ method, id, params });
    });
  }

  async account(): Promise<{ available: true; authMode?: string; planType?: string }> {
    const result = await this.request<{ account?: { type?: string; planType?: string | null } | null }>("account/read", { refreshToken: false });
    const account = result.account;
    return {
      available: true,
      authMode: account?.type,
      planType: account?.type === "chatgpt" ? account.planType ?? undefined : undefined,
    };
  }

  // Adapted from vercel/eve (Apache-2.0): packages/eve/src/public/models/openai/chatgpt/codex-app-server.ts
  /**
   * The ChatGPT access token Codex holds, for answering without this machine
   * (convex/chatgpt.ts). Codex keeps the refresh token and refreshes the access
   * token itself; one about to expire, or one ChatGPT refused, is refreshed
   * first.
   */
  async chatgptToken(forceRefresh = false): Promise<ChatgptToken | null> {
    const read = async (refreshToken: boolean) => {
      const status = await this.request<{ authMethod?: string | null; authToken?: string | null }>("getAuthStatus", { includeToken: true, refreshToken });
      return status.authMethod === "chatgpt" && status.authToken ? tokenFromCodex(status.authToken) : null;
    };
    const token = await read(forceRefresh);
    if (!token || forceRefresh || token.expiresAt - TOKEN_REFRESH_WINDOW_MS > Date.now()) return token;
    return await read(true);
  }

  /** The account's models, each with the reasoning efforts turn/start takes for it (a chat's thinking level). */
  async models(): Promise<CodexModel[]> {
    const result = await this.request<{ data?: Array<{
      model: string; displayName?: string; isDefault?: boolean;
      supportedReasoningEfforts?: Array<{ reasoningEffort: string }>; defaultReasoningEffort?: string;
    }> }>("model/list", { limit: 100 });
    return (result.data ?? []).map((model) => ({
      id: model.model,
      name: model.displayName || model.model,
      isDefault: Boolean(model.isDefault),
      efforts: (model.supportedReasoningEfforts ?? []).map((option) => option.reasoningEffort),
      defaultEffort: model.defaultReasoningEffort || undefined,
    }));
  }

  waitForLogin(loginId: string, timeoutMs = 10 * 60_000): Promise<void> {
    const completed = this.completedLogins.get(loginId);
    if (completed) {
      this.completedLogins.delete(loginId);
      return completed.success ? Promise.resolve() : Promise.reject(new Error(completed.error || "Codex sign-in failed."));
    }
    return new Promise<void>((resolve, reject) => {
      const onComplete = (result: LoginEvent) => {
        if (result?.loginId !== loginId) return;
        this.completedLogins.delete(loginId);
        clearTimeout(timer);
        this.off("account/login/completed", onComplete);
        this.off("closed", onClose);
        result.success ? resolve() : reject(new Error(result.error || "Codex sign-in failed."));
      };
      const onClose = (error: Error) => {
        clearTimeout(timer);
        this.off("account/login/completed", onComplete);
        reject(error);
      };
      const timer = setTimeout(() => {
        this.off("account/login/completed", onComplete);
        this.off("closed", onClose);
        void this.request("account/login/cancel", { loginId }).catch(() => {});
        reject(new Error("Codex sign-in expired. Try again."));
      }, timeoutMs);
      this.on("account/login/completed", onComplete);
      this.on("closed", onClose);
    });
  }

  /**
   * Wait for a turn to end. A completed turn resolves with its final reply and
   * generated images; an interrupted one (stopped by the owner) resolves with
   * what it had produced so far. A failed turn rejects with a TurnFailed that
   * still carries its partial output, so a late failure does not lose it.
   */
  waitForTurn(turnId: string, timeoutMs = 8 * 60_000): Promise<TurnOutput> {
    return new Promise((resolve, reject) => {
      const stop = () => {
        clearTimeout(timer);
        this.off("turn/completed", finish);
        this.off("turn/error", onError);
        this.off("closed", onClose);
      };
      // App-server extension items can be omitted from turn.items even though
      // item/completed delivered them. Keep both sources, keyed by item id.
      const collect = (turnItems: TurnItem[] = []) => {
        // In the order Codex completed them, with turn.items filling any gaps.
        const items = [...new Map([...(this.turnItems.get(turnId) ?? []), ...turnItems].map((item) => [item.id, item])).values()];
        this.turnItems.delete(turnId);
        const messages = items.filter((item) => item?.type === "agentMessage" && item.text?.trim());
        // The last message that is not commentary. A steered turn answers again
        // after its first final answer, and that later message may carry no phase.
        const final = messages.filter((item) => item.phase !== "commentary").at(-1) ?? messages.at(-1);
        const images = items
          .filter((item) =>
            (item?.type === "imageGeneration" && !item.failure && (item.savedPath || item.result)) ||
            (item?.type === "Extension" && item.kind === "image_gen.generation" && item.status === "completed" && typeof item.result === "string"),
          )
          .map((item) => ({ id: item.id, path: item.savedPath as string | undefined, base64: item.savedPath ? undefined : item.result as string }));
        const compacted = items.some((item) => item?.type === "contextCompaction");
        return { text: (final?.text as string | undefined)?.trim() ?? "", images, ...(compacted ? { compacted } : {}) };
      };
      const fail = (message: string, turnItems?: TurnItem[]) => {
        stop();
        reject(new TurnFailed(message, collect(turnItems)));
      };
      const finish = (event: TurnEvent) => {
        if (event?.turn?.id !== turnId) return;
        this.completedTurns.delete(turnId);
        if (event.turn.status === "completed" || event.turn.status === "interrupted") {
          stop();
          const output = collect(event.turn.items);
          const interrupted = event.turn.status === "interrupted";
          resolve({
            ...output,
            text: output.text || (output.images.length || interrupted ? "" : "Codex completed without a text reply."),
            interrupted,
          });
          return;
        }
        fail(event.turn.error?.message || `Codex turn ${event.turn.status}.`, event.turn.items);
      };
      const onError = (event: TurnErrorEvent) => {
        if (event?.turnId !== turnId || event.willRetry) return;
        fail(event.error?.message || "Codex turn failed.");
      };
      const onClose = (error: Error) => fail(error.message);
      const timer = setTimeout(() => fail("Codex turn timed out."), timeoutMs);
      this.on("turn/completed", finish);
      this.on("turn/error", onError);
      this.on("closed", onClose);
      const completed = this.completedTurns.get(turnId);
      if (completed) finish(completed);
    });
  }

  /** Have Codex find the skills in Perry's home alongside its own, for the life of this app-server. */
  useSkills(): Promise<unknown> {
    return this.request("skills/extraRoots/set", { extraRoots: [PATHS.skills] });
  }

  /**
   * Codex caches what its skill folders hold and does not watch extra roots,
   * so a skill written in one turn is listed in the next only after a re-scan.
   * Returns the skills of Perry's that failed to load, so the agent can say so.
   */
  private async reloadSkills(cwd: string): Promise<string[]> {
    const result = await this.request<{ data?: Array<{ errors?: Array<{ path: string; message: string }> }> }>("skills/list", { cwds: [cwd], forceReload: true });
    const errors = (result.data ?? []).flatMap((entry) => entry.errors ?? [])
      .filter((error) => { const inside = relative(PATHS.skills, error.path); return !inside.startsWith("..") && !isAbsolute(inside); })
      .map((error) => `${error.path}: ${error.message}`);
    return [...new Set(errors)];
  }

  /** Ask Codex to stop a turn. It ends as interrupted, keeping what it produced. */
  interrupt(threadId: string, turnId: string): Promise<unknown> {
    return this.request("turn/interrupt", { threadId, turnId });
  }

  /**
   * Add a message to a running turn. Codex reads it at its next step and
   * carries on in the same turn. Fails with "no active turn to steer" once the
   * turn has ended, and when expectedTurnId is no longer the active turn.
   */
  steer(threadId: string, turnId: string, prompt: string, attachments: CodexAttachment[] = []): Promise<unknown> {
    return this.request("turn/steer", { threadId, expectedTurnId: turnId, input: userInput(prompt, attachments) }, 30_000);
  }

  /**
   * Compact a thread: Codex replaces its history with a summary, as it does on
   * its own near the context limit. It runs as a turn of its own, which this
   * waits for.
   */
  async compact(threadId: string, cwd: string): Promise<void> {
    await this.request("thread/resume", { threadId, cwd, excludeTurns: true }, 30_000);
    // Like deltas, turn/started can arrive before the request answers.
    let onStarted: (event: { threadId?: string; turn?: { id?: string } }) => void = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = new Promise<string>((resolve, reject) => {
      onStarted = (event) => { if (event.threadId === threadId && event.turn?.id) resolve(event.turn.id); };
      this.on("turn/started", onStarted);
      timer = setTimeout(() => reject(new Error("Codex did not start compacting.")), 60_000);
    });
    try {
      await this.request("thread/compact/start", { threadId }, 30_000);
      await this.waitForTurn(await started, 10 * 60_000);
    } finally {
      clearTimeout(timer);
      this.off("turn/started", onStarted);
    }
  }

  async runTurn({ threadId, instructions, history, recalled, prompt, cwd, model, effort, access = "supervised", tools, attachments = [], onThread, onText, onStarted, onItem, onUsage }: {
    threadId?: string;
    instructions: string;
    history?: string;
    /** Memory recalled for this turn: data for Codex, sent ahead of the prompt rather than as instructions. */
    recalled?: string;
    prompt: string;
    cwd: string;
    model?: string;
    /** The reasoning effort, one the model takes. Unset leaves the thread's own. */
    effort?: string;
    /**
     * Supervised: the sandbox (PERRY_CODEX_SANDBOX, workspace-write by default)
     * and on-request approvals, which reach the owner through the runner. Full:
     * no sandbox, and Codex never asks.
     */
    access?: "supervised" | "full";
    tools?: { url: string; token: string };
    attachments?: CodexAttachment[];
    onThread: (threadId: string) => Promise<unknown>;
    /** The reply so far, as Codex writes it: the text of the message it is currently writing. */
    onText?: (text: string) => void;
    /** Called once Codex has started the turn, with what interrupt() needs. */
    onStarted?: (turn: { threadId: string; turnId: string }) => void;
    /** An item of this turn started or completed: a command, a file change, a tool call and so on. */
    onItem?: (phase: "started" | "completed", item: TurnItem, atMs: number) => void;
    /** One model response's tokens, once per response. */
    onUsage?: (usage: TokenUsage) => void;
  }): Promise<{ threadId: string; response: string; images: GeneratedImage[]; interrupted?: boolean; compacted?: boolean }> {
    const broken = await this.reloadSkills(cwd).catch(() => []);
    const machine = describeMachine();
    // The owner's OS and shell, so commands, paths and "open it" requests fit this machine.
    const home = [
      `Your own folder for files you make is ${PATHS.files}. Organise it as you see fit, and use it unless the owner or the task calls for somewhere else.`,
      `Your skills folder is ${PATHS.skills}.`,
      ...(broken.length ? [`These skills failed to load, so they are not listed:\n${broken.map((line) => `- ${line}`).join("\n")}`] : []),
    ].join(" ") +
      `\n\nThis machine runs ${machine.os}, and your commands run in ${machine.shell}; write commands, paths and quoting for that, and open files or apps with ${machine.open}.`;
    const fullInstructions = history
      ? `${instructions}\n\n${home}\n\nEarlier chat history (context, not a new user request):\n${history}`
      : `${instructions}\n\n${home}`;
    const full = access === "full";
    const policy = full ? "never" : "on-request";
    const sandbox: SandboxMode = full ? "danger-full-access" : sandboxMode();
    // The deployment's own tools: memory, connected accounts, task tracking.
    const config = {
      ...(tools ? {
        [`mcp_servers.${ASSISTANT_MCP}`]: {
          url: tools.url,
          http_headers: { Authorization: `Bearer ${tools.token}` },
          default_tools_approval_mode: "approve",
          tool_timeout_sec: 120,
        },
      } : {}),
      ...WINDOWS_SANDBOX,
    };
    const thread = threadId
      ? await this.request<{ thread?: { id?: string } }>("thread/resume", { threadId, cwd, approvalPolicy: policy, sandbox, config, developerInstructions: fullInstructions }, 30_000)
      : await this.request<{ thread?: { id?: string } }>("thread/start", { cwd, approvalPolicy: policy, sandbox, config, developerInstructions: fullInstructions, serviceName: "perry" }, 30_000);
    const id = thread.thread?.id;
    if (!id) throw new Error("Codex did not return a thread ID.");
    if (!threadId) await onThread(id);
    const input = userInput(prompt, attachments, recalled);
    // Deltas can arrive before turn/start answers, so match them by thread.
    const written = new Map<string, string>();
    let latest = "";
    const onDelta = (event: { threadId?: string; itemId?: string; delta?: string }) => {
      if (event.threadId !== id || !event.itemId || !event.delta) return;
      latest = (written.get(event.itemId) ?? "") + event.delta;
      written.set(event.itemId, latest);
      onText?.(latest);
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
    const onItemStarted = ofTurn((event: ItemEvent) => onItem?.("started", event.item, event.startedAtMs ?? Date.now()));
    const onItemCompleted = ofTurn((event: ItemEvent) => onItem?.("completed", event.item, event.completedAtMs ?? Date.now()));
    const onTokens = ofTurn((event: TokenUsageEvent) => { if (event.tokenUsage?.last) onUsage?.(event.tokenUsage.last); });
    this.on("item/agentMessage/delta", onDelta);
    this.on("item/started", onItemStarted);
    this.on("item/completed", onItemCompleted);
    this.on("thread/tokenUsage/updated", onTokens);
    try {
    // turn/start's overrides hold "for this turn and subsequent turns", and
    // thread/resume of a thread this app-server still has loaded just rejoins
    // it, so every turn states its access and effort: a chat switched mid-way
    // takes the new ones, and nothing lingers from an earlier turn.
    const started = await this.request<{ turn?: { id?: string } }>("turn/start", {
      threadId: id,
      input,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      cwd,
      approvalPolicy: policy,
      sandboxPolicy: sandboxPolicy(sandbox, [cwd, PATHS.files, PATHS.skills]),
    }, 30_000);
    if (!started.turn?.id) throw new Error("Codex did not start a turn.");
    turnId = started.turn.id;
    for (const replay of early.splice(0)) replay();
    onStarted?.({ threadId: id, turnId: started.turn.id });
    try {
      const { text, images, interrupted, compacted } = await this.waitForTurn(started.turn.id);
      // A stopped turn may not have finished its message; the streamed text is the best record of it.
      return { threadId: id, response: text || (interrupted ? latest : ""), images, interrupted, compacted };
    } catch (error) {
      if (error instanceof TurnFailed && !error.partial.text) error.partial.text = latest;
      throw error;
    }
    } finally {
      this.off("item/agentMessage/delta", onDelta);
      this.off("item/started", onItemStarted);
      this.off("item/completed", onItemCompleted);
      this.off("thread/tokenUsage/updated", onTokens);
    }
  }

  close() {
    this.child?.kill();
  }
}
