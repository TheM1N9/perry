import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openChat } from "../browser";
import { FAKE_AGENT, perry, sleep } from "../engine-acp/harness";
import type { ChatMessage } from "../../convex/dashboard";
import type { Id } from "../../convex/_generated/dataModel";

// Production server, real SQLite/scheduler/uploads/runner, fake ACP model, isolated home and browser profiles.
// Failure cases: lost uploads/saves, duplicate retry, partial replacement, stale tabs, foreign attachment ids,
// a live reply writing into edited history, detached shared files, media-only/empty drafts, reload/order,
// Markdown and skill links, preview safety, and keyboard/mobile controls. Each run writes result.json and PNGs.
// pnpm build; PERRY_E2E_BROWSER=/path/to/chrome bun artifacts/message-edit/run.ts /tmp/message-edit-results

const outDir = process.argv[2];
if (!outDir) throw new Error("Pass an output directory.");
let fakeHome = "";
const p = await perry({ name: "message-edit", outDir, runnerEnv: (home) => {
  fakeHome = join(home, "fake-agent");
  mkdirSync(fakeHome, { recursive: true });
  writeFileSync(join(fakeHome, "grok-signed-in"), "test");
  const skill = join(home, "skills", "e2e-skill");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: e2e-skill\ndescription: A skill used only in this test.\n---\nRead the test message.\n");
  const codexHome = join(home, "codex-signed-out");
  const claudeHome = join(home, "claude-signed-out");
  mkdirSync(codexHome, { recursive: true }); mkdirSync(claudeHome, { recursive: true });
  return { PERRY_GROK_COMMAND: `${process.execPath} ${FAKE_AGENT} --profile grok`, FAKE_ACP_HOME: fakeHome,
    CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome, ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "" };
} });
const { call, until, KEY, BASE } = p;
let second: Awaited<ReturnType<typeof openChat>> | undefined;
const check = (name: string, pass: boolean) => { p.check(name, pass); if (!pass) throw new Error(name); };
const messages = async (id: string) => (await call<{ page: ChatMessage[] }>("dashboard:getChatMessages", { key: KEY, id, paginationOpts: { numItems: 50, cursor: null } })).page;
const user = async (id: string) => (await messages(id)).filter((message) => message.role === "user" && !message.pending).at(0)!;
const idle = (id: string) => until(async () => !(await p.getChat(id)).isRunning && (await messages(id)).some((message) => message.role === "assistant"), "idle reply");
const names = (message: ChatMessage) => message.attachments.map((item) => item.fileName).join(",");
async function refuses(args: object, text: string) {
  try { await call("dashboard:rewindChat", args); return false; } catch (cause) { return cause instanceof Error && cause.message.includes(text); }
}

