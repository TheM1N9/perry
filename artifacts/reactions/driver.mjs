import { EventEmitter } from 'node:events';

export const sent = [];
export let socket;
let nextId = 1;
export default {
  async connect() {
    const ev = new EventEmitter();
    let opening = setImmediate(() => ev.emit('connection.update', { connection: 'open' }));
    socket = {
      ev,
      user: { id: '919876543210@s.whatsapp.net' },
      async sendMessage(to, content) {
        const id = `perry-${nextId++}`;
        sent.push({ to, content, id });
        if (content.react) {
          ev.emit('messages.reaction', [{ key: content.react.key, reaction: { key: { id, remoteJid: to, fromMe: true }, text: content.react.text, senderTimestampMs: Date.now() } }]);
        }
        return { key: { id } };
      },
      async sendPresenceUpdate() {},
      async requestPairingCode() { return 'FIXTURE'; },
      async logout() {},
      end() { clearImmediate(opening); ev.removeAllListeners(); },
    };
    return socket;
  },
  async download() { return Buffer.alloc(0); },
  loggedOut() { return false; },
  async qrPng() { return ''; },
};
