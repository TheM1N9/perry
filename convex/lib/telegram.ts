/**
 * Minimal Telegram Bot API client.
 *
 * Deliberately not grammY: Assistant never polls and never runs a handler loop.
 * Inbound arrives as an HTTP action, outbound is one POST. A framework here
 * would be weight without leverage.
 */

import { balanceFences, toTelegramHtml } from "./telegramFormat";

/**
 * TELEGRAM_API_BASE points the bot at a stand-in for the Bot API, which is how
 * the end-to-end test sees what would have been sent. Unset in normal use.
 */
const api = () => (process.env.TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/+$/, "");

/** Telegram rejects messages over 4096 chars. */
const MAX_MESSAGE_LENGTH = 4096;

/** A caption is capped at 1024 characters; a longer reply goes as its own message. */
export const CAPTION_LIMIT = 1024;

/** Bots may upload files up to 50 MB, and download ones up to 20 MB. */
export const UPLOAD_LIMIT = 50 * 1024 * 1024;
export const DOWNLOAD_LIMIT = 20 * 1024 * 1024;

/** Photos up to 10 MB are shown as photos; a bigger one goes as a document. */
const PHOTO_LIMIT = 10 * 1024 * 1024;

/** Told to slow down, a call waits as long as Telegram asks: twice at most, and never for long. */
const MAX_RETRIES = 2;
const MAX_RETRY_AFTER_S = 30;

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

/** Telegram refused a call. The code and description let callers tell refusals apart. */
export class TelegramError extends Error {
  constructor(method: string, readonly code: number, readonly description: string) {
    super(`Telegram ${method} failed: ${description}`);
  }
}

// Adapted from vercel/eve (Apache-2.0): packages/eve/src/public/channels/telegram/api.ts
/** A gateway's error page is not JSON; keep its text rather than throw on it. */
async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

type ApiResponse = {
  ok?: boolean;
  description?: string;
  result?: unknown;
  error_code?: number;
  parameters?: { retry_after?: number };
};

