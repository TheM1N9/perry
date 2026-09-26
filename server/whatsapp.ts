import { existsSync, mkdirSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { HOME } from "../runner/home";
import type { Runtime } from "./runtime";

/**
 * WhatsApp, as a linked device: Baileys speaks the WhatsApp Web protocol from
 * this process, so no public URL is needed and nothing listens on the internet
 * for it, as with Telegram's long polling. The way OpenClaw does it
 * (src/web/session.ts), cut to one owner and one account.
 *
 * The dashboard asks to link (convex/whatsapp.ts, whatsappLink); this shows a
 * QR, or a code to type on the phone, until it is linked, then keeps the
 * connection: reconnecting with backoff, forcing one when it goes quiet, and
 * stopping for good when the phone unlinks it. What arrives from the owner
 * goes to whatsapp.receive; what Perry says waits in whatsappOutbox and is
 * sent from here, in order and unhurried.
 *
 * WhatsApp does not allow automating an account and may ban the number; the
 * owner chose to take that on. Talking only to the owner, never first to a
 * stranger and never in bursts, is what keeps the risk down.
 */

const AUTH_DIR = join(HOME, "whatsapp", "auth");
const MEDIA_LIMIT = 20 * 1024 * 1024;
/** No event for this long and the connection is presumed dead (OpenClaw's watchdog). */
const QUIET_MS = 30 * 60_000;
/**
 * How long a QR or code keeps being refreshed with nobody using it. WhatsApp
 * shows a QR for a minute, then new ones every 20 seconds, then closes the
 * connection; like WhatsApp Web, this starts a new one at once each time,
 * until the window runs out and the dashboard offers a new code instead.
 */
const LINK_WINDOW_MS = Number(process.env.PERRY_WHATSAPP_LINK_MINUTES ?? 10) * 60_000;
/** WhatsApp asks for a restart right after a phone links (DisconnectReason.restartRequired). */
const RESTART_REQUIRED = 515;
/** A pause between messages, so a long reply does not arrive as a burst. */
const PACE_MS = 900;
/**
 * In the owner's own "Message yourself" chat Perry writes as them, so its
 * messages start with this: they can tell which are Perry's, and so can this,
 * however soon WhatsApp echoes one back.
 */
export const SELF_MARK = "🤖 ";

/** The slice of a Baileys socket this uses, so a test can stand in for WhatsApp (PERRY_WHATSAPP_DRIVER). */
export type Socket = {
  ev: { on(event: string, listener: (data: any) => void): void };
  user?: { id: string; lid?: string; name?: string };
  sendMessage(jid: string, content: object): Promise<unknown>;
  sendPresenceUpdate(presence: "composing" | "paused" | "available", jid?: string): Promise<void>;
  requestPairingCode(phone: string): Promise<string>;
  readMessages?(keys: object[]): Promise<void>;
  logout(): Promise<void>;
  end(error?: Error): void;
};
export type Driver = {
  connect(options: { authDir: string; onCreds?: () => void }): Promise<Socket>;
  download(message: object, socket: Socket): Promise<Buffer>;
  /** The reason a connection closed: logged out for good, or worth reconnecting. */
  loggedOut(update: { lastDisconnect?: { error?: unknown } }): boolean;
  qrPng(qr: string): Promise<string>;
};

async function baileysDriver(): Promise<Driver> {
  const baileys = await import("baileys");
  const QR = await import("qrcode");
  const makeSocket = (baileys as unknown as { default?: typeof baileys.makeWASocket }).default ?? baileys.makeWASocket;
  const quiet = { level: "silent", child: () => quiet, trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} };
  return {
    async connect({ authDir }) {
      const { state, saveCreds } = await baileys.useMultiFileAuthState(authDir);
      const { version } = await baileys.fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
      const socket = makeSocket({
        auth: state,
        ...(version ? { version } : {}),
        browser: baileys.Browsers.appropriate("Perry"),
        logger: quiet as never,
        printQRInTerminal: false,
        syncFullHistory: false,
        markOnlineOnConnect: false,
      });
      socket.ev.on("creds.update", saveCreds);
      return socket as unknown as Socket;
    },
    async download(message, socket) {
      return await baileys.downloadMediaMessage(message as never, "buffer", {}, { logger: quiet as never, reuploadRequest: (socket as unknown as { updateMediaMessage: never }).updateMediaMessage }) as Buffer;
    },
    loggedOut(update) {
      const code = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      return code === baileys.DisconnectReason.loggedOut;
    },
    async qrPng(qr) {
      return await QR.toDataURL(qr, { margin: 1, width: 320 });
    },
  };
}

