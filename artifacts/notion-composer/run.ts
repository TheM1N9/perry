import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FAKE_AGENT, perry, sleep } from "../engine-acp/harness";

// The composer formats as it is typed, Notion's way (components/dashboard/chat/prompt-editor.tsx), in place of the
// "Formatting options" row and its preview (docs/prompt-formatting.md). Only a synthetic chat and a fake engine.
//
// How it could fail, each checked below:
//   1. The old formatting button or preview is still there.
//   2. Markdown typed stays as marks: **bold**, _italic_, `code`, ~~strike~~ not formatted, or the markers left in.
//   3. "- ", "1. ", "> ", "## " or "```" at a line's start make no list, quote, heading or code.
//   4. Enter sends from inside a list or code (it must go on writing them), or Shift+Enter sends anywhere.
//   5. Enter does not send a plain line; Ctrl+Enter does not send from inside a list.
//   6. What is sent is not Markdown, or plain text in it is escaped: foo\_bar, C:\\Users, &lt;div&gt;.
//   7. Backspace right after a shortcut does not take the formatting back.
//   8. Pasted plain text loses its line breaks or indentation, or gets formatted; lines from VS Code are not code.
//   9. Command (/) and skill ($) suggestions no longer show, pick, or say what they offer to screen readers.
//  10. A bare Ctrl+B in the box no longer opens or closes the sidebar; with words chosen it does not bold them.
//  11. Enter while an IME is composing sends.
//  12. A draft is not shown formatted again after a reload; a sent one is not cleared.
//  13. Editing a sent message does not show its formatting, or does not take the focus.
//  14. A phone's width overflows; the page throws.
// pnpm build && pnpm exec bun artifacts/notion-composer/run.ts artifacts/notion-composer
const outDir = process.argv[2];
if (!outDir) throw new Error("Pass an output directory");
const p = await perry({ name: "notion-composer", outDir, runnerEnv: (home) => {
  const fake = join(home, "fake"); mkdirSync(fake, { recursive: true });
  writeFileSync(join(fake, "grok-signed-in"), "synthetic");
  return { PERRY_GROK_COMMAND: `${process.execPath} ${FAKE_AGENT} --profile grok`, FAKE_ACP_HOME: fake,
    CODEX_HOME: join(home, "codex-signed-out"), CLAUDE_CONFIG_DIR: join(home, "claude-signed-out"), ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "" };
} });
// A skill to mention with $.
mkdirSync(join(p.home, "skills", "review-pr"), { recursive: true });
writeFileSync(join(p.home, "skills", "review-pr", "SKILL.md"), "---\nname: review-pr\ndescription: Review a pull request.\n---\n\nReview it.\n");

