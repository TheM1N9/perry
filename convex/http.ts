import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { parseUpdate, type TelegramUpdate } from "./lib/telegram";
import { handle as mcp } from "./mcp";

/**
 * Telegram posts straight here.
 *
 * The design doc put a Vercel function in front of this. It turned out to buy
 * nothing: this endpoint is already HTTPS on a stable domain, and the handler
 * has to reach Convex anyway. A hop in between would add a second shared
 * secret, a cold start, and one more thing to deploy. Vercel still owns the
 * dashboard and the AI Gateway.
 *
 * Contract with Telegram: answer 200 fast. Anything slow is scheduled and runs
 * after this returns, because a non-200 means Telegram retries and you get the
 * same message handled twice.
 */

const http = httpRouter();

/** Compare in constant time so the secret cannot be guessed a byte at a time. */
function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided || provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

http.route({
  path: "/telegram",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const expected: string | null = await ctx.runQuery(internal.secrets.get, {
      name: "TELEGRAM_WEBHOOK_SECRET",
    });
    if (!expected) {
      console.error("No Telegram webhook secret is set; refusing all updates");
      return new Response("not configured", { status: 503 });
    }

    const provided = request.headers.get("x-telegram-bot-api-secret-token");
    if (!secretMatches(provided, expected)) {
      return new Response("forbidden", { status: 403 });
    }

    let update: TelegramUpdate;
    try {
      update = (await request.json()) as TelegramUpdate;
    } catch {
      return new Response("bad request", { status: 400 });
    }

    const inbound = parseUpdate(update);

    // Anything that is not a text message from a human is acknowledged and
    // ignored. Returning 200 stops Telegram retrying something we will never
    // handle.
    if (!inbound) return new Response("ok", { status: 200 });

    // A tap on an approval button. The mutation checks the tapper is the owner;
    // clearing the button's spinner can wait until after the 200.
    if ("callbackId" in inbound) {
      const note: string = await ctx.runMutation(internal.approvals.answerFromTelegram, {
        senderId: inbound.senderId,
        data: inbound.data,
      });
      await ctx.scheduler.runAfter(0, internal.approvals.acknowledgeTap, { callbackId: inbound.callbackId, note });
      return new Response("ok", { status: 200 });
    }

    await ctx.runMutation(internal.ingest.receive, {
      chatId: inbound.chatId,
      senderId: inbound.senderId,
      text: inbound.text,
      title: inbound.title,
      media: inbound.media,
    });

    return new Response("ok", { status: 200 });
  }),
});

/** Assistant's tools for Codex turns. See mcp.ts. */
http.route({ path: "/mcp", method: "POST", handler: mcp });

/** Cheap liveness check: curl the .site domain to confirm a deploy landed. */
http.route({
  path: "/health",
  method: "GET",
  handler: httpAction(async () => {
    return new Response(JSON.stringify({ ok: true, service: "perry" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }),
});

export default http;
