import { existsSync, mkdirSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { HOME } from "../runner/home";
import type { Runtime } from "./runtime";
import { setTimeout as delay } from "node:timers/promises";

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
 * owner chose to take that on. Never in bursts, never first to a stranger
 * without the owner's yes, keeps the risk down.
 *
 * Other people (convex/contacts.ts): what they write, in a direct chat or a
 * group, goes to whatsapp.receiveOther with who wrote it and whether Perry was
 * mentioned; Perry answers only whom the owner allowed. Linked as the owner,
 * everyone else's chats are the owner's, so there Perry speaks only when
 * called by name. WhatsApp's address book and groups are passed on too, so
 * "message Datta" finds Datta.
 */

const AUTH_DIR = join(HOME, "whatsapp", "auth");
const MEDIA_LIMIT = 20 * 1024 * 1024;
/**
 * Nothing at all from WhatsApp's servers for this long and the connection is
 * presumed dead (OpenClaw's watchdog). Baileys pings every 30 seconds and every
 * answer counts, so this fires only on a socket that has gone silent without
 * closing, never on an account where nobody happens to write for a while.
 */
const QUIET_MS = Number(process.env.PERRY_WHATSAPP_QUIET_MS ?? 30 * 60_000);
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
  ev: { on(event: string, listener: (data: any) => void): void; off(event: string, listener: (data: any) => void): void };
  /** The WebSocket underneath, which emits "frame" for everything WhatsApp's servers send, the keep-alive answers included. */
  ws?: { on(event: string, listener: (...args: any[]) => void): unknown; off(event: string, listener: (...args: any[]) => void): unknown };
  user?: { id: string; lid?: string; name?: string };
  sendMessage(jid: string, content: object): Promise<unknown>;
  sendPresenceUpdate(presence: "composing" | "paused" | "available", jid?: string): Promise<void>;
  requestPairingCode(phone: string): Promise<string>;
  readMessages?(keys: object[]): Promise<void>;
  /** A group's name and members. */
  groupMetadata?(jid: string): Promise<{ subject?: string }>;
  /** Every group this account is in. */
  groupFetchAllParticipating?(): Promise<Record<string, { id: string; subject?: string }>>;
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
type Outgoing = { _id: string; to: string; kind: "text" | "typing" | "file" | "reaction"; text?: string; reaction?: { id: string; fromMe: boolean; remoteJid?: string; participant?: string; emoji: string }; file?: { storageId?: string; localPath?: string; fileName: string; contentType: string } };

const bare = (jid?: string | null) => (jid ?? "").replace(/:\d+(?=@)/, "");
const sleep = (ms: number, signal: AbortSignal) => delay(ms, undefined, { signal })
  .catch((error) => { if (!signal.aborted) throw error; });

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
export function runWhatsApp(runtime: Runtime): () => Promise<void> {
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
  const sentIds = new Map<string, number>();
  /** Message ids already handled; WhatsApp can deliver one twice across a reconnect. */
  const seen = new Map<string, number>();
  let lastEvent = Date.now();
  let flushing: Promise<void> | null = null;
  const incoming = new Set<Promise<unknown>>();
  const track = (work: Promise<unknown>) => {
    const pending = work.catch(error => console.error(`[perry] WhatsApp message failed: ${String(error)}`));
    incoming.add(pending);
    void pending.finally(() => incoming.delete(pending));
  };
  let dropped: (() => void) | null = null;

  const remember = (map: Map<string, number>, id: string) => {
    map.set(id, Date.now());
    if (map.size > 2000) for (const [key, at] of map) if (Date.now() - at > 20 * 60_000 || map.size > 2000) map.delete(key); else break;
  };

  function flush(): Promise<void> {
    if (flushing || !socket || !connected || stop.signal.aborted) return flushing ?? Promise.resolve();
    const current = socket;
    const sendingMode = mode;
    const isCurrent = () => socket === current && connected && !stop.signal.aborted;
    flushing = (async () => {
      for (;;) {
        const rows = (await runtime.runQuery("whatsapp:pending", {}, internal)).value as Outgoing[];
        if (!rows.length || !isCurrent()) break;
        for (const row of rows) {
          if (!isCurrent()) return;
          let error: string | undefined;
          try {
            if (row.kind === "typing") {
              await current.sendPresenceUpdate("composing", row.to);
            } else if (row.kind === "reaction" && row.reaction) {
              const { emoji, ...key } = row.reaction;
              const sent = await current.sendMessage(row.to, { react: { text: emoji, key: { ...key, remoteJid: key.remoteJid ?? row.to } } }) as { key?: { id?: string } } | undefined;
              if (sent?.key?.id) remember(sentIds, sent.key.id);
              if (isCurrent()) await current.sendPresenceUpdate("paused", row.to).catch(() => {});
            } else if (row.kind === "text" && row.text) {
              // Only in the owner's own chat, where it tells Perry's messages from theirs; to anyone else it writes as it is.
              const own = [bare(current.user?.id), bare(current.user?.lid)].filter(Boolean);
              const text = sendingMode === "self" && own.includes(bare(row.to)) ? `${SELF_MARK}${row.text}` : row.text;
              const sent = await current.sendMessage(row.to, { text }) as { key?: { id?: string } } | undefined;
              if (sent?.key?.id) {
                remember(sentIds, sent.key.id);
                await runtime.runMutation("reactions:record", { channel: "whatsapp", externalId: row.to, messageId: sent.key.id, text: row.text, isPerry: true, fromMe: true }, internal);
              }
              if (isCurrent()) await current.sendPresenceUpdate("paused", row.to).catch(() => {});
              await sleep(PACE_MS, stop.signal);
            } else if (row.kind === "file" && row.file) {
              const path = row.file.storageId ? join(HOME, "storage", row.file.storageId) : row.file.localPath;
              if (!path || !existsSync(path)) throw new Error(`${row.file.fileName} is not on this computer`);
              const bytes = await readFile(path);
              if (bytes.byteLength > 64 * 1024 * 1024) throw new Error(`${row.file.fileName} is too big for WhatsApp`);
              if (!isCurrent()) return;
              const type = row.file.contentType;
              const content = type.startsWith("image/") && !type.includes("svg") ? { image: bytes, mimetype: type }
                : type.startsWith("video/") ? { video: bytes, mimetype: type }
                  : type.startsWith("audio/") ? { audio: bytes, mimetype: type }
                    : { document: bytes, mimetype: type, fileName: row.file.fileName };
              const sent = await current.sendMessage(row.to, content) as { key?: { id?: string } } | undefined;
              if (sent?.key?.id) {
                remember(sentIds, sent.key.id);
                await runtime.runMutation("reactions:record", { channel: "whatsapp", externalId: row.to, messageId: sent.key.id, text: row.file.fileName, isPerry: true, fromMe: true }, internal);
              }
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
    })().catch(error => console.error(`[perry] WhatsApp outbox could not be processed: ${String(error)}`)).finally(() => { flushing = null; });
    return flushing;
  }

  // Something new in the outbox: send it now rather than on the next tick.
  const onChange = (tables: string[]) => { if (tables.includes("whatsappOutbox")) void flush(); };
  runtime.events.on("change", onChange);

  /** Group names, asked of WhatsApp once each. */
  const groupNames = new Map<string, string>();
  let account = "";
  const rememberGroup = (id: string, name: string) => {
    groupNames.delete(id);
    groupNames.set(id, name);
    while (groupNames.size > 500) groupNames.delete(groupNames.keys().next().value!);
  };
  async function groupName(jid: string, current: Socket): Promise<string | undefined> {
    if (!groupNames.has(jid) && current.groupMetadata) {
      const subject = await current.groupMetadata(jid).then((meta) => meta.subject, () => undefined);
      if (subject && socket === current && !stop.signal.aborted) rememberGroup(jid, subject);
    }
    return socket === current ? groupNames.get(jid) : undefined;
  }

  /**
   * A message in a chat that is not the owner's own with Perry: someone else's
   * direct message (linked as the owner), or a group. Who wrote it, and whether
   * it was for Perry, go with it; contacts.ts decides the rest.
   */
  async function handleOther(message: Record<string, any>, mode: "self" | "separate", remote: string, mine: string[], current: Socket) {
    const key = message.key ?? {};
    const group = remote.endsWith("@g.us");
    // In a group, WhatsApp's own echo of what Perry wrote as its own number is not news.
    if (mode === "separate" && key.fromMe) return;
    const inner = message.message?.ephemeralMessage?.message ?? message.message ?? {};
    const context = inner.extendedTextMessage?.contextInfo ?? inner.imageMessage?.contextInfo ?? inner.videoMessage?.contextInfo ?? {};
    const mentioned = ((context.mentionedJid ?? []) as string[]).map(bare);
    const quoted = bare(context.participant);
    const text = textOf(message.message) || (mediaOf(message.message) ? "(sent a file, which you cannot open here)" : "");
    if (!text) return;
    // Who wrote it: the owner, linked as them and writing from their phone; else the sender, by number when WhatsApp gives it.
    const sender = key.fromMe ? bare(current.user?.id) : bare(group ? key.participantAlt ?? key.participant : key.remoteJidAlt ?? remote);
    const name = group ? await groupName(remote, current) : undefined;
    if (socket !== current || stop.signal.aborted) return;
    await runtime.runAction("whatsapp:receiveOther", {
      chatId: bare(group ? remote : remote.endsWith("@lid") && key.remoteJidAlt ? key.remoteJidAlt : remote),
      group,
      ...(name ? { groupName: name } : {}),
      from: sender,
      ...(message.pushName && !key.fromMe ? { fromName: String(message.pushName) } : {}),
      fromOwner: Boolean(key.fromMe),
      mentionsLinked: mentioned.some((jid) => mine.includes(jid)),
      repliesToLinked: Boolean(quoted) && mine.includes(quoted),
      text,
    }, internal).catch((error) => console.error(`[perry] WhatsApp message failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  async function handle(message: Record<string, any>, mode: "self" | "separate", current: Socket) {
    if (stop.signal.aborted || socket !== current) return;
    if (message.message?.reactionMessage || message.message?.ephemeralMessage?.message?.reactionMessage) return;
    const key = message.key ?? {};
    const id = key.id as string | undefined;
    const remote = key.remoteJid as string | undefined;
    if (!id || !remote || seen.has(id) || sentIds.has(id)) return;
    remember(seen, id);
    // Broadcasts, status updates and channels are never Perry's to answer.
    if (remote.endsWith("@broadcast") || remote === "status@broadcast" || remote.endsWith("@newsletter")) return;
    const me = current.user;
    const mine = [bare(me?.id), bare(me?.lid)].filter(Boolean);
    if (remote.endsWith("@g.us") || (mode === "self" && !mine.includes(bare(remote)))) {
      await handleOther(message, mode, remote, mine, current);
      return;
    }
    let chatId: string;
    if (mode === "self") {
      // The owner's "Message yourself" chat, and only what they typed there.
      if (!key.fromMe) return;
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
    if (media) {
      try {
        const bytes = await (await driverOf()).download(message, current);
        if (bytes.byteLength > MEDIA_LIMIT) note = `\n\n(${media.fileName} was too big to download: WhatsApp files up to 20 MB.)`;
        else files.push({ base64: bytes.toString("base64"), fileName: media.fileName, contentType: media.contentType });
      } catch (error) {
        note = `\n\n(${media.fileName} could not be downloaded from WhatsApp.)`;
        console.error(`[perry] WhatsApp: could not download a file: ${String(error)}`);
      }
    }
    if (mode === "separate" && current.readMessages) await current.readMessages([key]).catch(() => {});
    if (stop.signal.aborted || socket !== current) { seen.delete(id); return; }
    await runtime.runAction("whatsapp:receive", {
      chatId,
      text: `${text}${note}`.trim(),
      ...(message.pushName ? { name: String(message.pushName) } : {}),
      ...(files.length ? { media: files } : {}),
      messageId: id, fromMe: Boolean(key.fromMe), remoteJid: remote,
    }, internal).catch((error) => console.error(`[perry] WhatsApp message failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  let driver: Promise<Driver> | null = null;
  const driverOf = () => driver ??= loadDriver().catch(error => { driver = null; throw error; });

  const loop = (async () => {
    let failures = 0;
    while (!stop.signal.aborted) {
      const wanted = await link().catch(() => null);
      if (stop.signal.aborted) break;
      if (!wanted?.wanted) {
        linkingSince = null;
        // Not linked, or unlinked from the dashboard: forget the device, then wait to be asked.
        if (socket) { await socket.logout().catch(() => {}); socket.end(); socket = null; connected = false; }
        groupNames.clear(); sentIds.clear(); seen.clear(); account = "";
        if (existsSync(AUTH_DIR) && wanted && !wanted.wanted) rmSync(AUTH_DIR, { recursive: true, force: true });
        await sleep(3_000, stop.signal);
        continue;
      }
      mkdirSync(AUTH_DIR, { recursive: true });
      mode = wanted.mode;
      type Ending = "logged-out" | "dropped" | "unlinked" | "refresh" | "restart";
      const listeners: Array<() => void> = [];
      const listen = (emitter: Socket["ev"] | NonNullable<Socket["ws"]>, event: string, listener: (data: any) => void) => {
        emitter.on(event, listener);
        listeners.push(() => emitter.off(event, listener));
      };
      let active = true;
      let closed: (reason: Ending) => void = () => {};
      const ended = new Promise<Ending>((resolve) => { closed = reason => { if (!active) return; active = false; resolve(reason); }; });
      try {
        const d = await driverOf();
        const current = await d.connect({ authDir: AUTH_DIR });
        if (stop.signal.aborted) { current.end(); break; }
        socket = current;
        const isCurrent = () => active && socket === current && !stop.signal.aborted;
        let qrRevision = 0;
        let asked = false;
        let opened = false;
        let showing = false;
        lastEvent = Date.now();
        // Any frame is a sign of life: only messages counted before, so a quiet account reconnected every half hour.
        if (current.ws) listen(current.ws, "frame", () => { if (isCurrent()) lastEvent = Date.now(); });
        listen(current.ev, "connection.update", (update: { connection?: string; qr?: string; lastDisconnect?: { error?: unknown } }) => {
          if (!isCurrent()) return;
          lastEvent = Date.now();
          if (update.qr) {
            const revision = ++qrRevision;
            showing = true;
            linkingSince ??= Date.now();
            if (wanted.phone && !asked) {
              // Linking with a code typed on the phone instead of scanning.
              asked = true;
              void current.requestPairingCode(wanted.phone)
                .then((code) => { if (isCurrent() && !opened) return report("code", { code: code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code }); })
                .catch((error) => { if (isCurrent() && !opened) return report("qr", { error: `Could not get a code (${String(error)}); scan the QR instead.` }); });
            } else if (!wanted.phone) {
              void d.qrPng(update.qr).then((png) => { if (isCurrent() && !opened && revision === qrRevision) return report("qr", { qr: png }); }).catch(error => { if (isCurrent()) console.error(`[perry] WhatsApp QR could not be rendered: ${String(error)}`); });
            }
          }
          if (update.connection === "open") {
            connected = true;
            opened = true;
            const nextAccount = bare(current.user?.id);
            if (account !== nextAccount) { groupNames.clear(); sentIds.clear(); seen.clear(); account = nextAccount; }
            linkingSince = null;
            failures = 0;
            console.log("[perry] WhatsApp: connected");
            void current.groupFetchAllParticipating?.().then((groups) => {
              if (!isCurrent()) return;
              for (const group of Object.values(groups)) if (group.subject) rememberGroup(group.id, group.subject);
              learn(Object.values(groups).map((group) => ({ externalId: group.id, kind: "group" as const, name: group.subject })));
            }).catch(() => {});
            void report("connected", { me: current.user?.id ?? "" }).then(() => { if (isCurrent()) return flush(); });
          }
          if (update.connection === "close") {
            connected = false;
            const code = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
            // A QR or code that ran out, and the restart after linking, are not failures: WhatsApp expects a new connection at once.
            closed(d.loggedOut(update) ? "logged-out" : code === RESTART_REQUIRED ? "restart" : !opened && showing ? "refresh" : "dropped");
          }
        });
        // WhatsApp's address book and groups, so a contact can be found by name (contacts.learn).
        const learn = (items: Array<{ externalId: string; kind: "person" | "group"; name?: string; handle?: string }>) => {
          if (isCurrent() && items.length) void runtime.runMutation("contacts:learn", { items: items.map((item) => ({ channel: "whatsapp", ...item })) }, internal).catch(() => {});
        };
        const people = (list: Array<{ id?: string; name?: string; notify?: string; verifiedName?: string; phoneNumber?: string }>) => learn(list
          .filter((contact) => contact.id && (contact.id.endsWith("@s.whatsapp.net") || contact.id.endsWith("@lid")))
          .map((contact) => {
            const phone = contact.id!.endsWith("@s.whatsapp.net") ? contact.id! : contact.phoneNumber ?? contact.id!;
            const digits = bare(phone).split("@")[0];
            return { externalId: bare(phone), kind: "person" as const, name: contact.name ?? contact.notify ?? contact.verifiedName, ...(/^\d+$/.test(digits) ? { handle: `+${digits}` } : {}) };
          }));
        listen(current.ev, "contacts.upsert", (list: never[]) => people(list));
        listen(current.ev, "messaging-history.set", (history: { contacts?: never[] }) => people(history.contacts ?? []));
        // Calls ringing, answered and ended, kept as they happen (convex/whatsapp.ts, callEvent).
        listen(current.ev, "call", (calls: Array<{ id: string; from: string; chatId: string; status: string; isVideo?: boolean; isGroup?: boolean }>) => {
          if (!isCurrent()) return;
          lastEvent = Date.now();
          for (const call of calls) {
            void runtime.runMutation("whatsapp:callEvent", {
              id: call.id, from: call.from, chatId: call.chatId, status: call.status, ...(call.isVideo ? { isVideo: true } : {}), ...(call.isGroup ? { isGroup: true } : {}),
            }, internal).catch((error) => console.error(`[perry] WhatsApp: could not keep a call: ${String(error)}`));
          }
        });
        listen(current.ev, "messages.upsert", (event: { type: string; messages: Array<Record<string, any>> }) => {
          lastEvent = Date.now();
          if (!isCurrent()) return;
          // "append" is history caught up after a reconnect: read, not answered (as OpenClaw does).
          if (event.type !== "notify") return;
          if (stop.signal.aborted) return;
          for (const message of event.messages) track(handle(message, wanted.mode, current));
        });
        listen(current.ev, "messages.reaction", (events: Array<{ key: { id?: string; fromMe?: boolean; remoteJid?: string }; reaction: { key?: { id?: string; remoteJid?: string; remoteJidAlt?: string; fromMe?: boolean }; text?: string; senderTimestampMs?: number } }>) => {
          if (!isCurrent()) return;
          lastEvent = Date.now();
          for (const event of events) {
            const key = event.reaction.key;
            if (!key?.id || sentIds.has(key.id) || seen.has(key.id) || !event.key.id) continue;
            const remote = bare(key.remoteJidAlt ?? key.remoteJid);
            const mine = [bare(current.user?.id), bare(current.user?.lid)].filter(Boolean);
            if (wanted.mode === "self" ? !key.fromMe || !mine.includes(remote) : key.fromMe) continue;
            remember(seen, key.id);
            track(runtime.runAction("reactions:receive", { channel: "whatsapp", externalId: wanted.mode === "self" ? bare(current.user?.id) : remote, messageId: event.key.id, emojis: event.reaction.text ? [event.reaction.text] : [], at: Number(event.reaction.senderTimestampMs) || Date.now(), selfChat: wanted.mode === "self", fromMe: event.key.fromMe, remoteJid: event.key.remoteJid }, internal)
              .catch(error => console.error(`[perry] WhatsApp reaction failed: ${String(error)}`)));
          }
        });
        dropped = () => closed("dropped");
        // Unlinked from the dashboard, or quiet for too long: end this connection.
        const watch = setInterval(() => {
          void link().then((now) => { if (isCurrent() && (!now?.wanted || now.mode !== wanted.mode || now.phone !== wanted.phone)) closed("unlinked"); }).catch(() => {});
          if (connected && Date.now() - lastEvent > QUIET_MS) { console.warn("[perry] WhatsApp: quiet for too long; reconnecting"); closed("dropped"); }
        }, 5_000);
        const onAbort = () => closed("unlinked");
        stop.signal.addEventListener("abort", onAbort, { once: true });
        if (stop.signal.aborted) onAbort();
        let reason: Ending;
        try { reason = await ended; }
        finally {
          clearInterval(watch);
          stop.signal.removeEventListener("abort", onAbort);
          active = false;
          for (const remove of listeners.splice(0)) remove();
          current.end();
          if (socket === current) socket = null;
        }
        dropped = null;
        connected = false;
        if (reason === "logged-out") {
          // Unlinked on the phone: the saved session is dead, and linking starts again from the dashboard.
          console.warn("[perry] WhatsApp: logged out; link again from the dashboard");
          rmSync(AUTH_DIR, { recursive: true, force: true });
          await report("logged-out", { error: "WhatsApp was unlinked on the phone. Link it again to keep using it." });
          await runtime.runMutation("whatsapp:stop", {}, internal).catch(() => {});
          continue;
        }
        if (reason === "unlinked") continue;
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
        for (const remove of listeners.splice(0)) remove();
        active = false;
        connected = false;
        socket?.end();
        socket = null;
        failures += 1;
        console.error(`[perry] WhatsApp: ${error instanceof Error ? error.message : String(error)}; trying again shortly`);
        await report("disconnected", { error: error instanceof Error ? error.message : String(error) });
        await sleep(Math.min(60_000, 5_000 * failures), stop.signal);
      }
    }
  })();

  return async () => {
    stop.abort();
    dropped?.();
    runtime.events.off("change", onChange);
    sentIds.clear();
    seen.clear();
    groupNames.clear();
    socket?.end();
    await Promise.allSettled([loop, ...incoming, ...(flushing ? [flushing] : [])]);
  };
}
