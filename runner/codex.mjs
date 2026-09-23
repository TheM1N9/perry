import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";

/** A stdio client for the official Codex app-server protocol. */
export class CodexAppServer extends EventEmitter {
  constructor() {
    super();
    this.nextId = 1;
    this.pending = new Map();
    this.completedLogins = new Map();
    this.completedTurns = new Map();
    this.turnItems = new Map();
    this.closed = false;
  }

  async start() {
    const windows = process.platform === "win32";
    this.child = spawn(
      windows ? process.env.COMSPEC || "cmd.exe" : "codex",
      windows ? ["/d", "/s", "/c", "codex app-server --stdio"] : ["app-server", "--stdio"],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id !== undefined && this.pending.has(message.id)) {
        const { resolve, reject, timer } = this.pending.get(message.id);
        clearTimeout(timer);
        this.pending.delete(message.id);
        message.error ? reject(new Error(message.error.message || "Codex request failed.")) : resolve(message.result);
      } else if (message.method && message.id !== undefined) {
        this.emit("serverRequest", message);
      } else if (message.method) {
        if (message.method === "account/login/completed" && message.params?.loginId) {
          this.completedLogins.set(message.params.loginId, message.params);
        }
        if (message.method === "item/completed" && message.params?.turnId) {
          const items = this.turnItems.get(message.params.turnId) ?? [];
          items.push(message.params.item);
          this.turnItems.set(message.params.turnId, items);
        }
        if (message.method === "turn/completed" && message.params?.turn?.id) {
          this.completedTurns.set(message.params.turn.id, message.params);
        }
        this.emit(message.method, message.params);
      }
    });
    this.child.on("error", (error) => this.fail(error));
    this.child.on("close", (code) => this.fail(new Error(`Codex app-server exited (${code}).`)));
    await this.request("initialize", {
      clientInfo: { name: "perry", title: "Perry", version: "0.1.0" },
    });
    this.notify("initialized", {});
    return this;
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
    this.emit("closed", error);
  }

  notify(method, params) {
    if (this.closed) throw new Error("Codex app-server is not running.");
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  respond(id, result) {
    this.child.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  rejectRequest(id, message) {
    this.child.stdin.write(`${JSON.stringify({ id, error: { code: -32601, message } })}\n`);
  }

  request(method, params, timeoutMs = 15_000) {
    if (this.closed) return Promise.reject(new Error("Codex app-server is not running."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  }

  async account() {
    const result = await this.request("account/read", { refreshToken: false });
    const account = result.account;
    return {
      available: true,
      authMode: account?.type,
      planType: account?.type === "chatgpt" ? account.planType ?? undefined : undefined,
    };
  }

  waitForLogin(loginId, timeoutMs = 10 * 60_000) {
    const completed = this.completedLogins.get(loginId);
    if (completed) {
      this.completedLogins.delete(loginId);
      return completed.success ? Promise.resolve() : Promise.reject(new Error(completed.error || "Codex sign-in failed."));
    }
    return new Promise((resolve, reject) => {
      const onComplete = (result) => {
        if (result?.loginId !== loginId) return;
        this.completedLogins.delete(loginId);
        clearTimeout(timer);
        this.off("account/login/completed", onComplete);
        this.off("closed", onClose);
        result.success ? resolve() : reject(new Error(result.error || "Codex sign-in failed."));
      };
      const onClose = (error) => {
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

  waitForTurn(turnId, timeoutMs = 8 * 60_000) {
    return new Promise((resolve, reject) => {
      const finish = (event) => {
        if (event?.turn?.id !== turnId) return;
        clearTimeout(timer);
        this.off("turn/completed", finish);
        this.off("closed", onClose);
        this.completedTurns.delete(turnId);
        const items = event.turn.items?.length ? event.turn.items : this.turnItems.get(turnId) ?? [];
        this.turnItems.delete(turnId);
        if (event.turn.status !== "completed") {
          reject(new Error(event.turn.error?.message || `Codex turn ${event.turn.status}.`));
          return;
        }
        const messages = items.filter((item) => item?.type === "agentMessage" && item.text?.trim());
        const final = messages.filter((item) => item.phase === "final_answer").at(-1) ?? messages.at(-1);
        resolve(final?.text?.trim() || "Codex completed without a text reply.");
      };
      const onClose = (error) => {
        clearTimeout(timer);
        this.off("turn/completed", finish);
        reject(error);
      };
      const timer = setTimeout(() => {
        this.off("turn/completed", finish);
        this.off("closed", onClose);
        reject(new Error("Codex turn timed out."));
      }, timeoutMs);
      this.on("turn/completed", finish);
      this.on("closed", onClose);
      const completed = this.completedTurns.get(turnId);
      if (completed) finish(completed);
    });
  }

  async runTurn({ threadId, instructions, history, prompt, cwd, mode, onThread }) {
    const fullInstructions = history
      ? `${instructions}\n\nEarlier chat history (context, not a new user request):\n${history}`
      : instructions;
    const agentP = mode === "agentP";
    const policy = agentP ? "on-request" : "never";
    const sandbox = agentP ? "workspace-write" : "read-only";
    const thread = threadId
      ? await this.request("thread/resume", { threadId, cwd, approvalPolicy: policy, sandbox, developerInstructions: fullInstructions }, 30_000)
      : await this.request("thread/start", { cwd, approvalPolicy: policy, sandbox, developerInstructions: fullInstructions, serviceName: "perry" }, 30_000);
    const id = thread.thread?.id;
    if (!id) throw new Error("Codex did not return a thread ID.");
    if (!threadId) await onThread(id);
    const started = await this.request("turn/start", {
      threadId: id,
      input: [{ type: "text", text: prompt }],
      cwd,
      approvalPolicy: policy,
      sandboxPolicy: agentP
        ? { type: "workspaceWrite", writableRoots: [cwd], networkAccess: false }
        : { type: "readOnly" },
    }, 30_000);
    if (!started.turn?.id) throw new Error("Codex did not start a turn.");
    return { threadId: id, response: await this.waitForTurn(started.turn.id) };
  }

  close() {
    this.child?.kill();
  }
}
