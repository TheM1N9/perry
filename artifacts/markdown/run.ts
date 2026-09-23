import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import { openChat } from "../browser";

// bun artifacts/markdown/run.ts <outDir> <dashboardKey> <runnerToken>
// Needs `next dev -p 3005`, a runner on this branch, CONVEX_URL and E2E_WORKDIR.
const [, , outDir, dashboardKey, runnerToken] = process.argv;
const base = "http://localhost:3005";
mkdirSync(outDir, { recursive: true });
const convex = new ConvexHttpClient(process.env.CONVEX_URL!);
const checkIn = () => convex.mutation(api.runner.checkIn, { token: runnerToken, platform: "win32", hostname: "e2e", workdir: process.env.E2E_WORKDIR, autoApprove: true });
const { evaluate, send, errors, close } = await openChat(base, dashboardKey);

const sample = [
  "## Plan",
  "",
  "- first **bold** item",
  "- second item with `inline code`",
  "",
  "| name | value |",
  "| --- | --- |",
  "| alpha | 1 |",
  "",
  "```ts",
  "const answer = 42;",
  "```",
  "",
  "See [Convex](https://www.convex.dev) and <b>raw html</b>.",
].join("\n");

await evaluate(`document.querySelector('.chat-header-new').click(); true`);
await evaluate(`(() => {
  const box = document.querySelector('.chat-composer-box textarea');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, ${JSON.stringify(`This is an automated test. Reply with exactly the following Markdown, character for character, and nothing else:\n\n${sample}`)});
  box.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
// Keep the test runner the freshest Codex runner until the chat is bound to it.
await checkIn();
const heartbeat = setInterval(() => void checkIn().catch(() => {}), 1000);
await evaluate(`document.querySelector('.chat-send').click(); true`);
const rendered = await evaluate(`new Promise((resolve, reject) => {
  const start = Date.now();
  const tick = () => {
    const reply = [...document.querySelectorAll('.chat-turn.from-assistant:not(.pending) .chat-markdown')].at(-1);
    const error = document.querySelector('.chat-turn-error, .chat-error');
    if (reply) return resolve({
      heading: reply.querySelector('h2')?.textContent ?? null,
      listItems: reply.querySelectorAll('ul > li').length,
      bold: reply.querySelector('li strong')?.textContent ?? null,
      inlineCode: reply.querySelector('li code')?.textContent ?? null,
      tableCells: [...reply.querySelectorAll('td')].map((cell) => cell.textContent),
      codeBlock: reply.querySelector('pre code')?.textContent?.trim() ?? null,
      link: reply.querySelector('a') ? { href: reply.querySelector('a').getAttribute('href'), target: reply.querySelector('a').getAttribute('target'), rel: reply.querySelector('a').getAttribute('rel') } : null,
      rawHtmlElement: reply.querySelector('b') !== null,
      rawHtmlShownAsText: reply.textContent.includes('<b>raw html</b>') || reply.textContent.includes('raw html'),
      userBubbleIsPlain: !document.querySelector('.chat-turn.from-user .chat-markdown'),
      // A link to a web page must not turn into an image, video or audio player.
      strayMedia: reply.closest('.chat-bubble').querySelectorAll('audio, video, .chat-attachments img').length,
    });
    if (error && Date.now() - start > 5000) return resolve({ error: error.innerText });
    if (Date.now() - start > 300000) return reject(new Error('no reply within 5 minutes'));
    setTimeout(tick, 1000);
  };
  setTimeout(tick, 3000);
})`);
clearInterval(heartbeat);
const chatId = await evaluate(`decodeURIComponent(location.pathname.split('/')[2] ?? '')`);
const full = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(join(outDir, "markdown-reply.png"), Buffer.from(full.data, "base64"));

const pass = !rendered.error && rendered.heading === "Plan" && rendered.listItems === 2 && rendered.bold === "bold"
  && rendered.inlineCode === "inline code" && rendered.tableCells.join(",") === "alpha,1" && rendered.codeBlock === "const answer = 42;"
  && rendered.link?.href === "https://www.convex.dev" && rendered.link.target === "_blank" && rendered.link.rel === "noreferrer"
  && !rendered.rawHtmlElement && rendered.userBubbleIsPlain && rendered.strayMedia === 0 && errors.length === 0;
const result = { ranAt: new Date().toISOString(), chatId, rendered, pageErrors: errors, pass };
writeFileSync(join(outDir, "result.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
close();
process.exit(pass ? 0 : 1);