async function loadDriver(): Promise<Driver> {
  const custom = process.env.PERRY_WHATSAPP_DRIVER;
  if (custom) return (await import(/* webpackIgnore: true */ /*turbopackIgnore: true*/ pathToFileURL(custom).href)).default as Driver;
  return await baileysDriver();
}

type Link = { mode: "self" | "separate"; wanted: boolean; phone?: string; status: string; me?: string } | null;
type Outgoing = { _id: string; to: string; kind: "text" | "typing" | "file"; text?: string; file?: { storageId?: string; localPath?: string; fileName: string; contentType: string } };

const bare = (jid?: string | null) => (jid ?? "").replace(/:\d+(?=@)/, "");
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
});

/** The words of a message, whatever kind it is; media captions count. */
function textOf(message: Record<string, any> | undefined): string {
  if (!message) return "";
  const inner = message.ephemeralMessage?.message ?? message.viewOnceMessage?.message ?? message.viewOnceMessageV2?.message ?? message;
  return (inner.conversation ?? inner.extendedTextMessage?.text ?? inner.imageMessage?.caption ?? inner.videoMessage?.caption ?? inner.documentMessage?.caption ?? "").trim();
}

function mediaOf(message: Record<string, any> | undefined): { kind: string; fileName: string; contentType: string } | null {
  if (!message) return null;
  const inner = message.ephemeralMessage?.message ?? message.viewOnceMessage?.message ?? message;
  if (inner.imageMessage) return { kind: "image", fileName: "photo.jpg", contentType: inner.imageMessage.mimetype ?? "image/jpeg" };
  if (inner.videoMessage) return { kind: "video", fileName: "video.mp4", contentType: inner.videoMessage.mimetype ?? "video/mp4" };
  // A voice note is audio with ptt set; it comes as Opus in Ogg.
  if (inner.audioMessage) return { kind: "audio", fileName: inner.audioMessage.ptt ? "voice-note.ogg" : "audio.ogg", contentType: (inner.audioMessage.mimetype ?? "audio/ogg; codecs=opus").split(";")[0] };
  if (inner.documentMessage) return { kind: "document", fileName: inner.documentMessage.fileName ?? "document", contentType: inner.documentMessage.mimetype ?? "application/octet-stream" };
  if (inner.stickerMessage) return { kind: "sticker", fileName: "sticker.webp", contentType: "image/webp" };
  return null;
}

