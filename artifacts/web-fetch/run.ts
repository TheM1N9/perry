import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import { openChat, sleep } from "../browser";

// bun artifacts/web-fetch/run.ts <outDir> <dashboardKey> <runnerToken>
// Needs this branch pushed with `convex dev`, `next dev -p 3005`, a runner on
// this branch, CONVEX_URL and E2E_WORKDIR. Web chat only; nothing is sent to
// Telegram, and no watch is created or checked.
//
// Ways this could fail, and what catches each:
//   1. undici or turndown missing from the Node bundle, or web.ts not in the
//      Node runtime: every `web:read` call below throws instead of returning.
//   2. HTML not turned into Markdown: example.com must come back titled
//      "Example Domain" with the text starting "# Example Domain".
//   3. Plain http refused by mistake: http://example.com must read the same.
//   4. Redirects not followed by hand: httpbin's /redirect/3 must arrive.
//   5. Endless redirects followed: /redirect/11 must stop with the 10-hop error.
//   6. An IP literal reaching a private address: 127.0.0.1, 169.254.169.254
//      (cloud metadata), [::1], [::ffff:169.254.169.254] (IPv4-mapped) and
//      0x7f.1 (hex loopback) must each be refused, with no text.
//   7. A public name that resolves to a private address: localhost and
//      localtest.me (public DNS, answers 127.0.0.1) must be refused, which
//      only the checked DNS lookup can do.
//   8. A redirect re-checked only on the first hop: httpbin redirecting to
//      127.0.0.1 and to 169.254.169.254 must be refused.
//   9. A large page returned whole: RFC 9110 as text (about 500 KB, 10,000+
//      lines) must come back truncated, within 50 KB plus the notice, ending
//      with "[page truncated: showing the first N of M lines]".
//  10. The 5 MB cap not enforced: the single-page HTML standard (well over
//      5 MB) must be refused as over the limit.
//  11. Failures without hints: an unresolvable .invalid host must return the
//      catalogued network message (ENOTFOUND) with a hint, and every refused
//      address must carry the "only public addresses" hint.
//  12. Codex not reaching read_page, or the Markdown not usable: in a web chat
//      Perry reads example.com and summarises it; the reply must mention the
//      page is for documentation examples, and the run must list read_page.
//  13. Hints lost between the tool and the agent (the MCP layer): in the same
//      chat Perry reads the .invalid host and must relay the hint's advice.
//
// Not checked here: the 30-second timeout (no public endpoint reliably holds
// a request that long), and watches, because checking them runs every due
// watch of the owner's and notifies on Telegram. Watches use the unchanged
// plain-text extraction over the same first 30,000 characters.
//
// The thrown-error path in mcp.ts (isError with "Hint:") cannot be provoked
// from outside without breaking something real. To see it by hand: revoke
// Perry's access to a connected Google account at
// https://myaccount.google.com/permissions and ask Perry for your latest
// email; the reply should ask you to reconnect on the Connectors page.
const [, , outDir, dashboardKey, runnerToken] = process.argv;
const base = "http://localhost:3005";
mkdirSync(outDir, { recursive: true });
const convex = new ConvexHttpClient(process.env.CONVEX_URL!);
const checkIn = () => convex.mutation(api.runner.checkIn, { token: runnerToken, platform: "win32", hostname: "e2e", workdir: process.env.E2E_WORKDIR, autoApprove: true });
const cli = (...args: string[]) => execFileSync("node", ["node_modules/convex/bin/main.js", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const convexRun = (fn: string, args: object) => JSON.parse(cli("run", fn, JSON.stringify(args)).trim() || "null");

type Page = { url?: string; title?: string; text?: string; chars?: number; truncated?: boolean; note?: string; error?: string; hint?: string };
const read = (url: string): Page => convexRun("web:read", { url });
const REFUSED = /not public/i;
const PUBLIC_HINT = /only public internet addresses/i;
const refused = (page: Page) => REFUSED.test(page.error ?? "") && PUBLIC_HINT.test(page.hint ?? "") && page.text === undefined;

// --- 1. The read action, directly -------------------------------------------

const example = read("https://example.com");
const plainHttp = read("http://example.com");
const redirected = read("https://httpbin.org/redirect/3");
const tooManyRedirects = read("https://httpbin.org/redirect/11");
const privateTargets = [
  "http://127.0.0.1",
  "http://169.254.169.254/latest/meta-data/",
  "http://[::1]/",
  "http://[::ffff:169.254.169.254]/",
  "http://0x7f.1/",
  "http://localhost:3005/",
  "http://localtest.me/",
  "https://httpbin.org/redirect-to?url=http://127.0.0.1/",
  "https://httpbin.org/redirect-to?url=http://169.254.169.254/latest/meta-data/",
].map((url) => ({ url, page: read(url) }));
const large = read("https://www.rfc-editor.org/rfc/rfc9110.txt");
const oversized = read("https://html.spec.whatwg.org/");
const missing = read("https://perry-e2e-does-not-exist.invalid/");

const notice = large.text?.match(/\[page truncated: showing the first (\d+) of (\d+) lines\]$/);
const checks = {
  markdown: example.title === "Example Domain" && /^# Example Domain/.test(example.text ?? "") && !example.error,
  plainHttp: /^# Example Domain/.test(plainHttp.text ?? ""),
  redirectFollowed: !redirected.error && /httpbin\.org\/get$/.test(redirected.url ?? ""),
  redirectLimit: /more than 10 redirects/i.test(tooManyRedirects.error ?? ""),
  privateRefused: privateTargets.every(({ page }) => refused(page)),
  truncated: large.truncated === true && Boolean(notice) && Number(notice?.[1]) < Number(notice?.[2])
    && new TextEncoder().encode(large.text ?? "").length <= 50 * 1024 + 200,
  sizeCap: /over the 5 MB limit/i.test(oversized.error ?? "") && oversized.text === undefined,
  // Convex's Node runtime can drop the DNS code under undici's "fetch failed"; either way the hint must come.
  networkHint: /network request failed/i.test(missing.error ?? "") && Boolean(missing.hint),
};

// --- 2. Through Perry, in a web chat ----------------------------------------

const { evaluate, send, errors, close } = await openChat(base, dashboardKey);
await evaluate(`document.querySelector('.chat-header-new').click(); true`);

async function ask(text: string): Promise<{ reply: string | null; error: string | null }> {
  await evaluate(`(() => {
    const box = document.querySelector('.chat-composer-box textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, ${JSON.stringify(text)});
    box.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  const before = await evaluate(`document.querySelectorAll('.chat-turn.from-assistant:not(.pending)').length`);
  await checkIn();
  await evaluate(`document.querySelector('.chat-send').click(); true`);
  return await evaluate(`new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const replies = [...document.querySelectorAll('.chat-turn.from-assistant:not(.pending) .chat-bubble')];
      const error = document.querySelector('.chat-turn-error');
      const thinking = document.querySelector('.chat-thinking');
      if (!thinking && replies.length > ${before}) return resolve({ reply: replies.at(-1).innerText, error: null });
      if (!thinking && error && Date.now() - start > 5000) return resolve({ reply: null, error: error.innerText });
      if (Date.now() - start > 300000) return reject(new Error('no reply within 5 minutes'));
      setTimeout(tick, 1000);
    };
    setTimeout(tick, 3000);
  })`);
}

const summary = await ask("This is an automated end-to-end test. Use your read_page tool (not the shell) to read https://example.com and summarise what the page says in one or two sentences.");
const chatId = await evaluate(`decodeURIComponent(location.pathname.split('/')[2] ?? '')`);
const failure = await ask("Now use read_page on https://perry-e2e-does-not-exist.invalid/ and tell me, in one short paragraph, the error it returned and the hint that came with it, quoting the hint.");
await sleep(2000);
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(join(outDir, "web-fetch-chat.png"), Buffer.from(shot.data, "base64"));

const runs = JSON.parse(cli("data", "runs", "--limit", "20", "--order", "desc", "--format", "jsonArray"))
  .filter((run: { conversationId: string }) => run.conversationId === chatId);
const toolCalls = runs.flatMap((run: { toolCalls?: string[] }) => run.toolCalls ?? []);

const chat = {
  summarised: /documentation|examples?/i.test(summary.reply ?? "") && !summary.error,
  usedReadPage: toolCalls.filter((name: string) => name === "read_page").length >= 2,
  hintRelayed: /(site is up|try once more|address is right)/i.test(failure.reply ?? ""),
};

const pass = Object.values(checks).every(Boolean) && Object.values(chat).every(Boolean) && errors.length === 0;
const clipped = (page: Page) => ({ ...page, text: page.text === undefined ? undefined : `${page.text.slice(0, 160)}${page.text.length > 160 ? " ... " + page.text.slice(-100) : ""}` });
const result = {
  ranAt: new Date().toISOString(),
  checks,
  pages: {
    example: clipped(example),
    plainHttp: clipped(plainHttp),
    redirected: clipped(redirected),
    tooManyRedirects,
    privateTargets,
    large: clipped(large),
    oversized,
    missing,
  },
  chatId,
  chat,
  replies: { summary, failure },
  toolCalls,
  pageErrors: errors,
  pass,
};
writeFileSync(join(outDir, "result.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
close();
process.exit(pass ? 0 : 1);