const BACKSLASH = String.fromCharCode(92);
try {
  p.start("server");
  await p.until(() => fetch(`${p.BASE}/api/backend/http/health`).then((r) => r.ok), "isolated server", 120);
  await p.call("dashboard:skipOnboarding", { key: p.KEY });
  p.start("runner");
  await p.until(async () => (await p.computers()).some((c) => c.online && c.engines.some((e) => e.kind === "grok" && e.signedIn)), "fake engine", 90);
  const { evaluate: e, send, errors } = await p.openBrowser();
  await p.until(() => e(`Boolean(document.querySelector('#composer[contenteditable="true"]'))`), "the composer's editor", 60);

  const key = async (key: string, code: string, modifiers = 0, windowsVirtualKeyCode = 0) => {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, modifiers, windowsVirtualKeyCode, ...(key === "Enter" && !(modifiers & 2) ? { text: "\r" } : {}) });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers, windowsVirtualKeyCode });
    await sleep(120);
  };
  const enter = (modifiers = 0) => key("Enter", "Enter", modifiers, 13);
  /** Typed a character at a time, as keys would: the shortcuts read what was just typed. */
  const type = async (text: string) => { for (const ch of text) await send("Input.insertText", { text: ch }); await sleep(150); };
  const focus = () => e(`(() => { document.querySelector('#composer').focus(); return true; })()`);
  const clear = async () => { await focus(); await key("a", "KeyA", 2, 65); await key("Backspace", "Backspace", 0, 8); await sleep(150); };
  const draft = () => e(`sessionStorage.getItem('perry.prompt.new') ?? ''`) as Promise<string>;
  const html = () => e(`document.querySelector('#composer').innerHTML`) as Promise<string>;
  const shown = () => e(`document.querySelector('#composer').innerText`) as Promise<string>;
  const has = (selector: string) => e(`Boolean(document.querySelector('#composer ${selector}'))`) as Promise<boolean>;
  const turns = () => p.rows("codexTurns");
  const click = async (label: string) => {
    const point = await e(`(() => { const root=document.querySelector('[role="dialog"]') || document; const b = [...root.querySelectorAll('button')].find(x => x.getAttribute('aria-label') === ${JSON.stringify(label)} || x.textContent.trim() === ${JSON.stringify(label)}); if (!b) throw Error('Missing button: ' + ${JSON.stringify(label)}); b.scrollIntoView({block:'center'}); const r=b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", ...point as object, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point as object, button: "left", clickCount: 1 });
    await sleep(200);
  };

  // 1. No formatting button, no preview.
  p.check("noFormattingButton", await e(`![...document.querySelectorAll('button')].some((b) => ['Formatting options', 'Preview', 'Edit Markdown'].includes(b.getAttribute('aria-label') ?? b.textContent.trim()))`) as boolean);

  // 2. Inline Markdown formats as it is typed, its markers gone from the box but kept in what is sent.
  await focus();
  await type("Fix the **login** bug in `auth.ts` _soon_ and ~~later~~ ok");
  const inline = { html: await html(), shown: await shown(), draft: await draft() };
  p.notes.inline = inline;
  p.check("inlineFormatsAsTyped", inline.html.includes("<strong>login</strong>") && inline.html.includes("<code>auth.ts</code>")
    && inline.html.includes("<em>soon</em>") && inline.html.includes("<s>later</s>") && !/[*`~]/.test(inline.shown.replace(/_/g, "")) && !inline.shown.includes("_soon_"));
  p.check("inlineSentAsMarkdown", inline.draft === "Fix the **login** bug in `auth.ts` *soon* and ~~later~~ ok", inline.draft);
  await p.shot("inline-1280.png", "[data-composer]");

  // 7. Backspace right after a shortcut takes it back.
  await clear();
  await type("**x**");
  const formatted = await has("strong");
  await key("Backspace", "Backspace", 0, 8);
  p.check("backspaceUndoesShortcut", formatted && !(await has("strong")) && (await shown()).includes("**x**"), { formatted, html: await html() });

  // 3 and 4. Blocks from a line's start; Enter goes on writing a list and ends it from an empty item, without sending.
  await clear();
  await type("- first"); await enter(8); await type("second"); await enter(); await type("third"); await enter(); await enter();
  await type("after");
  p.check("bulletListAsTyped", await e(`document.querySelectorAll('#composer ul > li').length`) === 3);
  p.check("enterInListDoesNotSend", turns().length === 0 && await draft() === "- first\n- second\n- third\n\nafter", await draft());
  await clear();
  await type("1. one"); await enter(); await type("two");
  p.check("orderedListAsTyped", await e(`document.querySelectorAll('#composer ol > li').length`) === 2 && await draft() === "1. one\n2. two", await draft());
  await clear();
  await type("> quoted");
  const quote = await has("blockquote");
  await clear();
  await type("## Steps");
  p.check("quoteAndHeadingAsTyped", quote && await has("h2") && await draft() === "## Steps", await draft());

  // Code: "```ts" and Enter starts it; Enter in it is a new line; its text is never escaped.
  await clear();
  await type("```ts"); await enter();
  await type("const a = 1;"); await enter(); await type("b_c *d*");
  p.check("codeBlockAsTyped", await has("pre code") && turns().length === 0, await html());
  p.check("codeBlockSentAsFence", await draft() === "```ts\nconst a = 1;\nb_c *d*\n```", await draft());

  // 6. Plain text exactly as typed.
  const plain = `rename foo_bar_baz in C:${BACKSLASH}Users${BACKSLASH}x <div> for 2 * 3 [a](b)`;
  await clear();
  await type(plain);
  p.check("plainTextNotEscaped", await draft() === plain, await draft());

  // 8. Pasted text: plain text as copied, line by line; lines from VS Code as code.
  const pasted = "line 1\n  indented * not_italic\n\nlast";
  const paste = (types: Record<string, string>) => e(`(() => { const data = new DataTransfer(); for (const [type, value] of Object.entries(${JSON.stringify(types)})) data.setData(type, value);
    document.querySelector('#composer').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })); return true; })()`);
  await clear();
  await paste({ "text/plain": pasted });
  await sleep(200);
  p.check("plainPasteVerbatim", await draft() === pasted && !(await has("em")), await draft());
  await clear();
  await paste({ "text/plain": "const x = 1;\nif (x) go();", "text/html": "<div><span>const x = 1;</span></div><div><span>if (x) go();</span></div>", "vscode-editor-data": JSON.stringify({ mode: "typescript" }) });
  await sleep(200);
  p.check("vscodePasteIsCode", await has("pre code") && await draft() === "```typescript\nconst x = 1;\nif (x) go();\n```", await draft());

  // 11. Enter while an IME composes does not send.
  await clear();
  await type("こんにちは");
  await e(`(() => { document.querySelector('#composer').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true })); return true; })()`);
  await sleep(300);
  p.check("imeEnterDoesNotSend", turns().length === 0);

  // 9. Suggestions: commands, then a skill picked with Enter.
  await clear();
  await type("/thi");
  const commands = await e(`(() => { const box = document.querySelector('#composer'); return { list: Boolean(document.querySelector('#chat-commands')), expanded: box.getAttribute('aria-expanded'),
    active: box.getAttribute('aria-activedescendant'), role: box.getAttribute('role') }; })()`) as { list: boolean; expanded: string; active: string; role: string };
  p.check("commandSuggestions", commands.list && commands.expanded === "true" && commands.active === "chat-command-0" && commands.role === "combobox", commands);
  await key("Tab", "Tab", 0, 9);
  p.check("commandPicked", (await draft()).startsWith("/think") && await e(`document.activeElement?.id === 'composer'`) as boolean, await draft());
  await clear();
  await type("please $rev");
  // The skills are read when a $ is first typed.
  await p.until(() => e(`Boolean(document.querySelector('#chat-command-0'))`) as Promise<boolean>, "the skill suggested", 30);
  p.check("skillSuggested", await e(`document.querySelector('#chat-commands')?.getAttribute('aria-label')`) === "Skills"
    && await e(`document.querySelector('#chat-command-0')?.textContent.includes('$review-pr')`) as boolean);
  await enter();
  await type("now");
  p.check("skillPicked", await draft() === "please $review-pr now" && turns().length === 0, await draft());

  // 10. Ctrl+B: bare, the sidebar; with words chosen, bold.
  const sidebar = () => e(`document.querySelector('[data-slot="sidebar"][data-state]')?.getAttribute('data-state') ?? null`) as Promise<string | null>;
  await clear();
  await type("make me bold");
  const before = await sidebar();
  await key("b", "KeyB", 2, 66);
  const after = await sidebar();
  p.check("bareCtrlBTogglesSidebar", before !== null && after !== null && before !== after && !(await has("strong")), { before, after });
  await key("b", "KeyB", 2, 66);
  await focus();
  await key("a", "KeyA", 2, 65); await key("b", "KeyB", 2, 66);
  p.check("ctrlBBoldsChosenWords", await has("strong") && await draft() === "**make me bold**" && await sidebar() === before, await draft());

  // 12. A draft comes back formatted after a reload.
  await clear();
  await type("Keep **this** draft");
  const reloaded = await e("performance.timeOrigin");
  await send("Page.reload");
  await p.until(() => e(`performance.timeOrigin !== ${reloaded} && Boolean(document.querySelector('#composer strong'))`), "the draft shown formatted again", 30);
  p.check("reloadRestoresFormatted", await draft() === "Keep **this** draft" && (await shown()).trim() === "Keep this draft");

  // 5. Shift+Enter is a new paragraph, Ctrl+Enter sends from a list, and what is sent is the Markdown.
  await clear();
  await type("Fix the **login** bug in `auth.ts`"); await enter(8);
  await type("- check foo_bar"); await enter(8); await type("then $HOME");
  p.check("shiftEnterDoesNotSend", turns().length === 0);
  const expected = "Fix the **login** bug in `auth.ts`\n\n- check foo_bar\n- then $HOME";
  p.check("draftBeforeSend", await draft() === expected, await draft());
  await p.shot("composed-1280.png", "[data-composer]");
  await enter(2);
  await p.until(() => turns().some((turn) => turn.prompt === expected), "the formatted prompt sent", 60);
  p.check("modEnterSendsMarkdown", true);
  await p.until(async () => await draft() === "" && (await shown()).trim() === "", "the composer cleared", 30);
  p.check("sentDraftCleared", await e(`!sessionStorage.getItem('perry.prompt.new')`) as boolean);
  await p.until(() => turns().some((turn) => turn.prompt === expected && turn.status === "done"), "the fake reply", 90);

  // 13. Editing a sent message shows its formatting and takes the focus.
  await click("Edit and resend");
  await p.until(() => e(`Boolean(document.querySelector('#edit-composer[contenteditable="true"]'))`), "the message editor", 20);
  await sleep(300);
  const editing = await e(`(() => { const box = document.querySelector('#edit-composer'); return { strong: Boolean(box.querySelector('strong')), list: box.querySelectorAll('li').length,
    focused: box.contains(document.activeElement) || document.activeElement === box, main: document.querySelector('#composer').innerText.trim() }; })()`) as { strong: boolean; list: number; focused: boolean; main: string };
  p.check("messageEditorFormatted", editing.strong && editing.list === 2 && editing.focused && editing.main === "", editing);
  await click("Cancel");

  // 14. A phone.
  await clear();
  await type("A long line on a phone with **bold** words and `code` that should wrap rather than push the page sideways at all");
  await send("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
  await sleep(300);
  p.check("phoneNoOverflow", await e(`document.documentElement.scrollWidth <= innerWidth`) as boolean);
  await p.shot("composer-390.png", "[data-composer]");
  p.check("noBrowserExceptions", errors.length === 0, errors);
} catch (error) { p.notes.stoppedAt = String(error instanceof Error ? error.stack : error); p.check("completed", false); }
process.exit(await p.finish() ? 0 : 1);
