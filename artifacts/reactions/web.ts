import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { perry } from "../engine-acp/harness";
import type { ChatMessage } from "../../convex/dashboard";

// Failure cases and the isolated production/browser boundaries are in web.md.
const out = resolve(process.argv[2] ?? "artifacts/reactions/web-results");
mkdirSync(out, { recursive: true });
const p = await perry({ name: "web-reactions", outDir: out, engine: "codex", runnerEnv: () => ({}), env: { NODE_OPTIONS: `--import ${pathToFileURL(resolve("artifacts/reactions/web-bootstrap.mjs")).href}` } });
const { call, KEY, BASE, until } = p;
const token = "web-reactions-fixture-runner";
let failed: string | undefined;
const check = (name: string, ok: boolean) => { p.check(name, ok); if (!ok) throw new Error(name); };
const messages = async (id: string) => (await call<{ page: ChatMessage[] }>("dashboard:getChatMessages", { key: KEY, id, paginationOpts: { numItems: 50, cursor: null } })).page;
try {
  p.start("server");
  await until(async () => Boolean(await call("dashboard:getStatus", { key: KEY })), "isolated server");
  await call("wake:set", { key: KEY, enabled: false });
  await call("dashboard:skipOnboarding", { key: KEY });
  await call("runner:createToken", { name: "Fixture runner", token });
  await call("runner:checkIn", { token, policy: "ask" });
  await call("engines:report", { token, engines: [{ kind: "codex", installed: true, signedIn: true, auth: {}, models: [{ id: "fixture", name: "Fixture", isDefault: true }] }] });
  const id = await call<string>("dashboard:createChat", { key: KEY });
  const chat = await p.conversation(id);
  const saved = await call<{ messages: string[] }>("agentStore:saveMessages", { threadId: chat.threadId, messages: [{ role: "user", content: "Let's compare two train options." }, { role: "assistant", content: "Option two leaves at 08:00 and keeps the fare under 60." }] });
  const assistantMessage = saved.messages[1];
  const browser = await p.openBrowser();
  const evaluate = browser.evaluate;
  await browser.send("Page.navigate", { url: `${BASE}/chat/${id}` });
  await until(() => evaluate(`Boolean(document.querySelector('[aria-label="React to message"]'))`), "reaction actions");
  const assistantRow = `[data-slot="message"][data-role="assistant"]`;
  async function openPicker() {
    await until(() => evaluate(`Boolean(document.querySelector('${assistantRow} [aria-label="React to message"]'))`), "hydrated reaction action");
    await evaluate(`(() => { const button = document.querySelector('${assistantRow} [aria-label="React to message"]'); button.focus(); button.click(); return true; })()`);
    await until(() => evaluate(`Boolean(document.querySelector('[aria-label="Another emoji"]'))`), "reaction picker");
  }
  async function click(label: string) {
    await evaluate(`document.querySelector('button[aria-label=${JSON.stringify(label)}]').click()`);
  }
  async function fill(value: string) {
    await evaluate(`(() => { const input = document.querySelector('[aria-label="Another emoji"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
  }
  async function submit() {
    await evaluate(`document.querySelector('[aria-label="Another emoji"]').closest('form').requestSubmit()`);
  }
  async function finishFeedback() {
    await until(() => p.turnsOf(id).some(turn => turn.reactionEvent && turn.status === "queued"), "feedback turn");
    for (const turn of p.turnsOf(id).filter(turn => turn.reactionEvent && turn.status === "queued")) {
      check("reaction feedback is bound to its message and cannot approve outward actions", String(turn.prompt).includes("Reaction on message") && String(turn.prompt).includes("never approval") && Boolean(turn.outsideAt));
      await call("codex:claimTurn", { token, id: turn._id });
      await call("codex:finishTurn", { token, id: turn._id, response: "NO_REPLY" });
      await call("codex:finalizeTurn", { id: turn._id });
    }
    await until(async () => !(await p.getChat(id)).isRunning, "quiet feedback completion");
  }
  async function shot(name: string) {
    const png = await browser.send("Page.captureScreenshot", { format: "png" }) as { data: string };
    writeFileSync(join(out, name), Buffer.from(png.data, "base64"));
  }

  await openPicker();
  await click("React with 👍");
  await until(async () => (await messages(id)).find(message => message.id === assistantMessage)?.reactions?.owner === "👍", "saved preset");
  await finishFeedback();
  check("preset reaction saves without adding chat text", (await messages(id)).length === 2 && await evaluate(`document.querySelector('${assistantRow} [data-message-reactions]').innerText.includes('👍')`));
  await openPicker();
  await fill("done"); await submit();
  await until(() => evaluate(`Boolean(document.querySelector('[data-slot="popover-content"] [role="alert"]'))`), "invalid emoji error");
  check("invalid text keeps the picker open and preserves the saved reaction", (await messages(id)).find(message => message.id === assistantMessage)?.reactions?.owner === "👍");
  await fill("🧩"); await submit();
  await until(async () => (await messages(id)).find(message => message.id === assistantMessage)?.reactions?.owner === "🧩", "custom emoji");
  await finishFeedback();
  check("custom emoji can replace a preset", await evaluate(`document.querySelector('${assistantRow} [data-message-reactions]').innerText.includes('🧩')`));
  const beforeReload = await evaluate("performance.timeOrigin");
  await browser.send("Page.reload");
  await until(() => evaluate(`performance.timeOrigin !== ${beforeReload} && Boolean(document.querySelector('${assistantRow} [aria-label*="reacted 🧩"]'))`), "persisted reaction after reload");
  check("reaction persists through reload", true);
  await openPicker();
  await browser.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await browser.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await until(() => evaluate(`!document.querySelector('[aria-label="Another emoji"]')`), "Escape dismissal");
  check("Escape dismisses the popover and restores trigger focus", await evaluate(`document.activeElement?.getAttribute('aria-label') === 'React to message'`));
  await evaluate(`document.querySelector('${assistantRow} [aria-label*="reacted 🧩"]').click()`);
  await until(async () => !(await messages(id)).find(message => message.id === assistantMessage)?.reactions?.owner, "reaction removal");
  await finishFeedback();
  check("reaction can be removed without extra text", (await messages(id)).length === 2);

  const prompt = "Please check the itinerary quietly.";
  await call("dashboard:sendChat", { key: KEY, id, text: prompt });
  await until(() => p.turnsOf(id).some(turn => turn.prompt === prompt && turn.status === "queued"), "work request");
  const work = p.turnsOf(id).find(turn => turn.prompt === prompt && turn.status === "queued")!;
  await call("codex:claimTurn", { token, id: work._id });
  async function react(emoji: string) {
    const response = await fetch(`${BASE}/api/backend/http/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-perry-chat": id }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "react_to_message", arguments: { emoji } } }) });
    const rpc = await response.json() as { result?: { content: Array<{ text: string }> } };
    check(`Perry can set web reaction ${emoji}`, JSON.parse(rpc.result!.content[0].text).status === "sent");
  }
  await react("🤔");
  await until(() => evaluate(`Boolean(document.querySelector('[aria-label="Perry reacted 🤔"]'))`), "live progress reaction");
  check("Perry's progress reaction is visible while work runs", (await messages(id)).some(message => message.pending && message.reactions?.perry === "🤔"));
  await react("👍");
  await call("turnStreams:append", { token, id: work._id, offset: 0, text: "NO_REPLY" });
  check("web streaming suppresses the quiet-reply sentinel", await call("turnStreams:getChatStream", { key: KEY, id }) === null);
  await call("codex:finishTurn", { token, id: work._id, response: "NO_REPLY" });
  await call("codex:finalizeTurn", { id: work._id });
  await until(async () => !(await p.getChat(id)).isRunning, "reaction-only work completion");
  check("progress persists when the pending message becomes saved history", (await messages(id)).some(message => message.text === prompt && !message.pending && message.reactions?.perry === "👍"));
  check("reaction-only work adds no empty or sentinel reply", (await messages(id)).filter(message => message.role === "assistant").length === 1 && !await evaluate(`document.body.innerText.includes('NO_REPLY')`));
  await evaluate(`(() => { const row = [...document.querySelectorAll('[data-slot="message"][data-role="user"]')].find(row => row.innerText.includes(${JSON.stringify(prompt)})); row.querySelector('[data-message-reactions] button').click(); return true; })()`);
  await until(async () => (await messages(id)).find(message => message.text === prompt)?.reactions?.owner === "👍", "shared reaction");
  await finishFeedback();
  check("shared emoji displays both actors without changing Perry's reaction", (await messages(id)).some(message => message.text === prompt && message.reactions?.owner === "👍" && message.reactions?.perry === "👍") && await evaluate(`Boolean(document.querySelector('[aria-label^="You and Perry reacted 👍"]'))`));
  check("reaction badges align with the owner's message bubble", await evaluate(`(() => {const row=[...document.querySelectorAll('[data-slot="message"][data-role="user"]')].find(row=>row.innerText.includes(${JSON.stringify(prompt)}));return Math.abs(row.querySelector('[data-message-reactions]').getBoundingClientRect().right-row.querySelector('[data-slot="bubble"]').getBoundingClientRect().right)<2;})()`));
  const other = await call<string>("dashboard:createChat", { key: KEY });
  let denied = false;
  try { await call("reactions:setWeb", { key: KEY, conversationId: other, messageId: assistantMessage, emoji: "❤️" }); } catch { denied = true; }
  check("cross-chat reaction writes are rejected", denied);
  denied = false;
  try { await call("reactions:setWeb", { key: "wrong", conversationId: id, messageId: assistantMessage, emoji: "❤️" }); } catch { denied = true; }
  check("reaction writes require dashboard authentication", denied);
  await shot("desktop.png");
  await evaluate("document.documentElement.classList.remove('dark'); document.documentElement.style.colorScheme='light'; true");
  await shot("desktop-light.png");
  await evaluate("document.documentElement.classList.add('dark'); document.documentElement.style.colorScheme='dark'; true");
  await browser.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await browser.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  await openPicker();
  await until(() => evaluate(`document.querySelector('[aria-label="Another emoji"]').closest('[data-slot="popover-content"]').getAnimations().every(animation => animation.playState === 'finished')`), "picker entrance completes");
  p.notes.mobileControls = await evaluate(`(() => { const popup=document.querySelector('[data-slot="popover-content"]').getBoundingClientRect();return {width:innerWidth,popup:{left:popup.left,right:popup.right},choices:[...document.querySelectorAll('[aria-label^="React with"]')].map(button=>{const box=button.getBoundingClientRect();return {width:box.width,height:box.height};})};})()`);
  check("mobile reaction controls fit and have touch-sized choices", await evaluate(`(() => {const popup=document.querySelector('[data-slot="popover-content"]').getBoundingClientRect();return popup.left>=0&&popup.right<=innerWidth&&[...document.querySelectorAll('[aria-label^="React with"]')].every(button=>{const box=button.getBoundingClientRect();return box.width>=44&&box.height>=44;});})()`));
  await shot("mobile-picker.png");
  await browser.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  check("no browser runtime errors", browser.errors.length === 0);
} catch (cause) {
  failed = cause instanceof Error ? cause.stack : String(cause);
  p.check("journey completed", false, failed);
  console.error(failed);
  const browser = p.browser();
  if (browser) {
    p.notes.failurePage = await browser.evaluate("document.body.innerText").catch(() => "Page unavailable");
    const png = await browser.send("Page.captureScreenshot", { format: "png" }).catch(() => null) as { data: string } | null;
    if (png) writeFileSync(join(out, "failure.png"), Buffer.from(png.data, "base64"));
  }
} finally {
  const passed = await p.finish({ failure: failed, engine: "manual fixture runner; no model" });
  if (!passed || failed) process.exitCode = 1;
}
