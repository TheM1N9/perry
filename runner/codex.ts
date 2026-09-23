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
type TurnItem = Json & { id: string; type?: string };
type TurnEvent = { turn: { id: string; status: string; items?: TurnItem[]; error?: { message?: string } } };
type LoginEvent = { loginId: string; success: boolean; error?: string };
type TurnErrorEvent = { turnId: string; willRetry?: boolean; error?: { message?: string } };

export type GeneratedImage = { id: string; path?: string; base64?: string };
export type CodexAttachment = { url?: string; localPath?: string; fileName: string; contentType?: string };
export type CodexModel = { id: string; name: string; isDefault: boolean };

/** A stdio client for the official Codex app-server protocol. */
export class CodexAppServer extends EventEmitter {
  private nextId = 1;
  private pending = new Map<number | string, Pending>();
  private completedLogins = new Map<string, LoginEvent>();
  private completedTurns = new Map<string, TurnEvent>();
  private turnItems = new Map<string, TurnItem[]>();
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

  waitForTurn(turnId: string, timeoutMs = 8 * 60_000): Promise<{ text: string; images: GeneratedImage[] }> {
    return new Promise((resolve, reject) => {
      const stop = () => {
        clearTimeout(timer);
        this.off("turn/completed", finish);
        this.off("turn/error", onError);
        this.off("closed", onClose);
      };
      const finish = (event: TurnEvent) => {
        if (event?.turn?.id !== turnId) return;
        stop();
        this.completedTurns.delete(turnId);
        // App-server extension items can be omitted from turn.items even though
        // item/completed delivered them. Keep both sources, keyed by item id.
        const items = [...new Map([
          ...(event.turn.items ?? []),
          ...(this.turnItems.get(turnId) ?? []),
        ].map((item) => [item.id, item])).values()];
        this.turnItems.delete(turnId);
        if (event.turn.status !== "completed") {
          reject(new Error(event.turn.error?.message || `Codex turn ${event.turn.status}.`));
          return;
        }
        const messages = items.filter((item) => item?.type === "agentMessage" && item.text?.trim());
        const final = messages.filter((item) => item.phase === "final_answer").at(-1) ?? messages.at(-1);
        const images = items
          .filter((item) =>
            (item?.type === "imageGeneration" && !item.failure && (item.savedPath || item.result)) ||
            (item?.type === "Extension" && item.kind === "image_gen.generation" && item.status === "completed" && typeof item.result === "string"),
          )
          .map((item) => ({ id: item.id, path: item.savedPath as string | undefined, base64: item.savedPath ? undefined : item.result as string }));
        resolve({ text: final?.text?.trim() || (images.length ? "" : "Codex completed without a text reply."), images });
      };
      const onError = (event: TurnErrorEvent) => {
        if (event?.turnId !== turnId || event.willRetry) return;
        stop();
        this.turnItems.delete(turnId);
        reject(new Error(event.error?.message || "Codex turn failed."));
      };
      const onClose = (error: Error) => {
        stop();
        reject(error);
      };
      const timer = setTimeout(() => {
        stop();
        reject(new Error("Codex turn timed out."));
      }, timeoutMs);
      this.on("turn/completed", finish);
      this.on("turn/error", onError);
      this.on("closed", onClose);
      const completed = this.completedTurns.get(turnId);
      if (completed) finish(completed);
    });
  }

  async runTurn({ threadId, instructions, history, prompt, cwd, model, tools, attachments = [], onThread, onText }: {
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
  }): Promise<{ threadId: string; response: string; images: GeneratedImage[] }> {
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
    const onDelta = (event: { threadId?: string; itemId?: string; delta?: string }) => {
      if (event.threadId !== id || !event.itemId || !event.delta) return;
      const text = (written.get(event.itemId) ?? "") + event.delta;
      written.set(event.itemId, text);
      onText?.(text);
    };
    this.on("item/agentMessage/delta", onDelta);
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
    const { text: response, images } = await this.waitForTurn(started.turn.id);
    return { threadId: id, response, images };
    } finally {
      this.off("item/agentMessage/delta", onDelta);
    }
  }

  close() {
    this.child?.kill();
  }
}
