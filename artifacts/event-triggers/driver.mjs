// A stand-in for Composio's event subscription (server/triggers.ts, PERRY_TRIGGER_DRIVER).
// It writes what it is asked to a log, and delivers the events a test appends to an inbox file,
// one JSON object a line: { "instanceIds": ["…"], "event": "…" }.
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const log = process.env.PERRY_TRIGGER_LOG;
const inbox = process.env.PERRY_TRIGGER_INBOX;
const note = (line) => { if (log) appendFileSync(log, `${JSON.stringify({ at: Date.now(), ...line })}\n`); };

export default {
  async subscribe(apiKey, onEvent) {
    note({ did: "subscribe", apiKey: apiKey ? "set" : null });
    let read = existsSync(inbox) ? readFileSync(inbox, "utf8").length : 0;
    const timer = setInterval(() => {
      if (!existsSync(inbox)) return;
      const text = readFileSync(inbox, "utf8");
      const fresh = text.slice(read);
      read = text.length;
      for (const line of fresh.split("\n").filter(Boolean)) onEvent(JSON.parse(line));
    }, 300);
    return async () => { clearInterval(timer); note({ did: "close" }); };
  },
};
