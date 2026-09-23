/**
 * Minimal Telegram Bot API client.
 *
 * Deliberately not grammY: Assistant never polls and never runs a handler loop.
 * Inbound arrives as an HTTP action, outbound is one POST. A framework here
 * would be weight without leverage.
 */

const API = "https://api.telegram.org";

/** Telegram rejects messages over 4096 chars. */
const MAX_MESSAGE_LENGTH = 4096;

/**
 * The token is passed in rather than read from the environment, because it now
 * lives in the database where the dashboard can change it.
 */
function requireToken(token: string | null): string {
  if (!token) {
    throw new Error(
      "No Telegram bot token. Set one on the Keys page, or run: " +
        "pnpm exec convex env set TELEGRAM_BOT_TOKEN <token>",
    );
  }
  return token;
}

async function call(
  token: string | null,
  method: string,
  body: unknown,
): Promise<unknown> {
  const res = await fetch(`${API}/bot${requireToken(token)}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { ok: boolean; description?: string; result?: unknown };
  if (!json.ok) {
    throw new Error(`Telegram ${method} failed: ${json.description ?? res.status}`);
  }
  return json.result;
}

/**
 * Split on paragraph, then line, then hard character boundaries, so long
 * answers arrive as readable chunks instead of one truncated wall.
 */
export function chunkMessage(text: string, limit = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let rest = text;

  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = window.lastIndexOf("\n\n");
    if (cut < limit * 0.5) cut = window.lastIndexOf("\n");
    if (cut < limit * 0.5) cut = window.lastIndexOf(" ");
    if (cut <= 0) cut = limit;

    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }

  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

export async function sendMessage(
  token: string | null,
  chatId: string,
  text: string,
): Promise<void> {
  const body = text.trim();
  if (body.length === 0) return;

  for (const chunk of chunkMessage(body)) {
    await call(token, "sendMessage", {
      chat_id: chatId,
      text: chunk,
      link_preview_options: { is_disabled: true },
    });
  }
}

/** The three dots in the chat while the model is thinking. */
export async function sendTyping(
  token: string | null,
  chatId: string,
): Promise<void> {
  try {
    await call(token, "sendChatAction", { chat_id: chatId, action: "typing" });
  } catch {
    // Cosmetic only. Never fail a turn because the typing indicator failed.
  }
}

// --- Inbound update shapes. Only the fields Assistant actually reads. ---

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  text?: string;
  caption?: string;
  chat: { id: number; type: string; title?: string; username?: string };
  from?: { id: number; is_bot: boolean; first_name?: string; username?: string };
}

export interface InboundMessage {
  chatId: string;
  senderId: string;
  text: string;
  title?: string;
}

/**
 * Narrow a raw update to the one shape Assistant handles: a text message from a
 * human. Anything else returns null and is acknowledged without work.
 */
export function parseUpdate(update: TelegramUpdate): InboundMessage | null {
  const message = update.message ?? update.edited_message;
  if (!message) return null;
  if (message.from?.is_bot) return null;

  const text = (message.text ?? message.caption ?? "").trim();
  if (text.length === 0) return null;

  return {
    chatId: String(message.chat.id),
    senderId: String(message.from?.id ?? message.chat.id),
    text,
    title: message.chat.title ?? message.from?.username,
  };
}
