import { EventEmitter } from "node:events";

export const attempts = [];
export const failures = new Map();
export const sockets = [];
export const hooks = { afterSend: undefined };

export default {
  async connect() {
    const ev = new EventEmitter();
    const on = ev.on.bind(ev);
    ev.on = (event, listener) => {
      on(event, listener);
      if (event === "connection.update") queueMicrotask(() => ev.emit(event, { connection: "open" }));
      return ev;
    };
    const socket = {
      ev, user: { id: "999@s.whatsapp.net" },
      async sendPresenceUpdate() {},
      async sendMessage(to, content) {
        const bytes = content.image ?? content.document;
        const name = bytes ? Buffer.from(bytes).toString().replace("synthetic:", "") : "text";
        attempts.push({ to, name });
        const remaining = failures.get(name) ?? 0;
        if (remaining) {
          failures.set(name, remaining - 1);
          throw new Error("Synthetic transient failure");
        }
        if (hooks.afterSend) await hooks.afterSend({ to, name });
        return { key: { id: `synthetic-${attempts.length}` } };
      },
      async logout() {},
      end() { ev.removeAllListeners(); },
    };
    sockets.push(socket);
    return socket;
  },
  async download() { throw new Error("No incoming files in this replay"); },
  loggedOut() { return false; },
  async qrPng() { throw new Error("No pairing in this replay"); },
};
