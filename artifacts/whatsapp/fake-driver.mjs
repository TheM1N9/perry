// A stand-in for WhatsApp, for artifacts/whatsapp/run.ts: server/whatsapp.ts
// loads it through PERRY_WHATSAPP_DRIVER instead of Baileys. It takes what to
// do (a QR, the connection opening, a message arriving, a logout) from the
// test's control server, and reports what Perry sends back to it.
const base = process.env.PERRY_WHATSAPP_CONTROL;
const post = (path, body) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => {});
const describe = (content) => {
  if (content.text !== undefined) return { text: content.text };
  for (const kind of ["image", "video", "audio", "document"]) if (content[kind]) return { file: kind, bytes: content[kind].length, fileName: content.fileName, mimetype: content.mimetype };
  return { other: Object.keys(content) };
};

const CODES = ["ABCD1234", "EFGH5678", "JKMN2345"];
let codesGiven = 0;

export default {
  async connect({ authDir }) {
    const listeners = new Map();
    const emit = (event, data) => (listeners.get(event) ?? []).forEach((listener) => listener(data));
    let ended = false;
    let count = 0;
    const socket = {
      ev: { on(event, listener) { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(listener); } },
      user: undefined,
      async sendMessage(jid, content) {
        const id = `OUT${Date.now()}${++count}`;
        await post("/sent", { jid, id, ...describe(content) });
        return { key: { id, remoteJid: jid, fromMe: true } };
      },
      async sendPresenceUpdate(presence, jid) { await post("/presence", { presence, jid }); },
      // Each connection gets a code of its own, as WhatsApp gives.
      async requestPairingCode(phone) { await post("/code-requested", { phone }); return CODES[codesGiven++ % CODES.length]; },
      async readMessages() {},
      async logout() { await post("/logout", {}); },
      end() { ended = true; },
    };
    await post("/connect", { authDir });
    void (async () => {
      // A real socket emits only once it is set up, after its listeners are attached.
      await new Promise((resolve) => setTimeout(resolve, 200));
      while (!ended) {
        const commands = await fetch(`${base}/next`).then((response) => response.json()).catch(() => null);
        if (!commands) { await new Promise((resolve) => setTimeout(resolve, 300)); continue; }
        for (const command of commands) {
          if (ended) break;
          if (command.user) socket.user = command.user;
          if (command.event) emit(command.event, command.data);
        }
      }
    })();
    return socket;
  },
  async download(message) { return Buffer.from(message.fakeBytes ?? "", "base64"); },
  loggedOut(update) { return update?.lastDisconnect?.error?.output?.statusCode === 401; },
  async qrPng(qr) { return `data:image/png;base64,${Buffer.from(qr).toString("base64")}`; },
};