async function call(
  token: string | null,
  method: string,
  body: object | FormData,
): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${api()}/bot${requireToken(token)}/${method}`, body instanceof FormData
      ? { method: "POST", body }
      : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const parsed = await parseResponseBody(res);
    const json: ApiResponse = parsed && typeof parsed === "object" ? parsed : { description: String(parsed ?? res.status) };
    if (json.ok) return json.result;
    const code = json.error_code ?? res.status;
    const wait = json.parameters?.retry_after;
    if (code === 429 && wait !== undefined && wait <= MAX_RETRY_AFTER_S && attempt < MAX_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
      continue;
    }
    throw new TelegramError(method, code, json.description ?? String(res.status));
  }
}

/** Telegram refuses HTML it cannot parse. The words matter more than the markup, so they go again as plain text. */
function unparsable(error: unknown): boolean {
  return error instanceof TelegramError && error.code === 400 && /can't parse entities/i.test(error.description);
}

async function withHtml<T>(send: (html: boolean) => Promise<T>): Promise<T> {
  try {
    return await send(true);
  } catch (error) {
    if (!unparsable(error)) throw error;
    return await send(false);
  }
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

/**
 * Send text, split to fit. A reply the agent wrote is Markdown and goes as
 * Telegram HTML: split first, then each piece formatted on its own.
 */
export async function sendMessage(
  token: string | null,
  chatId: string,
  text: string,
  options: { markdown?: boolean } = {},
): Promise<void> {
  const body = text.trim();
  if (body.length === 0) return;

  const chunks = options.markdown ? balanceFences(chunkMessage(body)) : chunkMessage(body);
  for (const chunk of chunks) {
    await withHtml((html) => call(token, "sendMessage", {
      chat_id: chatId,
      text: html && options.markdown ? toTelegramHtml(chunk) : chunk,
      ...(html && options.markdown ? { parse_mode: "HTML" } : {}),
      link_preview_options: { is_disabled: true },
    }));
  }
}

/**
 * A reply that grows: the first call sends a message, later calls edit it.
 * Telegram caps a message at 4096 characters, so a streamed preview shows the
 * first chunk and the final delivery sends the rest as further messages.
 */
export async function sendDraft(token: string | null, chatId: string, text: string): Promise<number> {
  const result = await call(token, "sendMessage", {
    chat_id: chatId,
    text: chunkMessage(text.trim() || "…")[0],
    link_preview_options: { is_disabled: true },
  }) as { message_id: number };
  return result.message_id;
}

export async function editDraft(token: string | null, chatId: string, messageId: number, text: string): Promise<void> {
  try {
    await call(token, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: chunkMessage(text.trim() || "…")[0],
      link_preview_options: { is_disabled: true },
    });
  } catch (error) {
    // Editing to the same text is an error on Telegram's side, and harmless.
    if (!String(error).includes("message is not modified")) throw error;
  }
}

/**
 * Finish a streamed reply: the draft, plain while it grew, becomes the first
 * chunk formatted, and the rest follow as new messages.
 */
export async function finishDraft(token: string | null, chatId: string, messageId: number, text: string): Promise<void> {
  const [first, ...rest] = balanceFences(chunkMessage(text.trim() || "…"));
  await withHtml(async (html) => {
    try {
      await call(token, "editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: html ? toTelegramHtml(first) : first,
        ...(html ? { parse_mode: "HTML" } : {}),
        link_preview_options: { is_disabled: true },
      });
    } catch (error) {
      if (!String(error).includes("message is not modified")) throw error;
    }
  });
  for (const chunk of rest) await sendMessage(token, chatId, chunk, { markdown: true });
}

/** One row of inline buttons under a message. `data` comes back in a callback_query, at most 64 bytes. */
export type Buttons = Array<Array<{ text: string; data: string }>>;

const keyboard = (buttons: Buttons) => ({
  inline_keyboard: buttons.map((row) => row.map((button) => ({ text: button.text, callback_data: button.data }))),
});

/** A message with buttons under it, such as an approval request. Returns its id, for editing later. */
export async function sendButtons(token: string | null, chatId: string, text: string, buttons: Buttons): Promise<number> {
  const result = await call(token, "sendMessage", {
    chat_id: chatId,
    text: chunkMessage(text.trim())[0],
    reply_markup: keyboard(buttons),
    link_preview_options: { is_disabled: true },
  }) as { message_id: number };
  return result.message_id;
}

// Adapted from vercel/eve (Apache-2.0): packages/eve/src/public/channels/telegram/api.ts
/** Rewrite a message and replace its buttons; no buttons removes them. */
export async function editButtons(token: string | null, chatId: string, messageId: number, text: string, buttons: Buttons = []): Promise<void> {
  try {
    await call(token, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: chunkMessage(text.trim())[0],
      reply_markup: keyboard(buttons),
      link_preview_options: { is_disabled: true },
    });
  } catch (error) {
    if (!String(error).includes("message is not modified")) throw error;
  }
}

// Adapted from vercel/eve (Apache-2.0): packages/eve/src/public/channels/telegram/api.ts
/** Clear the spinner on a tapped button, with a short note shown to whoever tapped it. */
export async function answerCallback(token: string | null, callbackQueryId: string, text?: string): Promise<void> {
  await call(token, "answerCallbackQuery", { callback_query_id: callbackQueryId, ...(text ? { text } : {}) });
}

/** Remove a message the bot sent. Best effort: Telegram keeps messages older than 48 hours. */
export async function deleteMessage(token: string | null, chatId: string, messageId: number): Promise<void> {
  try {
    await call(token, "deleteMessage", { chat_id: chatId, message_id: messageId });
  } catch (error) {
    console.error(`Could not delete a Telegram message: ${String(error)}`);
  }
}

/** The Bot API method, and its file field, that shows this kind of file best. */
function methodFor(contentType: string, size: number): [method: string, field: string] {
  const type = contentType.toLowerCase().split(";")[0].trim();
  if (/^image\/(png|jpe?g|webp)$/.test(type) && size <= PHOTO_LIMIT) return ["sendPhoto", "photo"];
  if (type === "image/gif") return ["sendAnimation", "animation"];
  if (type === "video/mp4") return ["sendVideo", "video"];
  if (/^audio\/(mpeg|mp3|mp4|m4a|x-m4a)$/.test(type)) return ["sendAudio", "audio"];
  if (/^audio\/(ogg|opus)$/.test(type)) return ["sendVoice", "voice"];
  return ["sendDocument", "document"];
}

/**
 * Upload a file with the method that shows it best: a photo, animation, video,
 * audio or voice note, else a document. Telegram is pickier about those (a
 * photo's dimensions, a voice note's codec) than about documents, so one it
 * refuses goes again as a document. The caption is Markdown, sent as HTML.
 */
export async function sendFile(
  token: string | null,
  chatId: string,
  file: { blob: Blob; fileName: string; contentType: string; caption?: string },
): Promise<void> {
  if (file.blob.size > UPLOAD_LIMIT) throw new Error(`${file.fileName} is over Telegram's 50 MB limit for bots.`);
  // Read once: a stored file arrives as a streaming Blob, which a retry (after
  // a 429, or as a document) could not read again.
  const bytes = new Blob([await file.blob.arrayBuffer()], { type: file.contentType });
  const send = (method: string, field: string) => withHtml(async (html) => {
    const form = new FormData();
    form.set("chat_id", chatId);
    form.set(field, bytes, file.fileName);
    if (file.caption) {
      form.set("caption", html ? toTelegramHtml(file.caption) : file.caption);
      if (html) form.set("parse_mode", "HTML");
    }
    await call(token, method, form);
  });
  const [method, field] = methodFor(file.contentType, file.blob.size);
  try {
    await send(method, field);
  } catch (error) {
    if (method === "sendDocument" || !(error instanceof TelegramError) || error.code !== 400) throw error;
    await send("sendDocument", "document");
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
  callback_query?: TelegramCallbackQuery;
}

