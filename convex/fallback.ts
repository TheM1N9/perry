"use node";

import { createOpenAI } from "@ai-sdk/openai";
import { APICallError, type LanguageModelV4, type LanguageModelV4CallOptions } from "@ai-sdk/provider";
import type { FetchFunction } from "@ai-sdk/provider-utils";
import { listMessages } from "@convex-dev/agent";
import { stepCountIs, streamText, type ModelMessage, type ToolSet, type UserContent } from "ai";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, type ActionCtx } from "./_generated/server";
import type { ModelOption } from "./lib/commands";
import { CODEX_TOOLS } from "./mcp";
import { ALL_TOOLS } from "./tools";

/**
 * A turn answered without the computer: in Convex, on the owner's ChatGPT
 * subscription, when no runner could take it and the owner allows it (see
 * chatgpt.ts). It calls the same Codex backend the CLI does, with the access
 * token a runner last pushed, and binds Perry's own tools in-process: memory,
 * earlier chats, connected accounts, jobs, tasks and page reading. There is
 * no shell, no files and no share_file, because those live on the computer.
 *
 * The turn is a codexTurns row like any other, so the web chat streams it,
 * Telegram edits one message as it grows, the owner can stop it, and
 * finalizeTurn saves and delivers it.
 */

const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
/** Like the runner, the reply so far goes out about three times a second. */
const STREAM_MS = 300;
/** Well inside the ten minutes an action may run, so a slow reply still ends cleanly. */
const TURN_MS = 8 * 60_000;
const MAX_STEPS = 12;
const HISTORY_CHARS = 24_000;

const OFFLINE_NOTE = `
The owner's computer is offline, so this reply is written without it. You have
no shell, no files, no image generation and no share_file here, only the
assistant tools you are given. If the request needs the computer, say so and
offer to do it once the computer is back.
`.trim();

type Token = { accessToken: string; accountId?: string };

// --- The Codex transport ---------------------------------------------------

// Adapted from vercel/eve (Apache-2.0): packages/eve/src/public/models/openai/chatgpt/transport.ts
/**
 * Authenticates each request with the pushed token, as the Codex CLI would.
 * A 401 is retried once, and only with a newer token a runner has pushed since;
 * without one the token is dropped, so later turns do not try it again.
 */
function createCodexFetch(first: Token, newer: (rejected: string) => Promise<Token | null>, discard: (rejected: string) => Promise<unknown>): FetchFunction {
  let token = first;
  return async (input, init) => {
    const requestInit = stripInputItemIds(init);
    const response = await fetch(input, authenticatedInit(requestInit, token));
    if (response.status !== 401 || input instanceof Request || init?.body instanceof ReadableStream) return response;
    const rejected = token.accessToken;
    const refreshed = await newer(rejected);
    if (!refreshed) {
      await discard(rejected);
      return response;
    }
    await response.body?.cancel();
    token = refreshed;
    return fetch(input, authenticatedInit(requestInit, token));
  };
}

// Adapted from vercel/eve (Apache-2.0): packages/eve/src/public/models/openai/chatgpt/transport.ts
function stripInputItemIds(init: RequestInit | undefined): RequestInit | undefined {
  if (typeof init?.body !== "string") return init;
  let body: unknown;
  try {
    body = JSON.parse(init.body);
  } catch {
    return init;
  }
  if (!isObject(body) || !Array.isArray(body.input)) return init;
  // Only response item IDs are forbidden; tool call IDs and IDs inside tool
  // inputs or outputs belong to the conversation and must survive replay.
  let changed = false;
  for (const item of body.input) {
    if (isObject(item) && "id" in item) {
      delete item.id;
      changed = true;
    }
  }
  return changed ? { ...init, body: JSON.stringify(body) } : init;
}

