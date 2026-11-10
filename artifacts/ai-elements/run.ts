import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FAKE_AGENT, perry, sleep } from "../engine-acp/harness";

// bun artifacts/ai-elements/run.ts <outDir>
// The chat on shadcn/ui's AI Elements (https://ui.shadcn.com/docs/ai-elements):
// your message a Bubble inside a Message, the reply's fenced code a Code Block
// highlighted by Shiki, and the reply's work a Trace (artifacts/inline-steps and
// artifacts/live-work check the Trace step by step).
//
// No model runs: the engine is the fake ACP agent playing Grok Build, its SAY
// prompt giving the reply word for word. Everything else is real: a fresh Perry
// from the production build (`pnpm build` first) on a spare port, its own
// PERRY_HOME, the real runner, and the chat in headless Chrome.
//
// Ways it could fail, written down before the checks:
//   1. Your message is not a Bubble at the end of its row, or the reply is boxed.
//   2. The reply's code is not a Code Block, names the wrong language, or is
//      not highlighted (no Shiki colours) for a language Perry knows.
//   3. A language Perry does not know breaks the block instead of showing plain text.
//   4. The code's text changes on the way (a line lost, joined or added).
//   5. "Copy code" is missing, or copies something other than the code.
//   6. The Trace fold is gone, or opens to nothing.
//   7. The colours are unreadable in dark (Shiki's light colours left on).
//   8. The page throws, in light or dark.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/ai-elements/run.ts <outDir>");
const CODE = ["const answer: number = 42;", "", "export function ask() {", "  return answer;", "}"].join("\n");
const REPLY = ["Here it is:", "", "```ts", CODE, "```", "", "And in a language I don't colour:", "", "```brainfuck", "++[>+<-]", "```", ""].join("\n");
let fakeHome = "";
const p = await perry({
  name: "ai-elements",
  outDir,
  runnerEnv: (home) => {
    fakeHome = join(home, "fake-grok");
    mkdirSync(fakeHome, { recursive: true });
    writeFileSync(join(fakeHome, "grok-signed-in"), "yes");
    mkdirSync(join(home, "no-codex"), { recursive: true });
    mkdirSync(join(home, "no-claude"), { recursive: true });
    return { PERRY_GROK_COMMAND: `${process.execPath} ${FAKE_AGENT} --profile grok`, FAKE_ACP_HOME: fakeHome, CODEX_HOME: join(home, "no-codex"), CLAUDE_CONFIG_DIR: join(home, "no-claude") };
  },
});
const { KEY, BASE, call, check, notes, until } = p;

