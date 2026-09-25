import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { openChat } from "../browser";

// bun artifacts/copy/run.ts <outDir> <dashboardKey> <insecureBase>
// e.g. bun artifacts/copy/run.ts artifacts/copy $DASHBOARD_KEY http://100.77.196.105:3005
// Needs CONVEX_URL, `next dev -p 3005 -H 0.0.0.0` against a deployment with
// this branch's dashboard functions, at least one web chat with a reply, and
// <insecureBase> reaching it at an address that is not localhost, such as the
// machine's Tailscale or LAN IP. Read-only.
//
// Opened over plain http at such an address, the page is not a secure context,
// navigator.clipboard is undefined, and every copy button threw "Cannot read
// properties of undefined (reading 'writeText')".
//
// Headless Chrome's clipboard does not round-trip (write, then read, gives ""),
// so the test records what the page hands the browser to copy: the text
// selected when the copy command fires, or the text given to the Clipboard API.
//
// Ways copying could still fail, and what catches each:
//   1. The test is not on an insecure page, so it proves nothing: the page must
//      report isSecureContext false and have no navigator.clipboard.
//   2. Clicking Copy on a message still throws: no page error, and the button
//      must say "Copied".
//   3. It says Copied but copies nothing, or the wrong text: the copy command
//      must have fired with exactly the reply's saved text selected.
//   4. Only one button was fixed: the session ID button must copy the full ID.
//   5. Keyboard users lose their place: focus must be back on the button.
//   6. The helper left its textarea in the page: none may remain.
//   7. The secure path broke: on 127.0.0.1 (secure, like localhost), the
//      message button must hand the same text to the Clipboard API.

const [outDir, dashboardKey, insecureBase] = process.argv.slice(2);
if (!outDir || !dashboardKey || !insecureBase) throw new Error("usage: bun artifacts/copy/run.ts <outDir> <dashboardKey> <insecureBase>");
mkdirSync(outDir, { recursive: true });

const secureBase = "http://127.0.0.1:3005";
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};

const browser = await openChat(insecureBase, dashboardKey);
const { evaluate, send } = browser;
// On the secure page the Clipboard API wants a focused page and permission, as a real tab has.
await send("Emulation.setFocusEmulationEnabled", { enabled: true });
await send("Browser.grantPermissions", { origin: secureBase, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
// Record every copy, on every page load, before the app runs.
await send("Page.addScriptToEvaluateOnNewDocument", { source: `
  window.__copies = [];
  document.addEventListener("copy", (event) => {
    const target = event.target;
    const text = target && "value" in target ? target.value.slice(target.selectionStart, target.selectionEnd) : String(getSelection());
    window.__copies.push({ via: "copy command", text });
  }, true);
  if (navigator.clipboard) {
    const write = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = (text) => { window.__copies.push({ via: "clipboard api", text }); return write(text); };
  }
` });
const waitFor = (test: string, what: string) => evaluate(`new Promise((resolve, reject) => { const start = Date.now(); const tick = () => (${test}) ? resolve(true) : Date.now() - start > 30000 ? reject(new Error(${JSON.stringify(what)})) : setTimeout(tick, 150); tick(); })`);
/** Click as a person does: the copy command only runs during a user gesture. */
const click = (element: string) => send("Runtime.evaluate", { expression: `${element}.click()`, userGesture: true });
const lastCopy = (): Promise<{ via: string; text: string } | null> => evaluate(`window.__copies.at(-1) ?? null`);
const messageButton = `[...document.querySelectorAll('.chat-turn.from-assistant')].at(-1)?.querySelector('.chat-turn-actions button[title="Copy this message"]')`;
const openReply = async (url: string) => {
  await send("Page.navigate", { url });
  await waitFor(`!!(${messageButton}) && Array.isArray(window.__copies)`, `no reply to copy at ${url}`);
};

try {
  // Reload so the recorder is in place, on the chat the helper opened.
  const chatUrl: string = await evaluate(`location.href`);
  await openReply(chatUrl);

  // The reply's saved text (Markdown source, which is what Copy copies), from the server.
  const chatId = decodeURIComponent(new URL(chatUrl).pathname.split("/")[2]);
  notes.chatId = chatId;
  const convex = new ConvexHttpClient(process.env.CONVEX_URL!);
  const { page } = await convex.query(api.dashboard.getChatMessages, { key: dashboardKey, id: chatId as Id<"conversations">, paginationOpts: { numItems: 50, cursor: null } });
  const source = [...page].filter((message) => message.role === "assistant").sort((a, b) => b.createdAt - a.createdAt)[0]?.text ?? "";
  notes.replyStart = source.slice(0, 120);

  // 1. Insecure, as on the owner's Tailscale address.
  const context = await evaluate(`({ secure: window.isSecureContext, clipboard: typeof navigator.clipboard })`);
  notes.insecureContext = context;
  checks.pageIsInsecure = context.secure === false && context.clipboard === "undefined";

  // 2, 3, 5 and 6. The message's Copy button, from the keyboard's point of view.
  await evaluate(`${messageButton}.focus(); true`);
  await click(messageButton);
  await waitFor(`${messageButton}.innerText.includes('Copied')`, "the message button never said Copied");
  checks.messageSaysCopied = true;
  const message = await lastCopy();
  notes.messageCopy = message && { via: message.via, length: message.text.length };
  checks.messageTextCopied = source.length > 0 && message?.via === "copy command" && message.text === source;
  checks.focusStaysOnButton = await evaluate(`document.activeElement === ${messageButton}`);
  checks.noTextareaLeft = await evaluate(`![...document.querySelectorAll("textarea[readonly]")].some((area) => area.style.opacity === "0")`);
  checks.noErrorOnClick = browser.errors.length === 0;
  writeFileSync(join(outDir, "copied-insecure.png"), Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));

  // 4. The session ID button.
  await click(`document.querySelector('.chat-session-id')`);
  await waitFor(`document.querySelector('.chat-session-id').innerText.includes('Copied')`, "the session ID button never said Copied");
  const session = await lastCopy();
  checks.sessionIdCopied = session?.via === "copy command" && session.text === chatId;

  // 7. The secure path.
  await send("Page.navigate", { url: `${secureBase}/chat` });
  await waitFor(`location.origin === ${JSON.stringify(secureBase)} && document.readyState === "complete"`, "127.0.0.1 never opened");
  await evaluate(`localStorage.setItem("perry.dashboard.key", ${JSON.stringify(dashboardKey)}); true`);
  await openReply(`${secureBase}${new URL(chatUrl).pathname}`);
  checks.secureContextHasClipboard = await evaluate(`window.isSecureContext && typeof navigator.clipboard === "object"`);
  await click(messageButton);
  await waitFor(`${messageButton}.innerText.includes('Copied')`, "Copied never showed on 127.0.0.1");
  const secure = await lastCopy();
  checks.secureUsesClipboardApi = secure?.via === "clipboard api" && secure.text === source;

  notes.pageErrors = browser.errors;
  checks.noPageErrors = browser.errors.length === 0;
} finally {
  browser.close();
}

const result = { ranAt: new Date().toISOString(), insecureBase, checks, notes, passed: Object.values(checks).every(Boolean) };
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exit(1);