// Adapted from vercel/eve (Apache-2.0): packages/eve/src/public/models/openai/chatgpt/transport.ts
function authenticatedInit(init: RequestInit | undefined, token: Token): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${token.accessToken}`);
  headers.set("originator", "perry");
  if (token.accountId !== undefined) headers.set("ChatGPT-Account-Id", token.accountId);
  else headers.delete("ChatGPT-Account-Id");
  return { ...init, headers };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Adapted from vercel/eve (Apache-2.0): packages/eve/src/public/models/openai/chatgpt/model.ts
/** The Responses model, pointed at the Codex backend and shaped the way it accepts. */
function createCodexSubscriptionModel(model: string, fetch: FetchFunction): LanguageModelV4 {
  // The key is a placeholder; the transport sets the real Authorization header.
  const openaiModel = createOpenAI({ apiKey: "chatgpt-subscription", baseURL: CODEX_BASE_URL, fetch, name: "codex" }).responses(model);
  // Keep item IDs until the provider has grouped streamed reasoning summaries.
  // The transport removes them from the stateless request sent to Codex.
  return {
    specificationVersion: openaiModel.specificationVersion,
    provider: openaiModel.provider,
    modelId: openaiModel.modelId,
    get supportedUrls() {
      return openaiModel.supportedUrls;
    },
    doGenerate: (callOptions: LanguageModelV4CallOptions) => openaiModel.doGenerate(normalizeCodexCallOptions(callOptions)),
    doStream: (callOptions: LanguageModelV4CallOptions) => openaiModel.doStream(normalizeCodexCallOptions(callOptions)),
  };
}

// Adapted from vercel/eve (Apache-2.0): packages/eve/src/public/models/openai/chatgpt/model.ts
function normalizeCodexCallOptions(options: LanguageModelV4CallOptions): LanguageModelV4CallOptions {
  const providerOptions = options.providerOptions;
  const openaiOptions = providerOptions?.openai ?? {};
  // The Codex backend requires system instructions in the top-level
  // `instructions` field and rejects a `developer`/`system` role inside the
  // `input` array (the shape the AI SDK produces by default).
  const system = options.prompt.filter((message) => message.role === "system").map((message) => message.content);
  const instructions = system.length > 0 ? system.join("\n\n") : undefined;
  // The Codex backend rejects `max_output_tokens` with `400 Unsupported parameter`.
  const { maxOutputTokens: _maxOutputTokens, ...rest } = options;
  return {
    ...rest,
    prompt: options.prompt.filter((message) => message.role !== "system"),
    providerOptions: {
      ...providerOptions,
      openai: { ...openaiOptions, ...(instructions !== undefined && { instructions }), store: false },
    },
  };
}

// --- The turn ----------------------------------------------------------------

/** The chat's model when the subscription offers it, else the subscription's default. */
function pickModel(models: ModelOption[], requested?: string): string {
  const model = models.find((item) => item.id === requested)?.id ?? models.find((item) => item.isDefault)?.id ?? models[0]?.id ?? requested;
  if (!model) throw new Error("No Codex model is known yet. Start a runner once so it can report the models.");
  return model;
}

/** The chat so far, newest last and within a budget, since Codex's own thread is on the computer. */
async function history(ctx: ActionCtx, threadId: string): Promise<ModelMessage[]> {
  const page = await listMessages(ctx, components.agent, {
    threadId,
    excludeToolMessages: true,
    paginationOpts: { cursor: null, numItems: 60 },
  });
  const messages: ModelMessage[] = [];
  let budget = HISTORY_CHARS;
  for (const item of page.page) {
    const role = item.message?.role;
    const text = (item.text ?? "").replace(/\n?<!-- attachments:[^>]+ -->\s*$/, "").trim();
    if ((role !== "user" && role !== "assistant") || !text) continue;
    budget -= text.length;
    if (budget < 0) break;
    messages.unshift({ role, content: text });
  }
  return messages;
}

/** The owner's message, with images it links to; files on the offline computer are named only. */
function prompt(job: Doc<"codexTurns">): UserContent {
  const content: Exclude<UserContent, string> = [{ type: "text", text: job.prompt }];
  for (const attachment of job.attachments ?? []) {
    if (attachment.url && attachment.contentType.startsWith("image/")) {
      content.push({ type: "image", image: new URL(attachment.url), mediaType: attachment.contentType });
    } else {
      content.push({ type: "text", text: `(Attached: ${attachment.fileName}, which is on the computer and cannot be opened now.)` });
    }
  }
  return content;
}

const json = (value: unknown) => {
  try { return JSON.stringify(value) ?? ""; } catch { return String(value); }
};

export const answer = internalAction({
  args: { id: v.id("codexTurns") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const data: { job: Doc<"codexTurns">; conversation: Doc<"conversations"> | null } | null =
      await ctx.runQuery(internal.codex.getTurn, args);
    if (!data?.conversation || !data.job.fallback || data.job.status !== "running") return null;
    const { job, conversation } = data;
    const runnerId: Id<"runners"> | undefined = conversation.codexRunnerId;

    let label = "chatgpt fallback";
    // The text of the step being written, and the last step that wrote any.
    let latest = "";
    let previous = "";
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort("timeout"), TURN_MS);
    try {
      const token: Token | null = await ctx.runQuery(internal.chatgpt.tokenFor, { runnerId });
      if (!token) throw new Error("No valid ChatGPT token to answer without the computer. Start a runner to push a fresh one.");
      const models: ModelOption[] = await ctx.runQuery(internal.models.list, {});
      const model = pickModel(models, job.requestedModel);
      label = `chatgpt fallback · ${model}`;
      const codexFetch = createCodexFetch(
        token,
        async (rejected) => {
          const next: Token | null = await ctx.runQuery(internal.chatgpt.tokenFor, { runnerId });
          return next && next.accessToken !== rejected ? next : null;
        },
        (rejected) => ctx.runMutation(internal.chatgpt.discard, { accessToken: rejected }),
      );

      // Perry's tools, bound to this chat the way the Agent component binds them.
      const userId = conversation.channel === "web" ? "web:dashboard" : `telegram:${conversation.externalId}`;
      const tools = Object.fromEntries(CODEX_TOOLS.map((name) => [name, { ...ALL_TOOLS[name], ctx: { ...ctx, userId, threadId: conversation.threadId } }])) as ToolSet;

      const result = streamText({
        model: createCodexSubscriptionModel(model, codexFetch),
        instructions: `${job.instructions}\n\n${OFFLINE_NOTE}`,
        messages: [...await history(ctx, conversation.threadId), { role: "user", content: prompt(job) }],
        tools,
        stopWhen: stepCountIs(MAX_STEPS),
        abortSignal: abort.signal,
      });

      let sent = "";
      let sentAt = 0;
      const flush = async () => {
        if (latest === sent) return;
        sent = latest;
        sentAt = Date.now();
        if (await ctx.runMutation(internal.codex.streamFallback, { id: job._id, text: latest })) abort.abort("stop");
      };
      const toolStarted = new Map<string, number>();
      const trace = async (span: { callId: string; name: string; status: "ok" | "error"; input: unknown; output: unknown }) => {
        const startedAt = toolStarted.get(span.callId) ?? Date.now();
        const stop = await ctx.runMutation(internal.codex.traceFallback, {
          id: job._id,
          spans: [{ ...span, kind: "mcpToolCall", startedAt, durationMs: Date.now() - startedAt, input: json(span.input), output: json(span.output) }],
        });
        if (stop) abort.abort("stop");
      };
      let steps = 0;
      for await (const part of result.fullStream) {
        if (part.type === "start-step") {
          if (latest) previous = latest;
          latest = "";
        } else if (part.type === "text-delta") {
          latest += part.text;
          if (Date.now() - sentAt >= STREAM_MS) await flush();
        } else if (part.type === "tool-call") {
          toolStarted.set(part.toolCallId, Date.now());
        } else if (part.type === "tool-result") {
          await trace({ callId: part.toolCallId, name: part.toolName, status: "ok", input: part.input, output: part.output });
        } else if (part.type === "tool-error") {
          await trace({ callId: part.toolCallId, name: part.toolName, status: "error", input: part.input, output: part.error instanceof Error ? part.error.message : part.error });
        } else if (part.type === "finish-step") {
          steps += 1;
        } else if (part.type === "finish") {
          const usage = part.totalUsage;
          await ctx.runMutation(internal.codex.traceFallback, {
            id: job._id,
            spans: [],
            steps,
            usage: {
              inputTokens: usage.inputTokens,
              cachedInputTokens: usage.inputTokenDetails?.cacheReadTokens,
              outputTokens: usage.outputTokens,
              reasoningTokens: usage.outputTokenDetails?.reasoningTokens,
              totalTokens: usage.totalTokens,
            },
          });
        } else if (part.type === "error") {
          throw part.error;
        }
      }
      if (abort.signal.reason === "timeout") throw new Error("timeout");
      const stopped = abort.signal.aborted;
      const response = (latest || previous).trim();
      await ctx.runMutation(internal.codex.finishFallback, {
        id: job._id,
        response: response || (stopped ? undefined : "Done."),
        model: label,
        ...(stopped ? { stopped: true } : {}),
      });
    } catch (error) {
      const stopped = abort.signal.aborted && abort.signal.reason === "stop";
      const message = abort.signal.reason === "timeout" ? "The reply took too long and was cut off."
        : APICallError.isInstance(error) && error.statusCode === 401 ? "ChatGPT refused the saved token. Start a runner so it can push a fresh one."
        : error instanceof Error ? error.message : String(error);
      console.error(`fallback turn failed: ${message}`);
      await ctx.runMutation(internal.codex.finishFallback, {
        id: job._id,
        response: (latest || previous).trim() || undefined,
        model: label,
        ...(stopped ? { stopped: true } : { error: message }),
      });
    } finally {
      clearTimeout(timer);
    }
    return null;
  },
});
