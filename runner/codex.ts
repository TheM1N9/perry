import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { PATHS } from "./home";

/**
 * Codex's "elevated" Windows sandbox runs a setup check over every file its
 * runtimes need, and that check cannot open paths longer than 260 characters
 * even with long paths enabled; one deep path in Codex's own computer-use
 * runtime then fails every sandboxed command with "CreateProcess: Rejected -
 * helper_unknown_error: setup refresh had errors". The unelevated sandbox
 * (a restricted token) has no such check, so the runner's threads use it.
 * PERRY_CODEX_WINDOWS_SANDBOX=elevated restores Codex's own choice.
 */
const WINDOWS_SANDBOX = process.platform === "win32"
  ? { "windows.sandbox": process.env.PERRY_CODEX_WINDOWS_SANDBOX ?? "unelevated" }
  : {};

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
export type TurnOutput = { text: string; images: GeneratedImage[]; interrupted?: boolean };

/** A turn that failed, with whatever it had produced before it did. */
export class TurnFailed extends Error {
  constructor(message: string, readonly partial: TurnOutput) {
    super(message);
  }
}
export type CodexAttachment = { url?: string; localPath?: string; fileName: string; contentType?: string };
export type CodexModel = { id: string; name: string; isDefault: boolean };

/** A stdio client for the official Codex app-server protocol. */
export class CodexAppServer extends EventEmitter {
  private nextId = 1;
  private pending = new Map<number | string, Pending>();
  private completedLogins = new Map<string, LoginEvent>();
  private completedTurns = new Map<string, TurnEvent>();
  private turnItems = new Map<string, TurnItem[]>();
  private tokenTotals = new Map<string, number>();
  private child?: ChildProcessWithoutNullStreams;
  closed = false;

  async start(): Promise<this> {
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
        if (message.method === "item/completed" && params.turnId) {
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

  async models(): Promise<CodexModel[]> {
    const result = await this.request<{ data?: Array<{ model: string; displayName?: string; isDefault?: boolean }> }>("model/list", { limit: 100 });
    return (result.data ?? []).map((model) => ({ id: model.model, name: model.displayName || model.model, isDefault: Boolean(model.isDefault) }));
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
        const items = [...new Map([...turnItems, ...(this.turnItems.get(turnId) ?? [])].map((item) => [item.id, item])).values()];
        this.turnItems.delete(turnId);
        const messages = items.filter((item) => item?.type === "agentMessage" && item.text?.trim());
        const final = messages.filter((item) => item.phase === "final_answer").at(-1) ?? messages.at(-1);
        const images = items
          .filter((item) =>
            (item?.type === "imageGeneration" && !item.failure && (item.savedPath || item.result)) ||
            (item?.type === "Extension" && item.kind === "image_gen.generation" && item.status === "completed" && typeof item.result === "string"),
          )
          .map((item) => ({ id: item.id, path: item.savedPath as string | undefined, base64: item.savedPath ? undefined : item.result as string }));
        return { text: (final?.text as string | undefined)?.trim() ?? "", images };
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

  /** Ask Codex to stop a turn. It ends as interrupted, keeping what it produced. */
  interrupt(threadId: string, turnId: string): Promise<unknown> {
    return this.request("turn/interrupt", { threadId, turnId });
  }

  async runTurn({ threadId, instructions, history, prompt, cwd, model, tools, attachments = [], onThread, onText, onStarted, onItem, onUsage }: {
    threadId?: string;
    instructions: string;
    history?: string;
    prompt: string;
    cwd: string;
    model?: string;
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
  }): Promise<{ threadId: string; response: string; images: GeneratedImage[]; interrupted?: boolean }> {
    const home = `Your own folder for files you make is ${PATHS.files}. Organise it as you see fit, and use it unless the owner or the task calls for somewhere else.`;
    const fullInstructions = history
      ? `${instructions}\n\n${home}\n\nEarlier chat history (context, not a new user request):\n${history}`
      : `${instructions}\n\n${home}`;
    const policy = "on-request";
    const sandbox = "workspace-write";
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
    const text = { type: "text", text: prompt };
    const input: object[] = [text];
    for (const attachment of attachments) {
      // Local files are read straight from where they are on this machine.
      const path = attachment.localPath ?? null;
      if (attachment.contentType?.startsWith("image/")) {
        input.push(path ? { type: "localImage", path } : { type: "image", url: attachment.url });
      } else {
        text.text += `\nAttached file: ${attachment.fileName} (${path ?? attachment.url})`;
      }
    }
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
    const started = await this.request<{ turn?: { id?: string } }>("turn/start", {
      threadId: id,
      input,
      ...(model ? { model } : {}),
      cwd,
      approvalPolicy: policy,
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [cwd, PATHS.files], networkAccess: false },
    }, 30_000);
    if (!started.turn?.id) throw new Error("Codex did not start a turn.");
    turnId = started.turn.id;
    for (const replay of early.splice(0)) replay();
    onStarted?.({ threadId: id, turnId: started.turn.id });
    try {
      const { text, images, interrupted } = await this.waitForTurn(started.turn.id);
      // A stopped turn may not have finished its message; the streamed text is the best record of it.
      return { threadId: id, response: text || (interrupted ? latest : ""), images, interrupted };
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
