import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { createInterface } from "node:readline";
import type { GeneratedImage, NamedSkill } from "./engine";
import { killTree, spawnEngine } from "./engines/process";
import { PATHS } from "./home";

/**
 * The client for Codex's app-server protocol, which runner/engines/codex.ts
 * drives as Perry's Codex engine.
 */

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
 * That is the mode of a chat on Ask. Auto and Full access run danger-full-access:
 * Auto with every command reviewed first, Full access never asking (engines/codex.ts).
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
export function sandboxPolicy(mode: SandboxMode, writableRoots: string[]) {
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
export type ItemEvent = { threadId: string; turnId: string; item: TurnItem; startedAtMs?: number; completedAtMs?: number };
/** TokenUsageBreakdown: cached input is part of input, reasoning part of output. */
export type TokenUsage = {
  totalTokens: number; inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number;
  outputTokens: number; reasoningOutputTokens: number;
};
/** thread/tokenUsage/updated: the thread's running total, and the latest model response's share. */
export type TokenUsageEvent = { threadId: string; turnId: string; tokenUsage: { total: TokenUsage; last: TokenUsage; modelContextWindow?: number | null } };

/** RateLimitWindow: resetsAt is in seconds. */
export type RateLimitWindow = { usedPercent: number; windowDurationMins?: number | null; resetsAt?: number | null };
/** RateLimitSnapshot: one bucket of the plan's limits ("codex", or a model's own), its 5-hour (primary) and weekly (secondary) windows. */
export type RateLimitSnapshot = {
  limitId?: string | null; limitName?: string | null; normalModelSlug?: string | null;
  primary?: RateLimitWindow | null; secondary?: RateLimitWindow | null; planType?: string | null;
};

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
/**
 * A message as Codex input: its text, images inline, other files named by
 * where they are, and each skill it names as a `skill` item, which has Codex
 * put that SKILL.md in front of the model with the message. (Codex also finds
 * a "$name" in the text on its own, and uses a skill named both ways once.)
 */
export function userInput(prompt: string, attachments: CodexAttachment[], recalled?: string, skills: NamedSkill[] = []): object[] {
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
  for (const skill of skills) input.push({ type: "skill", name: skill.name, path: skill.path });
  return input;
}

/** One file in a fileChange item: add, delete or update, with its diff. */
export type FileChange = { path: string; kind?: { type?: string }; diff?: string };

/**
 * Every SKILL.md in the folders Codex takes skills from (Perry's, the
 * owner's own, and the working folder's), with when it last changed.
 */
function skillsSignature(cwd: string): string {
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  const roots = [PATHS.skills, join(codexHome, "skills"), join(homedir(), ".agents", "skills"), join(cwd, ".codex", "skills"), join(cwd, ".agents", "skills")];
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && depth < 4) walk(path, depth + 1);
      else if (entry.name === "SKILL.md") {
        try { const stat = statSync(path); found.push(`${path}:${stat.mtimeMs}:${stat.size}`); } catch {}
      }
    }
  };
  for (const root of roots) walk(root, 0);
  return found.sort().join("\n");
}

/** A stdio client for the official Codex app-server protocol. */
export class CodexAppServer extends EventEmitter {
  private nextId = 1;
  private pending = new Map<number | string, Pending>();
  private completedLogins = new Map<string, LoginEvent>();
  private completedTurns = new Map<string, TurnEvent>();
  private turnItems = new Map<string, TurnItem[]>();
  private tokenTotals = new Map<string, number>();
  private fileChanges = new Map<string, FileChange[]>();
  /** Per working folder, what the skill folders held when Codex last scanned them, and what failed to load then. */
  private skillScans = new Map<string, { signature: string; broken: string[] }>();
  private child?: ChildProcessWithoutNullStreams;
  closed = false;
  /** The CLI's version, from the userAgent initialize answers with. */
  version?: string;
  /** The plan's limits by bucket, from the last read and the updates Codex sent since; and when they last changed. */
  readonly rateLimits = new Map<string, RateLimitSnapshot>();
  rateLimitsAt = 0;

  /** What a file-change item is about to change, for its approval request. */
  changesFor(itemId?: string): FileChange[] {
    return (itemId && this.fileChanges.get(itemId)) || [];
  }

