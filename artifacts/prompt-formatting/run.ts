import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FAKE_AGENT, perry, sleep } from "../engine-acp/harness";

// Failure inventory and design: docs/prompt-formatting.md. Only synthetic chats/engines.
// pnpm exec bun artifacts/prompt-formatting/run.ts W:/perry-qa/prompt-formatting-20261021
const outDir = process.argv[2];
if (!outDir) throw new Error("Pass an output directory");
const p = await perry({ name: "prompt-formatting", outDir, runnerEnv: (home) => {
  const fake = join(home, "fake"); mkdirSync(fake, { recursive: true });
  writeFileSync(join(fake, "grok-signed-in"), "synthetic");
  return { PERRY_GROK_COMMAND: `${process.execPath} ${FAKE_AGENT} --profile grok`, FAKE_ACP_HOME: fake,
    CODEX_HOME: join(home, "codex-signed-out"), CLAUDE_CONFIG_DIR: join(home, "claude-signed-out"), ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "" };
} });
try {
  p.start("server");
  await p.until(() => fetch(`${p.BASE}/api/backend/http/health`).then((r) => r.ok), "isolated server", 120);
  await p.call("dashboard:skipOnboarding", { key: p.KEY });
  p.start("runner");
  await p.until(async () => (await p.computers()).some((c) => c.online && c.engines.some((e) => e.kind === "grok" && e.signedIn)), "fake engine", 90);
  const { evaluate: e, send, errors } = await p.openBrowser();
  const click = async (label: string) => {
    const point = await e(`(() => { const root=document.querySelector('[role="dialog"]') || document; const b = [...root.querySelectorAll('button')].find(x => x.getAttribute('aria-label') === ${JSON.stringify(label)} || x.textContent.trim() === ${JSON.stringify(label)}); if (!b) throw Error('Missing button: ' + ${JSON.stringify(label)}); b.scrollIntoView({block:'center'}); const r=b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
    await sleep(150);
  };
  const value = () => e(`document.querySelector('#composer').value`) as Promise<string>;
  const type = async (text: string) => {
    await e(`(() => {const t=document.querySelector('#composer'); t.focus(); t.select(); return true;})()`);
    await send("Input.insertText", { text }); await sleep(150);
  };
  const select = async (start: number, end: number) => e(`(() => { const t=document.querySelector('#composer'); t.focus(); t.setSelectionRange(${start},${end}); return true;})()`);
  const key = async (key: string, code: string, modifiers = 0, windowsVirtualKeyCode = 0) => {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, modifiers, windowsVirtualKeyCode, ...(key === "Enter" ? { text: "\r" } : {}) });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers, windowsVirtualKeyCode });
    await sleep(150);
  };
  await type("Keep this sentence."); await select(5, 9);
  await click("Formatting options"); await click("Bold");
  p.check("selectionFormatting", await value() === "Keep **this** sentence.");
  await key("z", "KeyZ", 2, 90);
  p.check("nativeUndo", await value() === "Keep this sentence.");
  await key("y", "KeyY", 2, 89);
  p.check("nativeRedo", await value() === "Keep **this** sentence.");
  await type("alpha\n  beta\n\ngamma"); await select(0, 19);
  await click("Bullet list");
  p.check("listsPreserveIndentAndBlankLines", await value() === "- alpha\n  - beta\n\n- gamma");
  await click("Bullet list");
  p.check("listToggle", await value() === "alpha\n  beta\n\ngamma");
  await type("before code after"); await select(7, 11); await click("Code block");
  p.check("codeBlockBoundaries", await value() === "before \n```\ncode\n```\n after");
  await type("```nested```\n    indented"); await select(0, (await value()).length); await click("Code block");
  p.check("nestedFenceEscaped", (await value()).startsWith("````\n```nested```"));
  const structured = "Paragraph one.\n\n1. First\n2. Second\n\n```ts\nconst value = 1;\n```\n<script>window.__unsafe = true</script>";
  await type(structured); await click("Preview");
  p.check("safeStructuredPreview", await e(`Boolean(document.querySelector('[aria-label="Prompt preview"] ol') && document.querySelector('[aria-label="Prompt preview"] pre') && !window.__unsafe && !document.querySelector('[aria-label="Prompt preview"] script'))`));
  p.check("previewRetainsExactSource", await value() === structured);
  await p.shot("preview-desktop.png");
  await click("Edit Markdown");
  p.check("returnToEditor", await e(`document.activeElement.id === 'composer'`));
  await select(0, 9); await key("b", "KeyB", 2, 66);
  p.check("keyboardBold", (await value()).startsWith("**Paragraph** one."));
  await key("b", "KeyB", 2, 66);
  p.check("keyboardFormatToggle", await value() === structured);
  await type("line one"); await select(8, 8); await key("Enter", "Enter", 8, 13);
  p.check("shiftEnterDoesNotSend", await value() === "line one\n" && p.rows("codexTurns").length === 0);
  await e(`(() => { const t=document.querySelector('#composer'); t.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true, isComposing:true})); return true;})()`);
  p.check("imeEnterDoesNotSend", p.rows("codexTurns").length === 0);
  await type("/thi");
  p.check("commandSuggestionsRemain", await e(`Boolean(document.querySelector('[role="listbox"]'))`));
  await type(structured);
  const beforeReload = await e("performance.timeOrigin");
  await send("Page.reload");
  await p.until(() => e(`performance.timeOrigin !== ${beforeReload} && document.querySelector('#composer')?.value === ${JSON.stringify(structured)}`), "draft restored in the new document", 30);
  p.check("reloadPreservesDraft", await value() === structured);
  await click("Formatting options");
  await send("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
  await sleep(200);
  p.check("mobileNoHorizontalOverflow", await e(`document.documentElement.scrollWidth <= innerWidth`));
  await p.shot("composer-mobile.png");
  await click("Preview");
  await click("Send message");
  await p.until(() => p.rows("codexTurns").some((turn) => turn.prompt === structured), "structured prompt submitted", 60);
  p.check("submittedSourceUnchanged", p.rows("codexTurns").some((turn) => turn.prompt === structured));
  await p.until(async () => (await value()) === "", "draft cleared after send", 30);
  p.check("submittedDraftCleared", await e(`!sessionStorage.getItem('perry.prompt.new')`));
  p.check("sendingPreviewReturnsToEditor", await e(`!document.querySelector('[aria-label="Prompt preview"]') && !document.querySelector('#composer').hidden`));
  await p.until(() => p.rows("codexTurns").some((turn) => turn.prompt === structured && turn.status === "done"), "fake reply finishes", 60);
  await click("Edit and resend");
  await p.until(() => e(`Boolean(document.querySelector('#edit-composer'))`), "message editor", 20);
  p.check("messageEditorRetainsSource", await e(`document.querySelector('#edit-composer').value === ${JSON.stringify(structured)}`));
  await e(`(() => { const t=document.querySelector('#edit-composer'); t.focus(); t.setSelectionRange(0,9); return true; })()`);
  await key("i", "KeyI", 2, 73);
  const edited = "_Paragraph_" + structured.slice(9);
  p.check("editFormattingAndDraftIsolation", await e(`document.querySelector('#edit-composer').value === ${JSON.stringify(edited)} && document.querySelector('#composer').value === ''`));
  await click("Save and resend");
  await p.until(() => p.rows("codexTurns").some((turn) => turn.prompt === edited), "formatted edit submitted", 60);
  p.check("formattedEditSubmitted", true);
  p.check("noBrowserExceptions", errors.length === 0, errors);
} catch (error) { p.notes.stoppedAt = String(error instanceof Error ? error.stack : error); p.check("completed", false); }
process.exit(await p.finish() ? 0 : 1);