try {
  p.start("server");
  await until(async () => Boolean(await call("dashboard:getStatus", { key: KEY })), "server");
  await call("dashboard:skipOnboarding", { key: KEY });
  p.start("runner");
  await until(async () => (await p.computers()).some((computer) => computer.online && computer.engines.some((engine) => engine.kind === "grok" && engine.signedIn)), "fake engine");
  const browser = await p.openBrowser();
  const evaluate = browser.evaluate;
  const click = async (label: string) => {
    const clicked = await evaluate(`(() => { const buttons = [...document.querySelectorAll('button')]; const button = buttons.find(b => b.getAttribute('aria-label') === ${JSON.stringify(label)} || b.textContent.trim() === ${JSON.stringify(label)}); if (!button || button.disabled) return false; button.click(); return true; })()`);
    if (!clicked) throw new Error(`No enabled button: ${label}`);
    await sleep(150);
  };
  const fill = async (selector: string, value: string) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('missing input'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const add = async (files: string[], editing = true) => {
    const root = await browser.send("DOM.getDocument");
    const found = await browser.send("DOM.querySelector", { nodeId: root.root.nodeId, selector: `${editing ? '[role="dialog"] ' : ""}input[type=file]` });
    await browser.send("DOM.setFileInputFiles", { nodeId: found.nodeId, files });
    await sleep(150);
  };
  const edit = async () => { await click("Edit and resend"); await until(() => evaluate(`Boolean(document.querySelector('#edit-composer'))`), "editor"); };
  const isDisabled = () => evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save and resend')?.disabled`);
  const navigate = async (id: string) => { await browser.send("Page.navigate", { url: `${BASE}/chat/${id}` }); await until(() => evaluate(`Boolean(document.querySelector('#composer'))`), "chat page"); };

  const fixtures = join(p.home, "fixtures"); mkdirSync(fixtures);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jcoUAAAAASUVORK5CYII=", "base64");
  const originalImage = join(fixtures, "original.png"); writeFileSync(originalImage, png);
  const replacement = join(fixtures, "replacement.png"); writeFileSync(replacement, png);
  const otherImage = join(fixtures, "other.png"); writeFileSync(otherImage, png);
  const note = join(fixtures, "note.txt"); writeFileSync(note, "A document kept through the edit.");
  const wave = Buffer.alloc(44 + 16000); wave.write("RIFF"); wave.writeUInt32LE(wave.length - 8, 4); wave.write("WAVEfmt ", 8); wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22); wave.writeUInt32LE(8000, 24); wave.writeUInt32LE(16000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write("data", 36); wave.writeUInt32LE(16000, 40);
  const audio = join(fixtures, "sound.wav"); writeFileSync(audio, wave);
  const pdf = join(fixtures, "file.pdf"); writeFileSync(pdf, "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF");
  const video = join(fixtures, "clip.webm");
  const videoBytes: number[] = await evaluate(`(async () => { const c = document.createElement('canvas'); c.width=64;c.height=64;const ctx=c.getContext('2d');ctx.fillStyle='teal';ctx.fillRect(0,0,64,64); const stream=c.captureStream(10); const recorder=new MediaRecorder(stream,{mimeType:'video/webm'}); const parts=[];recorder.ondataavailable=e=>parts.push(e.data);const done=new Promise(r=>recorder.onstop=r);recorder.start();await new Promise(r=>setTimeout(r,300));recorder.stop();await done;stream.getTracks().forEach(t=>t.stop());return [...new Uint8Array(await new Blob(parts).arrayBuffer())]; })()`);
  writeFileSync(video, Buffer.from(videoBytes));

  const id = await call<Id<"conversations">>("dashboard:createChat", { key: KEY });
  await navigate(id); await add([originalImage, note], false);
  await fill("#composer", "**Original** https://example.com $e2e-skill `$e2e-skill`"); await click("Send message"); await idle(id);
  const original = await user(id);
  check("original upload and Markdown links", names(original) === "original.png,note.txt" && await evaluate(`Boolean(document.querySelector('[data-role=user] strong') && document.querySelector('[data-role=user] a[href="https://example.com"]'))`));
  check("Markdown preserves skill links and code", await evaluate(`document.querySelectorAll('[data-role=user] [data-skill-mention="e2e-skill"]').length === 1 && document.querySelector('[data-role=user] code').textContent === '$e2e-skill'`));
  const branchId = await call<string>("dashboard:branchChat", { key: KEY, id, messageId: original.id });
  await edit();
  check("edit opens existing text and files", await evaluate(`document.querySelector('#edit-composer').value.includes('Original') && document.querySelector('[aria-label="Remove original.png"]') !== null && document.querySelector('[aria-label="Remove note.txt"]') !== null`));
  await click("Remove original.png"); await add([replacement, otherImage, video, audio, pdf]);
  await fill("#edit-composer", "Cancelled draft"); await click("Cancel");
  check("cancel preserves original and shared branch", JSON.stringify(await user(id)) === JSON.stringify(original) && names(await user(branchId)) === names(original));

  await edit(); await click("Remove original.png"); await add([replacement, otherImage, video, audio, pdf]); await fill("#edit-composer", "**Edited** https://example.com/edited");
  await p.shot("edit-desktop.png", '[role="dialog"]');
  await evaluate(`(() => { const real=window.fetch;let uploads=0;window.fetch=async (...args)=>{ if (String(args[0]) === '/api/media' && ++uploads === 2) {window.fetch=real;throw new Error('Test upload failure');}return real(...args);};return true; })()`);
  await click("Save and resend");
  await until(() => evaluate(`document.body.innerText.includes('Test upload failure')`), "upload error");
  check("failed upload preserves original and draft", JSON.stringify(await user(id)) === JSON.stringify(original) && await evaluate(`document.querySelector('#edit-composer').value.includes('Edited')`));
  const stagedBefore = p.rows("chatAttachments").filter((row) => row.editOf === original.id).length;
  check("first successful upload retained", stagedBefore === 1);
  await evaluate(`(() => { const real=window.fetch;window.fetch=async (...args)=>{ if (String(args[0]).includes('/api/backend/call') && String(args[1]?.body).includes('dashboard:rewindChat')) {window.fetch=real;throw new Error('Test save failure');}return real(...args);};return true; })()`);
  await click("Save and resend"); await until(() => evaluate(`document.body.innerText.includes('Test save failure')`), "save error");
  const staged = p.rows("chatAttachments").filter((row) => row.editOf === original.id).length;
  check("failed save preserves original without reupload", staged === 5 && JSON.stringify(await user(id)) === JSON.stringify(original));
  await evaluate(`(() => {const real=window.fetch;window.fetch=async(...args)=>{if(String(args[0]).includes('/api/backend/call') && String(args[1]?.body).includes('dashboard:rewindChat')) {window.lastEdit=JSON.parse(args[1].body).args;window.fetch=real;}return real(...args);};return true;})()`);
  await click("Save and resend"); await idle(id); await until(() => evaluate(`!document.querySelector('#edit-composer')`), "editor closes");
  const edited = await user(id);
  const expected = "note.txt,replacement.png,other.png,clip.webm,sound.wav,file.pdf";
  check("replace/add keeps final ordered files", names(edited) === expected && edited.text.startsWith("**Edited**"));
  check("retry does not duplicate uploads", p.rows("chatAttachments").filter((row) => row.editOf === original.id).length === staged);
  const sameRequest = await evaluate("window.lastEdit");
  const countBefore = p.rows("chatAttachments").length;
  await call("dashboard:rewindChat", sameRequest);
  check("lost response retry is idempotent", (await user(id)).id === edited.id && p.rows("chatAttachments").length === countBefore);
  check("branch and Library references survive detach", names(await user(branchId)) === names(original) && p.rows("library").some((row) => row.name === "original.png"));
  const turn = p.turnsOf(id).at(-1)!;
  p.notes.editedTurn = { prompt: turn.prompt, attachments: turn.attachments };
  p.notes.engineInputs = p.fakeLog(fakeHome).filter((entry) => entry.prompt).map((entry) => ({ prompt: entry.prompt }));
  check("real runner receives final files", turn.attachments.map((item: { fileName: string }) => item.fileName).join(",") === expected && !turn.attachments.some((item: { fileName: string }) => item.fileName === "original.png") && p.fakeLog(fakeHome).some((entry) => entry.prompt?.includes("replacement.png") && !entry.prompt.includes("original.png")));

  await navigate(id); await until(() => evaluate(`Boolean(document.querySelector('[aria-label="Preview replacement.png"]'))`), "reloaded files");
  check("reload persists edits", names(await user(id)) === expected);
  for (const [name, selector] of [["replacement.png", "img"], ["clip.webm", "video"], ["sound.wav", "audio"], ["file.pdf", "iframe"], ["note.txt", "[data-text-preview]"]]) {
    await click(`Preview ${name}`);
    check(`popup preview ${name}`, await evaluate(`Boolean(document.querySelector('[role="dialog"] ${selector}'))`));
    await click("Close");
  }
  const textAttachment = edited.attachments.find((file) => file.fileName === "note.txt")!;
  const served = await fetch(`${BASE}${textAttachment.url}?preview=1`, { headers: { cookie: `perry_media=${KEY}` } });
  check("document preview is plain text", served.headers.get("content-type")?.startsWith("text/plain") === true && (await served.text()).includes("document kept"));
  check("media needs authentication", (await fetch(`${BASE}${textAttachment.url}?preview=1`)).status === 401);

  await edit(); await fill("#edit-composer", "Text edit only"); await click("Save and resend"); await idle(id);
  check("text edit keeps files", names(await user(id)) === expected);
  await edit(); await fill("#edit-composer", ""); check("media-only save enabled", !(await isDisabled()));
  await click("Save and resend"); await idle(id); check("media-only edit persists", (await user(id)).text === "" && names(await user(id)) === expected);
  await edit();
  for (const name of expected.split(",")) await click(`Remove ${name}`);
  check("empty edit cannot save", await isDisabled());
  await browser.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
  await until(() => evaluate(`!document.querySelector('#edit-composer')`), "escape cancels");

  second = await openChat(BASE, KEY); await second.send("Page.navigate", { url: `${BASE}/chat/${id}` });
  await until(() => second!.evaluate(`Boolean(document.querySelector('[aria-label="Edit and resend"]'))`), "second tab");
  await edit(); await fill("#edit-composer", "Stale first tab draft");
  await second.evaluate(`document.querySelector('[aria-label="Edit and resend"]').click()`);
  await until(() => second!.evaluate(`Boolean(document.querySelector('#edit-composer'))`), "second tab editor");
  await second.evaluate(`(() => { const el=document.querySelector('#edit-composer'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'Second tab saved');el.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  await second.evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Save and resend').click()`);
  await idle(id); await click("Save and resend");
  await until(() => evaluate(`document.body.innerText.includes('That message changed')`), "stale revision error");
  check("stale edit rejected and draft retained", (await user(id)).text === "Second tab saved" && await evaluate(`document.querySelector('#edit-composer').value === 'Stale first tab draft'`));
  await click("Cancel"); second.close(); second = undefined;

  const current = await user(id);
  const foreign = (await user(branchId)).attachments[0].id!;
  check("foreign attachment rejected atomically", await refuses({ key: KEY, id, messageId: current.id, text: "unauthorized", attachmentIds: [foreign], requestId: crypto.randomUUID() }, "no longer available") && JSON.stringify(await user(id)) === JSON.stringify(current));
  check("wrong owner key rejected", await refuses({ key: "wrong", id, messageId: current.id, text: "unauthorized" }, "Wrong dashboard key"));
  await call("dashboard:sendChat", { key: KEY, id, text: "SLOW" });
  await until(async () => p.turnsOf(id).some((row) => row.status === "running"), "active reply");
  await edit(); await fill("#edit-composer", "Edited after stopping");
  check("active reply allows drafting but blocks save", await isDisabled() && await evaluate(`document.body.innerText.includes('Finish or stop the current reply')`));
  const beforeBusy = p.rows("chatAttachments").length;
  check("server blocks active edit and rolls back references", await refuses({ key: KEY, id, messageId: current.id, text: "busy edit", attachmentIds: current.attachments.flatMap((file) => file.id ? [file.id] : []), requestId: crypto.randomUUID() }, "Wait for the reply") && p.rows("chatAttachments").length === beforeBusy);
  await click("Stop reply"); await idle(id);
  await until(async () => !(await isDisabled()), "save after stop"); await click("Save and resend"); await idle(id);
  check("stop then edit uses fresh session", (await user(id)).text === "Edited after stopping" && !p.turnsOf(id).some((row) => row.status === "running"));
  await browser.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await edit(); await p.shot("edit-mobile.png", '[role="dialog"]');
  check("mobile editor fits and controls are labelled", await evaluate(`(() => {const dialog=document.querySelector('[role="dialog"]');const save=[...dialog.querySelectorAll('button')].find(b=>b.textContent.trim()==='Save and resend');return dialog.scrollWidth <= dialog.clientWidth + 1 && save.getBoundingClientRect().right <= innerWidth && document.querySelector('[aria-label="Remove replacement.png"]') !== null;})()`));
  const mobileFile = join(fixtures, "mobile.txt"); writeFileSync(mobileFile, "Mobile upload");
  await add([mobileFile]);
  await evaluate(`(() => {const real=window.fetch;window.fetch=async(...args)=>{if(String(args[0])==='/api/media'){window.fetch=real;await new Promise(r=>setTimeout(r,1500));throw new Error('Mobile upload failure');}return real(...args);};return true;})()`);
  await click("Save and resend");
  check("mobile upload status and Save fit", await evaluate(`(() => {const dialog=document.querySelector('[role="dialog"]');const save=[...dialog.querySelectorAll('button')].find(b=>b.textContent.trim()==='Save and resend');return dialog.innerText.includes('Uploading') && dialog.scrollWidth <= dialog.clientWidth + 1 && save.getBoundingClientRect().right <= innerWidth;})()`));
  await until(() => evaluate(`document.body.innerText.includes('Mobile upload failure')`), "mobile upload error");
  await click("Remove mobile.txt");
  for (const name of expected.split(",")) await click(`Remove ${name}`);
  await fill("#edit-composer", "Text without files");
  await evaluate(`document.querySelector('#edit-composer').focus()`);
  await browser.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter" });
  await idle(id);
  check("keyboard saves a text-only edit", (await user(id)).text === "Text without files" && (await user(id)).attachments.length === 0);
  await navigate(id); await click("Write this reply again"); await idle(id);
  check("regeneration still works after removing files", (await user(id)).attachments.length === 0);
  const uploadId = crypto.randomUUID();
  const upload = () => fetch(`${BASE}/api/media`, { method: "POST", headers: { cookie: `perry_media=${KEY}`, "x-upload-id": uploadId, "x-file-name": "retry.txt" }, body: "Same upload" }).then((response) => response.json());
  const uploadedFile: { path: string } = await upload();
  check("lost upload response retry reuses file", uploadedFile.path === (await upload()).path);
  const unassociated = await call<string>("dashboard:registerAttachment", { key: KEY, conversationId: id, messageKey: crypto.randomUUID(), localPath: uploadedFile.path, fileName: "retry.txt", contentType: "text/plain", size: 11 });
  const final = await user(id);
  check("another message's attachment in the same chat is rejected", await refuses({ key: KEY, id, messageId: final.id, text: "Wrong files", attachmentIds: [unassociated], requestId: crypto.randomUUID() }, "no longer available") && JSON.stringify(await user(id)) === JSON.stringify(final));
  check("no browser exceptions", browser.errors.length === 0);
} catch (cause) {
  p.check("completed", false);
  p.notes.failure = cause instanceof Error ? cause.stack : String(cause);
  p.notes.serverLog = p.logs.server.split("\n").slice(-25);
  await p.shot("failure.png", "body").catch(() => {});
} finally {
  second?.close();
  const passed = await p.finish({ coverage: "production browser + HTTP + SQLite + real runner; fake ACP model, no real model or messaging accounts" });
  process.exitCode = passed ? 0 : 1;
}