type Browser = NonNullable<ReturnType<typeof p.browser>>;
let ok = false;
try {
  p.start("server");
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
  p.start("runner");
  await until(async () => (await call<Array<{ online: boolean; engines: Array<{ kind: string; signedIn: boolean }> }>>("engines:list", { key: KEY }))
    .some((item) => item.online && item.engines.some((engine) => engine.kind === "grok" && engine.signedIn)), "the runner with Grok signed in", 120);
  await call("dashboard:setDefaultAccess", { key: KEY, access: "full" });
  const chat = await call<string>("dashboard:createChat", { key: KEY });
  await call("dashboard:setChatModel", { key: KEY, id: chat, model: "grok-fake-fast", engine: "grok" });

  const b = await p.openBrowser() as Browser;
  const { evaluate, send } = b;
  const waitFor = (test: string, what: string, seconds = 30) => until(() => evaluate(`Boolean(${test})`), what, seconds);
  const scheme = async (value: "light" | "dark") => {
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] });
    await evaluate(`localStorage.setItem("perry.theme", "system"); true`);
  };
  const shot = async (name: string) => {
    await sleep(400);
    const image = await send("Page.captureScreenshot", { format: "png" }) as { data: string };
    writeFileSync(join(outDir, name), Buffer.from(image.data, "base64"));
  };
  await scheme("light");
  await send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `${BASE}/chat/${chat}` });
  await waitFor(`document.querySelector("#composer")`, "the chat to open");

  await call("dashboard:sendChat", { key: KEY, id: chat, text: `SAY ${JSON.stringify(REPLY)}` });
  await waitFor(`!document.querySelector("[data-thinking], [data-streaming]") && document.querySelectorAll('[data-role="assistant"] [data-slot=code-block]').length === 2`, "the reply with its two code blocks", 90);
  // Shiki loads its grammar after the first paint.
  await waitFor(`document.querySelector('[data-role="assistant"] [data-slot=code-block] [style*="--shiki-light"]')`, "the code to be highlighted", 20);

  const read = () => evaluate(`(() => {
    const user = document.querySelector('[data-role="user"]');
    const bubble = user?.querySelector(":scope [data-slot=bubble]");
    const reply = [...document.querySelectorAll('[data-role="assistant"]')].at(-1);
    const blocks = [...reply.querySelectorAll("[data-slot=code-block]")].map((block) => ({
      title: block.querySelector("[data-slot=code-block-title]")?.textContent ?? null,
      lines: [...block.querySelectorAll("[data-slot=code-block-line]")].map((line) => line.textContent === "\\n" ? "" : line.textContent),
      coloured: block.querySelectorAll('[style*="--shiki-light"]').length,
      copy: block.querySelector('button[aria-label="Copy code"]') !== null,
      colour: (() => { const span = block.querySelector('[style*="--shiki-light"]'); return span ? getComputedStyle(span).color : null; })(),
    }));
    return {
      userIsMessage: user?.dataset.slot === "message" && user.dataset.align === "end",
      bubble: Boolean(bubble) && bubble.dataset.variant === "muted",
      bubbleRight: bubble ? bubble.getBoundingClientRect().right > user.getBoundingClientRect().right - 4 : false,
      replyIsMessage: reply?.dataset.slot === "message" && reply.dataset.align === "start",
      replyUnboxed: !reply?.querySelector("[data-slot=bubble]"),
      blocks,
    };
  })()`) as Promise<{ userIsMessage: boolean; bubble: boolean; bubbleRight: boolean; replyIsMessage: boolean; replyUnboxed: boolean; blocks: Array<{ title: string | null; lines: string[]; coloured: number; copy: boolean; colour: string | null }> }>;

  const light = await read();
  notes.light = light;
  check("userBubble", light.userIsMessage && light.bubble && light.bubbleRight, light);
  check("replyUnboxed", light.replyIsMessage && light.replyUnboxed);
  const [ts, plain] = light.blocks;
  check("codeBlockLanguage", ts?.title === "ts" && plain?.title === "brainfuck", light.blocks.map((block) => block.title));
  check("highlighted", (ts?.coloured ?? 0) > 3, ts?.coloured);
  check("unknownLanguagePlain", plain?.coloured === 0 && plain.lines.join("\n") === "++[>+<-]", plain);
  check("codeKeptWhole", ts?.lines.join("\n") === CODE, ts?.lines);
  check("copyButton", Boolean(ts?.copy && plain?.copy));

  // Copy writes the code, and only the code.
  // Headless Chrome reads no clipboard without focus, so what the button writes is caught on its way in.
  await evaluate(`(() => { const write = navigator.clipboard.writeText.bind(navigator.clipboard); navigator.clipboard.writeText = (text) => { window.copied = text; return write(text).catch(() => {}); }; return true; })()`);
  await evaluate(`document.querySelector('[data-role="assistant"] [data-slot=code-block] button[aria-label="Copy code"]').click(); true`);
  await sleep(300);
  const copied = await evaluate(`window.copied ?? null`) as string | null;
  check("copiesTheCode", copied === CODE, copied);

  await shot("light.png");
  check("noPageErrorsLight", b.errors.length === 0, b.errors);

  await scheme("dark");
  await send("Page.reload", {});
  await sleep(1_500);
  await waitFor(`document.querySelector('[data-role="assistant"] [data-slot=code-block] [style*="--shiki-light"]')`, "the code highlighted after reload", 30);
  const dark = await read();
  notes.darkColour = dark.blocks[0]?.colour;
  check("darkColours", Boolean(dark.blocks[0]?.colour && dark.blocks[0].colour !== light.blocks[0]?.colour), { light: light.blocks[0]?.colour, dark: dark.blocks[0]?.colour });
  await shot("dark.png");
  check("noPageErrors", b.errors.length === 0, b.errors);
  ok = true;
} catch (error) {
  notes.stoppedAt = String(error);
  check("completed", false);
} finally {
  notes.fakeLog = p.fakeLog(fakeHome).filter((entry) => entry.finished).slice(-3);
}
const passed = await p.finish({ ok });
process.exit(passed ? 0 : 1);