  async start(): Promise<this> {
    // A mistyped escape hatch fails here, where the runner reports it, not mid-turn.
    sandboxMode();
    // Stdio is the default transport. Older Codex (0.106, for one) has no --stdio
    // flag and exits (2) on it, so it is left out rather than spelled out.
    const child = spawnEngine("codex", ["app-server"]);
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
        // A rolling update is sparse: what it leaves out keeps its last value.
        if (message.method === "account/rateLimits/updated" && params.rateLimits) {
          const update = params.rateLimits as RateLimitSnapshot;
          const id = update.limitId ?? "codex";
          const kept = this.rateLimits.get(id) ?? {};
          this.rateLimits.set(id, { ...kept, ...Object.fromEntries(Object.entries(update).filter(([, value]) => value !== null && value !== undefined)) });
          this.rateLimitsAt = Date.now();
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
    const initialized = await this.request<{ userAgent?: string }>("initialize", {
      clientInfo: { name: "perry", title: "Assistant", version: "0.1.0" },
    });
    this.version = initialized?.userAgent?.match(/\/(\d+\.\d+\.\d+[\w.-]*)/)?.[1];
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

  async account(): Promise<{ available: true; authMode?: string; planType?: string; email?: string }> {
    const result = await this.request<{ account?: { type?: string; planType?: string | null; email?: string | null } | null }>("account/read", { refreshToken: false });
    const account = result.account;
    return {
      available: true,
      authMode: account?.type,
      planType: account?.type === "chatgpt" ? account.planType ?? undefined : undefined,
      email: account?.type === "chatgpt" ? account.email ?? undefined : undefined,
    };
  }

  /**
   * Read the plan's limits afresh. It spends nothing; the details of limit
   * resets the owner could buy are skipped, as for Codex's own background reads.
   */
  async readRateLimits(): Promise<void> {
    const result = await this.request<{ rateLimits?: RateLimitSnapshot; rateLimitsByLimitId?: Record<string, RateLimitSnapshot | undefined> | null }>(
      "account/rateLimits/read", { excludeResetCreditDetails: true });
    const buckets = result.rateLimitsByLimitId
      ? Object.entries(result.rateLimitsByLimitId).flatMap(([id, bucket]) => bucket ? [[id, bucket] as const] : [])
      : result.rateLimits ? [[result.rateLimits.limitId ?? "codex", result.rateLimits] as const] : [];
    this.rateLimits.clear();
    for (const [id, bucket] of buckets) this.rateLimits.set(id, bucket);
    this.rateLimitsAt = Date.now();
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
   * A timeout of 0 waits for as long as it takes (the runner's watchdog keeps
   * the time for chat turns).
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
      const timer = timeoutMs > 0 ? setTimeout(() => fail("Codex turn timed out."), timeoutMs) : undefined;
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
   * The scan takes a noticeable part of a second, so it runs only when a
   * SKILL.md was added, removed or changed since the last one.
   * Returns the skills of Perry's that failed to load, so the agent can say so.
   */
  async reloadSkills(cwd: string): Promise<string[]> {
    const signature = skillsSignature(cwd);
    const scanned = this.skillScans.get(cwd);
    if (scanned?.signature === signature) return scanned.broken;
    const result = await this.request<{ data?: Array<{ errors?: Array<{ path: string; message: string }> }> }>("skills/list", { cwds: [cwd], forceReload: true });
    const errors = (result.data ?? []).flatMap((entry) => entry.errors ?? [])
      .filter((error) => { const inside = relative(PATHS.skills, error.path); return !inside.startsWith("..") && !isAbsolute(inside); })
      .map((error) => `${error.path}: ${error.message}`);
    const broken = [...new Set(errors)];
    this.skillScans.set(cwd, { signature, broken });
    return broken;
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
  steer(threadId: string, turnId: string, prompt: string, attachments: CodexAttachment[] = [], skills: NamedSkill[] = []): Promise<unknown> {
    return this.request("turn/steer", { threadId, expectedTurnId: turnId, input: userInput(prompt, attachments, undefined, skills) }, 30_000);
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
  /** End the app-server and everything it started. */
  close(signal?: NodeJS.Signals) {
    if (this.child) killTree(this.child, signal);
  }
}