/** Start the WhatsApp link; returns a function that stops it. */
export function runWhatsApp(runtime: Runtime): () => void {
  const stop = new AbortController();
  const internal = { internal: true } as const;
  const report = (status: string, extra: object = {}) =>
    runtime.runMutation("whatsapp:report", { status, ...extra }, internal).catch((error) => console.error(`[perry] WhatsApp: could not report ${status}: ${String(error)}`));
  const link = async (): Promise<Link> => (await runtime.runQuery("whatsapp:link", {}, internal)).value as Link;

  let socket: Socket | null = null;
  let connected = false;
  /** When the current QR or code was first shown, while nobody has linked yet. */
  let linkingSince: number | null = null;
  /** How the owner linked: in their own chat, Perry's messages carry SELF_MARK. */
  let mode: "self" | "separate" = "separate";
  /** Ids of what Perry sent, so its own messages in the self-chat are not taken as the owner's. */
  const sentIds = new Set<string>();
  /** Message ids already handled; WhatsApp can deliver one twice across a reconnect. */
  const seen = new Map<string, number>();
  let lastEvent = Date.now();
  let flushing = false;
  let dropped: (() => void) | null = null;

  const remember = (map: Map<string, number>, id: string) => {
    map.set(id, Date.now());
    if (map.size > 2000) for (const [key, at] of map) if (Date.now() - at > 20 * 60_000 || map.size > 2000) map.delete(key); else break;
  };

  async function flush() {
    if (flushing || !socket || !connected) return;
    flushing = true;
    try {
      for (;;) {
        const rows = (await runtime.runQuery("whatsapp:pending", {}, internal)).value as Outgoing[];
        if (!rows.length || !socket || !connected) break;
        for (const row of rows) {
          let error: string | undefined;
          try {
            if (row.kind === "typing") {
              await socket.sendPresenceUpdate("composing", row.to);
            } else if (row.kind === "text" && row.text) {
              const text = mode === "self" ? `${SELF_MARK}${row.text}` : row.text;
              const sent = await socket.sendMessage(row.to, { text }) as { key?: { id?: string } } | undefined;
              if (sent?.key?.id) sentIds.add(sent.key.id);
              await socket.sendPresenceUpdate("paused", row.to).catch(() => {});
              await sleep(PACE_MS, stop.signal);
            } else if (row.kind === "file" && row.file) {
              const path = row.file.storageId ? join(HOME, "storage", row.file.storageId) : row.file.localPath;
              if (!path || !existsSync(path)) throw new Error(`${row.file.fileName} is not on this computer`);
              const bytes = await readFile(path);
              if (bytes.byteLength > 64 * 1024 * 1024) throw new Error(`${row.file.fileName} is too big for WhatsApp`);
              const type = row.file.contentType;
              const content = type.startsWith("image/") && !type.includes("svg") ? { image: bytes, mimetype: type }
                : type.startsWith("video/") ? { video: bytes, mimetype: type }
                  : type.startsWith("audio/") ? { audio: bytes, mimetype: type }
                    : { document: bytes, mimetype: type, fileName: row.file.fileName };
              const sent = await socket.sendMessage(row.to, content) as { key?: { id?: string } } | undefined;
              if (sent?.key?.id) sentIds.add(sent.key.id);
              await sleep(PACE_MS, stop.signal);
            }
          } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause);
            console.error(`[perry] WhatsApp: could not send: ${error}`);
          }
          await runtime.runMutation("whatsapp:sent", { id: row._id, ...(error ? { error } : {}) }, internal);
          if (error && !connected) return;
        }
      }
    } finally {
      flushing = false;
    }
  }

  // Something new in the outbox: send it now rather than on the next tick.
  const onChange = (tables: string[]) => { if (tables.includes("whatsappOutbox")) void flush(); };
  runtime.events.on("change", onChange);

  async function handle(message: Record<string, any>, mode: "self" | "separate") {
    const key = message.key ?? {};
    const id = key.id as string | undefined;
    const remote = key.remoteJid as string | undefined;
    if (!id || !remote || seen.has(id) || sentIds.has(id)) return;
    remember(seen, id);
    // Groups, broadcasts and status updates are never Perry's to answer.
    if (remote.endsWith("@g.us") || remote.endsWith("@broadcast") || remote === "status@broadcast" || remote.endsWith("@newsletter")) return;
    const me = socket?.user;
    const mine = [bare(me?.id), bare(me?.lid)].filter(Boolean);
    let chatId: string;
    if (mode === "self") {
      // Only the owner's "Message yourself" chat, and only what they typed there.
      if (!key.fromMe || !mine.includes(bare(remote))) return;
      if (textOf(message.message).startsWith(SELF_MARK.trim())) return;
      chatId = bare(me?.id);
    } else {
      if (key.fromMe) return;
      // A chat can be addressed by a hidden id (@lid); the phone number is kept when WhatsApp gives it.
      chatId = bare(remote.endsWith("@lid") && key.remoteJidAlt ? key.remoteJidAlt : remote);
    }
    const text = textOf(message.message);
    const media = mediaOf(message.message);
    if (!text && !media) return;
    const files: Array<{ base64: string; fileName: string; contentType: string }> = [];
    let note = "";
    if (media && socket) {
      try {
        const bytes = await (await driver).download(message, socket);
        if (bytes.byteLength > MEDIA_LIMIT) note = `\n\n(${media.fileName} was too big to download: WhatsApp files up to 20 MB.)`;
        else files.push({ base64: bytes.toString("base64"), fileName: media.fileName, contentType: media.contentType });
      } catch (error) {
        note = `\n\n(${media.fileName} could not be downloaded from WhatsApp.)`;
        console.error(`[perry] WhatsApp: could not download a file: ${String(error)}`);
      }
    }
    if (mode === "separate" && socket?.readMessages) await socket.readMessages([key]).catch(() => {});
    await runtime.runAction("whatsapp:receive", {
      chatId,
      text: `${text}${note}`.trim(),
      ...(message.pushName ? { name: String(message.pushName) } : {}),
      ...(files.length ? { media: files } : {}),
    }, internal).catch((error) => console.error(`[perry] WhatsApp message failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  const driver = loadDriver();

  void (async () => {
    let failures = 0;
    while (!stop.signal.aborted) {
      const wanted = await link().catch(() => null);
      if (!wanted?.wanted) {
        linkingSince = null;
        // Not linked, or unlinked from the dashboard: forget the device, then wait to be asked.
        if (socket) { await socket.logout().catch(() => {}); socket.end(); socket = null; connected = false; }
        if (existsSync(AUTH_DIR) && wanted && !wanted.wanted) rmSync(AUTH_DIR, { recursive: true, force: true });
        await sleep(3_000, stop.signal);
        continue;
      }
      mkdirSync(AUTH_DIR, { recursive: true });
      mode = wanted.mode;
      type Ending = "logged-out" | "dropped" | "unlinked" | "refresh" | "restart";
      let closed: (reason: Ending) => void = () => {};
      const ended = new Promise<Ending>((resolve) => { closed = resolve; });
      try {
        const d = await driver;
        const current = await d.connect({ authDir: AUTH_DIR });
        socket = current;
        let asked = false;
        let opened = false;
        let showing = false;
        lastEvent = Date.now();
        current.ev.on("connection.update", (update: { connection?: string; qr?: string; lastDisconnect?: { error?: unknown } }) => {
          lastEvent = Date.now();
          if (update.qr) {
            showing = true;
            linkingSince ??= Date.now();
            if (wanted.phone && !asked) {
              // Linking with a code typed on the phone instead of scanning.
              asked = true;
              void current.requestPairingCode(wanted.phone)
                .then((code) => report("code", { code: code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code }))
                .catch((error) => report("qr", { error: `Could not get a code (${String(error)}); scan the QR instead.` }));
            } else if (!wanted.phone) {
              void d.qrPng(update.qr).then((png) => report("qr", { qr: png }));
            }
          }
          if (update.connection === "open") {
            connected = true;
            opened = true;
            linkingSince = null;
            failures = 0;
            console.log("[perry] WhatsApp: connected");
            void report("connected", { me: current.user?.id ?? "" }).then(() => flush());
          }
          if (update.connection === "close") {
            connected = false;
            const code = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
            // A QR or code that ran out, and the restart after linking, are not failures: WhatsApp expects a new connection at once.
            closed(d.loggedOut(update) ? "logged-out" : code === RESTART_REQUIRED ? "restart" : !opened && showing ? "refresh" : "dropped");
          }
        });
        current.ev.on("messages.upsert", (event: { type: string; messages: Array<Record<string, any>> }) => {
          lastEvent = Date.now();
          // "append" is history caught up after a reconnect: read, not answered (as OpenClaw does).
          if (event.type !== "notify") return;
          for (const message of event.messages) void handle(message, wanted.mode);
        });
        dropped = () => closed("dropped");
        // Unlinked from the dashboard, or quiet for too long: end this connection.
        const watch = setInterval(() => {
          void link().then((now) => { if (!now?.wanted) closed("unlinked"); }).catch(() => {});
          if (connected && Date.now() - lastEvent > QUIET_MS) { console.warn("[perry] WhatsApp: quiet for too long; reconnecting"); closed("dropped"); }
        }, 5_000);
        const reason = await Promise.race([ended, new Promise<"unlinked">((resolve) => stop.signal.addEventListener("abort", () => resolve("unlinked"), { once: true }))]);
        clearInterval(watch);
        dropped = null;
        connected = false;
        if (reason === "logged-out") {
          // Unlinked on the phone: the saved session is dead, and linking starts again from the dashboard.
          console.warn("[perry] WhatsApp: logged out; link again from the dashboard");
          current.end();
          socket = null;
          rmSync(AUTH_DIR, { recursive: true, force: true });
          await report("logged-out", { error: "WhatsApp was unlinked on the phone. Link it again to keep using it." });
          await runtime.runMutation("whatsapp:stop", {}, internal).catch(() => {});
          continue;
        }
        if (reason === "unlinked") continue;
        current.end();
        socket = null;
        if (reason === "restart") {
          // Just linked: finish on a new connection, as WhatsApp asks.
          await report("starting");
          await sleep(300, stop.signal);
          continue;
        }
        if (reason === "refresh") {
          if (linkingSince !== null && Date.now() - linkingSince > LINK_WINDOW_MS) {
            // Nobody linked it in time: stop making codes, as WhatsApp Web does, until the owner asks again.
            linkingSince = null;
            rmSync(AUTH_DIR, { recursive: true, force: true });
            await report("expired", { error: "The code ran out before it was used." });
            await runtime.runMutation("whatsapp:stop", {}, internal).catch(() => {});
            continue;
          }
          // The code on the dashboard stays until the next one replaces it, a moment from now.
          await sleep(300, stop.signal);
          continue;
        }
        failures += 1;
        // Back off, 2 s up to 60 s, with jitter (OpenClaw's reconnect policy, without its give-up).
        const wait = Math.min(60_000, 2_000 * 1.8 ** Math.min(failures, 8)) * (0.75 + Math.random() * 0.5);
        await report("disconnected", { error: `Reconnecting (try ${failures}).` });
        await sleep(wait, stop.signal);
      } catch (error) {
        connected = false;
        socket = null;
        failures += 1;
        console.error(`[perry] WhatsApp: ${error instanceof Error ? error.message : String(error)}; trying again shortly`);
        await report("disconnected", { error: error instanceof Error ? error.message : String(error) });
        await sleep(Math.min(60_000, 5_000 * failures), stop.signal);
      }
    }
  })();

  return () => {
    stop.abort();
    dropped?.();
    runtime.events.off("change", onChange);
    socket?.end();
  };
}
