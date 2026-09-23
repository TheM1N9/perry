import { ConvexClient } from "convex/browser";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import type { RunView } from "../convex/dashboard";

/**
 * Talking to Perry from a terminal the way the dashboard does: web chats,
 * through the same public functions, with the dashboard key. `pnpm chat` and
 * `pnpm evals` share it, so both send and wait for a reply the same way.
 * Bun loads .env.local, which has the deployment URL and the key.
 */

export type ChatId = Id<"conversations">;

/** One finished turn: the reply, Perry's tools it called, and the run that recorded it. */
export type Turn = {
  chatId: ChatId;
  prompt: string;
  message: string;
  toolCalls: string[];
  run?: RunView;
  error?: string;
  elapsedMs: number;
};

export class Perry {
  readonly convex: ConvexClient;
  private heartbeat?: ReturnType<typeof setInterval>;

  /**
   * With a runner token, Perry keeps that runner the most recently seen while
   * a reply is on its way, so new chats bind to it rather than the owner's
   * runner. That is how the short-lived test runner in the e2e checks is used.
   */
  constructor(readonly key: string, url: string, private readonly runnerToken?: string) {
    this.convex = new ConvexClient(url);
  }

  static fromEnv(runnerToken?: string): Perry {
    const url = process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL;
    const key = process.env.DASHBOARD_KEY;
    if (!url || !key) {
      throw new Error("Set NEXT_PUBLIC_CONVEX_URL (or CONVEX_URL) and DASHBOARD_KEY, or run from the folder with .env.local.");
    }
    return new Perry(key, url, runnerToken);
  }

  createChat(): Promise<ChatId> {
    return this.convex.mutation(api.dashboard.createChat, { key: this.key });
  }

  getChat(id: ChatId) {
    return this.convex.query(api.dashboard.getChat, { key: this.key, id });
  }

  /**
   * Send a message and wait for the reply to finish, however it ends: done,
   * stopped or failed. `onText` gets the reply so far while it is written.
   * Aborting stops waiting but leaves the reply running; `discard` ends it.
   */
  async send(chatId: ChatId, text: string, options: { model?: string; onText?: (text: string) => void; signal?: AbortSignal } = {}): Promise<Turn> {
    const { key } = this;
    const earlier = (await this.convex.query(api.dashboard.listRuns, { key, conversationId: chatId }))[0]?.id;
    const startedAt = Date.now();
    this.beat(true);
    try {
      await this.convex.mutation(api.dashboard.sendChat, { key, id: chatId, text, model: options.model });
      // The mutation has resolved, so this subscription already sees the turn as running.
      await this.until(api.dashboard.getChat, { key, id: chatId }, (chat) => {
        if (chat.isRunning && chat.streaming) options.onText?.(chat.streaming);
        return !chat.isRunning;
      }, options.signal);
    } finally {
      this.beat(false);
    }
    const [runs, messages] = await Promise.all([
      this.convex.query(api.dashboard.listRuns, { key, conversationId: chatId }),
      this.convex.query(api.dashboard.getChatMessages, { key, id: chatId, paginationOpts: { numItems: 10, cursor: null } }),
    ]);
    const run = runs[0] && runs[0].id !== earlier ? runs[0] : undefined;
    // Newest first: the reply is whatever came after the message just sent.
    const sent = messages.page.findIndex((message) => message.role === "user");
    const reply = messages.page.slice(0, sent === -1 ? undefined : sent).find((message) => message.role === "assistant");
    return {
      chatId,
      prompt: text,
      message: reply?.text ?? "",
      toolCalls: run?.toolCalls ?? [],
      run,
      error: run?.status === "error" ? run.error ?? "The turn failed." : undefined,
      elapsedMs: Date.now() - startedAt,
    };
  }

  /** Stop the running reply, keeping what it has written. */
  stop(chatId: ChatId): Promise<number> {
    return this.convex.mutation(api.dashboard.stopChat, { key: this.key, id: chatId });
  }

  setModel(chatId: ChatId, model?: string): Promise<null> {
    return this.convex.mutation(api.dashboard.setChatModel, { key: this.key, id: chatId, model });
  }

  /** Delete a chat, stopping its reply first if one is still running. */
  async discard(chatId: ChatId): Promise<void> {
    const chat = await this.getChat(chatId).catch(() => null);
    if (!chat) return;
    if (chat.isRunning) {
      await this.stop(chatId);
      await this.until(api.dashboard.getChat, { key: this.key, id: chatId }, (current) => !current.isRunning, AbortSignal.timeout(90_000));
    }
    await this.convex.mutation(api.dashboard.deleteChat, { key: this.key, id: chatId });
  }

  async close(): Promise<void> {
    this.beat(false);
    await this.convex.close();
  }

  /** Resolve with a query's value once `done` holds for it. */
  private until<Query extends FunctionReference<"query">>(
    query: Query,
    args: FunctionArgs<Query>,
    done: (value: FunctionReturnType<Query>) => boolean,
    signal?: AbortSignal,
  ): Promise<FunctionReturnType<Query>> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      let settled = false;
      const finish = (settle: () => void) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        // The first value can arrive before onUpdate has returned its unsubscribe.
        queueMicrotask(() => unsubscribe());
        settle();
      };
      const onAbort = () => finish(() => reject(signal!.reason));
      signal?.addEventListener("abort", onAbort, { once: true });
      const unsubscribe = this.convex.onUpdate(query, args, (value) => {
        if (done(value)) finish(() => resolve(value));
      }, (error) => finish(() => reject(error)));
    });
  }

  /** Check the runner in every second while a reply is on its way; the runner itself only does so every 30. */
  private beat(on: boolean) {
    if (!this.runnerToken) return;
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    if (!on) return;
    const checkIn = () => void this.convex.mutation(api.runner.checkIn, { token: this.runnerToken! }).catch(() => {});
    checkIn();
    this.heartbeat = setInterval(checkIn, 1000);
  }
}
