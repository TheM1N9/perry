import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";

const out = resolve("artifacts/computer-control");
const scratch = resolve("node_modules/.cache/perry-computer-control", `run-${Date.now()}`);
mkdirSync(scratch, { recursive: true });
process.env.PERRY_HOME = join(scratch, "home");
process.env.DASHBOARD_KEY = "computer-control-synthetic";
process.env.PERRY_CREDENTIAL_KEY = "88".repeat(32);
process.env.PERRY_BROWSER_PATH ??= "C:/Program Files/Google/Chrome/Application/chrome.exe";
process.env.PERRY_BROWSER_VIEW = "1";
const key = process.env.DASHBOARD_KEY;
const token = "computer-control-fake-runner";
let slowStarted = 0;
const service = createServer((request, response) => {
  response.setHeader("Content-Type", "text/html");
  if (request.url === "/slow") { slowStarted++; return; }
  response.end(`<html><title>Control fixture</title><body>
    <input aria-label="Edit" value="abcd"><button id="one" onclick="window.clicked='one'">First</button>
    <button id="two" onclick="window.clicked='two'">Second</button>
    <button id="send" onclick="window.sent=(window.sent||0)+1">Send</button>
  </body></html>`);
});
await new Promise<void>(done => service.listen(0, "127.0.0.1", done));
const site = `http://127.0.0.1:${(service.address() as any).port}`;
const realFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") throw new Error("External network blocked in control fixture");
  return realFetch(input, options);
};
const [{ Runtime }, { default: schema }, { modules }, { default: http }, browser, { controlBrowser }] = await Promise.all([
  import("../../server/runtime"), import("../../convex/schema"), import("../../server/modules"), import("../../convex/http"),
  import("../../convex/lib/browser"), import("../../server/browser-host"),
]);
const sql = new DatabaseSync(join(scratch, "fixture.sqlite"));
const rt = new Runtime(sql, schema as never, modules, { storageDir: join(scratch, "storage"), http: http as never });
await rt.stop();
const db = rt.store;
const call = async (path: string, args: object = {}) => (await rt.call(path, args, { internal: true })).value as any;
const checks: Record<string, boolean> = {};
const evidence: Record<string, any> = {};
const chats: string[] = [];
function check(name: string, passed: boolean) { checks[name] = passed; console.log(`${passed ? "PASS" : "FAIL"} ${name}`); }
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
async function until(test: () => boolean | Promise<boolean>, ms = 6_000) { const end = Date.now() + ms; while (!await test()) { if (Date.now() >= end) throw new Error("Fixture condition timed out"); await sleep(50); } }
async function session(name: string) {
  const chat = await call("dashboard:createChat", { key }); chats.push(chat);
  const runId = await call("runs:start", { conversationId: chat, prompt: name });
  const turn = await call("codex:enqueueTurn", { conversationId: chat, runId, engine: "codex", prompt: name, instructions: "Fixture only", policy: "queue" });
  if (!await call("codex:claimTurn", { token, id: turn })) throw new Error("Claim failed");
  await call("codex:setResume", { token, id: turn, cursor: `native-${name}` });
  return { chat, turn };
}
const evaluate = async (chat: string, expression: string) => (await browser.withBrowserView(chat, () => browser.hostCommand("Runtime.evaluate", { expression, returnByValue: true })) as any).result.value;
const identity = (chat: string) => browser.identity(chat)!;
const owner = (chat: string, request: any) => controlBrowser(chat, request, false);
async function mcp(chat: string, args: object, signal?: AbortSignal) {
  const response = await rt.runHttp("/mcp", new Request("http://fixture.local/mcp", { method: "POST", signal, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-perry-chat": chat }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "browser", arguments: args } }) }));
  const rpc = await response.json() as any;
  const result = rpc.result?.content?.find((part: any) => part.type === "text")?.text;
  const parsed = result ? JSON.parse(result) : rpc;
  return parsed.untrusted ? parsed.result : parsed;
}
try {
  await rt.exclusive(() => {
    db.insert("installation", { defaultEngine: "codex", onboarding: "skipped", createdAt: Date.now() });
    db.insert("runners", { name: "Fixture runner", token, createdAt: Date.now(), lastSeenAt: Date.now(), engines: [{ kind: "codex", installed: true, signedIn: true, auth: {}, models: [], updatedAt: Date.now() }] });
  });
  const main = await session("control");
  await owner(main.chat, { action: "start" });
  await owner(main.chat, { action: "navigate", identity: identity(main.chat), url: site });
  evidence.browser = await browser.withBrowserView(main.chat, () => browser.hostCommand("Browser.getVersion"));
  await evaluate(main.chat, "document.querySelector('input').focus(); document.querySelector('input').setSelectionRange(2,2)");
  await owner(main.chat, { action: "key", identity: identity(main.chat), key: "ArrowLeft", code: "ArrowLeft", keyCode: 37, modifiers: 0 });
  evidence.arrowSelection = await evaluate(main.chat, "document.querySelector('input').selectionStart");
  check("manual ArrowLeft moves the editing caret", evidence.arrowSelection === 1);
  await evaluate(main.chat, "document.querySelector('input').setSelectionRange(1,1)");
  await owner(main.chat, { action: "key", identity: identity(main.chat), key: "Delete", code: "Delete", keyCode: 46, modifiers: 0 });
  evidence.deleteValue = await evaluate(main.chat, "document.querySelector('input').value");
  check("manual Delete edits the focused field", evidence.deleteValue === "acd");
  await owner(main.chat, { action: "key", identity: identity(main.chat), key: "a", code: "KeyA", keyCode: 65, modifiers: 2 });
  await owner(main.chat, { action: "text", identity: identity(main.chat), text: "replacement" });
  evidence.shortcutValue = await evaluate(main.chat, "document.querySelector('input').value");
  check("manual Ctrl+A selects all before text replacement", evidence.shortcutValue === "replacement");
  const panelSource = readFileSync("components/dashboard/chat/browser-panel.tsx", "utf8");
  const manualStart = panelSource.indexOf("  function manual(");
  const manualEnd = panelSource.indexOf("  async function run", manualStart);
  if (manualStart < 0 || manualEnd < 0) throw new Error("Manual input replay boundary changed");
  let releaseKeys = () => {};
  const manualQueue = { current: new Promise<void>(done => { releaseKeys = done; }) };
  const stateRef = { current: await owner(main.chat, { action: "status" }) as any };
  const manualCode = ts.transpileModule(panelSource.slice(manualStart, manualEnd), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const manual = new Function("manualQueue", "stateRef", "act", `${manualCode}; return manual;`)(manualQueue, stateRef, (request: any) => owner(main.chat, request));
  manual({ action: "text", text: "SHOULD NOT REACH THE NEW TAB" });
  await owner(main.chat, { action: "newTab", identity: identity(main.chat) });
  await owner(main.chat, { action: "navigate", identity: identity(main.chat), url: site });
  await evaluate(main.chat, "document.querySelector('input').focus(); document.querySelector('input').setSelectionRange(0,0)");
  stateRef.current = await owner(main.chat, { action: "status" });
  releaseKeys(); await manualQueue.current;
  evidence.queuedTyping = await evaluate(main.chat, "document.querySelector('input').value");
  check("queued owner typing never retargets a newly selected tab", evidence.queuedTyping === "abcd");
  await owner(main.chat, { action: "resume", identity: identity(main.chat) });
  const first = await mcp(main.chat, { action: "look" });
  evidence.firstLook = first;
  const oldRef = first.elements.find((item: any) => item.label === "First").ref;
  await evaluate(main.chat, "document.body.insertBefore(document.querySelector('#two'), document.querySelector('#one'))");
  const second = await mcp(main.chat, { action: "look" });
  const stale = await mcp(main.chat, { action: "click", identity: first.identity, ref: oldRef });
  evidence.staleClick = { clicked: await evaluate(main.chat, "window.clicked || null"), firstIdentity: first.identity, secondIdentity: second.identity, result: stale };
  check("fresh look invalidates old element references", Boolean(stale.error) && evidence.staleClick.clicked === null);
  const freshClick = await mcp(main.chat, { action: "click", identity: second.identity, ref: second.elements.find((item: any) => item.label === "First").ref });
  check("fresh references still click the intended control", !freshClick.error && await evaluate(main.chat, "window.clicked") === "one");
  const latest = await mcp(main.chat, { action: "look" });
  const waiting = mcp(main.chat, { action: "click", identity: latest.identity, ref: latest.elements.find((item: any) => item.label === "Send").ref });
  await until(async () => (await db.query("approvals").collect()).some(row => row.status === "pending"));
  const approval = (await db.query("approvals").collect()).find(row => row.status === "pending")!;
  await call("dashboard:stopChat", { key, id: main.chat });
  await sleep(700);
  const lateApproval = await call("approvals:decide", { key, id: approval._id, approved: true });
  const stopped = await waiting;
  evidence.stopped = { sent: await evaluate(main.chat, "window.sent || 0"), result: stopped };
  check("Stop prevents a previously requested browser action after late approval", evidence.stopped.sent === 0 && Boolean(stopped.error || stopped.declined));
  check("cancelled browser releases its action lock", !browser.browserControl(main.chat).busy);
  check("stopped browser approval is dismissed and cannot be approved", !lateApproval && db.get(approval._id)?.status === "expired");

  const other = await session("other");
  const opened = await mcp(other.chat, { action: "open", url: site });
  check("Stop leaves a separate chat browser usable", !opened.error && opened.title === "Control fixture" && identity(other.chat).sessionId !== identity(main.chat).sessionId);
  const abort = new AbortController();
  const aborted = mcp(other.chat, { action: "click", identity: opened.identity, ref: opened.elements.find((item: any) => item.label === "Send").ref }, abort.signal);
  await until(async () => (await db.query("approvals").collect()).some(row => row.conversationId === other.chat && row.status === "pending"));
  const abortedApproval = (await db.query("approvals").collect()).find(row => row.conversationId === other.chat && row.status === "pending")!;
  abort.abort();
  const abortedResult = await aborted;
  check("request abort cancels approval without touching the page", Boolean(abortedResult.error) && await evaluate(other.chat, "window.sent || 0") === 0 && !browser.browserControl(other.chat).busy && db.get(abortedApproval._id)?.status === "expired");
  const recovered = await mcp(other.chat, { action: "look" });
  check("aborted request does not poison subsequent browser calls", !recovered.error && recovered.elements.length === 4);
  const target = recovered.elements.find((item: any) => item.label === "Send").ref;
  const takeover = mcp(other.chat, { action: "click", identity: recovered.identity, ref: target });
  await until(async () => (await db.query("approvals").collect()).some(row => row.conversationId === other.chat && row.status === "pending"));
  const takeoverApproval = (await db.query("approvals").collect()).find(row => row.conversationId === other.chat && row.status === "pending")!;
  await owner(other.chat, { action: "takeover" });
  const takeoverResult = await takeover;
  check("takeover invalidates an approval and releases the agent", Boolean(takeoverResult.error) && db.get(takeoverApproval._id)?.status === "expired" && !browser.browserControl(other.chat).busy);
  check("takeover remains paused until explicit resume", (await mcp(other.chat, { action: "look" })).error?.includes("paused") === true);
  await owner(other.chat, { action: "resume", identity: identity(other.chat) });
  check("explicit resume restores browser use", !(await mcp(other.chat, { action: "look" })).error);
  const navigating = mcp(other.chat, { action: "open", identity: identity(other.chat), url: `${site}/slow` });
  await until(() => slowStarted > 0);
  const cancelledAt = Date.now();
  await call("dashboard:stopChat", { key, id: other.chat });
  const navigationResult = await navigating;
  evidence.navigation = { result: navigationResult, cancelMs: Date.now() - cancelledAt };
  check("Stop cancels a browser navigation before the page responds", Boolean(navigationResult.error) && evidence.navigation.cancelMs < 2_000 && !browser.browserControl(other.chat).busy);
  check("cancelled navigation releases pending CDP commands", [...browser.browserControl(other.chat).connections.values()].every(connection => connection.pending.size === 0));
  const paused = await session("pause");
  const pausePage = await mcp(paused.chat, { action: "open", url: site });
  const pauseWait = mcp(paused.chat, { action: "click", identity: pausePage.identity, ref: pausePage.elements.find((item: any) => item.label === "Send").ref });
  await until(async () => (await db.query("approvals").collect()).some(row => row.conversationId === paused.chat && row.status === "pending"));
  await call("pause:set", { key, paused: true });
  const pauseResult = await pauseWait;
  check("global Pause cancels an in-flight browser approval", Boolean(pauseResult.error) && await evaluate(paused.chat, "window.sent || 0") === 0 && !browser.browserControl(paused.chat).busy);
  await call("pause:set", { key, paused: false });
  check("Resume cannot revive the stopped browser call", (await db.query("approvals").collect()).filter(row => row.conversationId === paused.chat).every(row => row.status !== "pending") && await evaluate(paused.chat, "window.sent || 0") === 0);
} catch (error) {
  evidence.error = error instanceof Error ? error.stack?.replaceAll(process.cwd(), ".") : String(error);
} finally {
  for (const chat of chats) await browser.withBrowserView(chat, async () => browser.closeBrowser());
  await rt.stop(); sql.close();
  service.closeAllConnections(); await new Promise<void>(done => service.close(() => done()));
  const passed = !evidence.error && Object.values(checks).every(Boolean);
  writeFileSync(join(out, process.argv.includes("--baseline") ? "baseline.json" : "result.json"), JSON.stringify({ passed, checks, evidence }, null, 2) + "\n");
  if (!passed) process.exitCode = 1;
}