/** A tap on an inline button. `from` is who tapped; `message` is the message the button was on. */
export interface TelegramCallbackQuery {
  id: string;
  from: { id: number; is_bot: boolean };
  data?: string;
  message?: { message_id: number; chat: { id: number } };
}

type TelegramFile = { file_id: string; file_size?: number; file_name?: string; mime_type?: string };

export interface TelegramMessage {
  message_id: number;
  date: number;
  text?: string;
  caption?: string;
  photo?: Array<TelegramFile & { width: number; height: number }>;
  voice?: TelegramFile;
  audio?: TelegramFile;
  video?: TelegramFile;
  video_note?: TelegramFile;
  document?: TelegramFile;
  chat: { id: number; type: string; title?: string; username?: string };
  from?: { id: number; is_bot: boolean; first_name?: string; username?: string };
}

/** A file attached to a Telegram message, fetched later with getFile. Size is as Telegram reports it, when it does. */
export type InboundMedia = { fileId: string; fileName: string; contentType: string; size?: number };

export interface InboundMessage {
  chatId: string;
  senderId: string;
  text: string;
  title?: string;
  media: InboundMedia[];
}

/**
 * A button tap. The sender id is Telegram's word for who tapped, which the
 * webhook secret vouches for; it still has to match the stored owner.
 */
export interface InboundCallback {
  callbackId: string;
  senderId: string;
  data: string;
}

function parseCallback(query: TelegramCallbackQuery): InboundCallback | null {
  if (query.from?.is_bot || !query.data) return null;
  return { callbackId: query.id, senderId: String(query.from.id), data: query.data };
}

/** Photos come in several sizes; take the largest. Everything else is one file. */
function mediaOf(message: TelegramMessage): InboundMedia[] {
  const media: InboundMedia[] = [];
  const add = (file: TelegramFile, fileName: string, contentType: string) =>
    media.push({ fileId: file.file_id, fileName, contentType, ...(file.file_size ? { size: file.file_size } : {}) });
  const photo = message.photo?.at(-1);
  if (photo) add(photo, "photo.jpg", "image/jpeg");
  if (message.voice) add(message.voice, "voice-note.ogg", message.voice.mime_type ?? "audio/ogg");
  if (message.audio) add(message.audio, message.audio.file_name ?? "audio", message.audio.mime_type ?? "audio/mpeg");
  if (message.video) add(message.video, message.video.file_name ?? "video.mp4", message.video.mime_type ?? "video/mp4");
  if (message.video_note) add(message.video_note, "video-note.mp4", "video/mp4");
  if (message.document) add(message.document, message.document.file_name ?? "document", message.document.mime_type ?? "application/octet-stream");
  return media;
}

/**
 * Download a file the owner sent. The Bot API serves files up to 20 MB this
 * way; getFile answers with a path that is valid for about an hour.
 */
export async function downloadFile(token: string | null, fileId: string): Promise<ArrayBuffer> {
  const file = await call(token, "getFile", { file_id: fileId }) as { file_path?: string };
  if (!file.file_path) throw new Error("Telegram did not return a path for that file.");
  const response = await fetch(`${api()}/file/bot${requireToken(token)}/${file.file_path}`);
  if (!response.ok) throw new Error(`Could not download a file from Telegram (${response.status}).`);
  return await response.arrayBuffer();
}

/**
 * Narrow a raw update to the two shapes Assistant handles: a message from a
 * human, with text, media, or both; or a tap on one of its buttons. Anything
 * else returns null and is acknowledged without work.
 */
export function parseUpdate(update: TelegramUpdate): InboundMessage | InboundCallback | null {
  if (update.callback_query) return parseCallback(update.callback_query);
  const message = update.message ?? update.edited_message;
  if (!message) return null;
  if (message.from?.is_bot) return null;

  const text = (message.text ?? message.caption ?? "").trim();
  const media = mediaOf(message);
  if (text.length === 0 && media.length === 0) return null;

  return {
    chatId: String(message.chat.id),
    senderId: String(message.from?.id ?? message.chat.id),
    text,
    title: message.chat.title ?? message.from?.username,
    media,
  };
}
