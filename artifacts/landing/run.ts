import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sleep } from "../browser";

// bun artifacts/landing/run.ts [outDir]
// Builds site/ for production, serves it with `next start`, and drives
// headless Chrome over it the way a visitor would.
//
// Ways the landing page could fail, and what this checks for each:
// - It asks another server for something (fonts, analytics, a CDN), which the
//   footer says it never does: every request must be to the page's own origin.
// - A self-hosted font is missing and the page falls back to system fonts: the
//   body's and the terminal's first font family must both be loaded.
// - The hero's scene is stuck, or never loops: its step must reach the
//   approval, then Perry's "Fixed." reply, then start over.
// - The scene only plays for people with motion on: with reduced motion
//   emulated it must still advance, and nothing may be left invisible.
// - A section never appears because its reveal never fires: after scrolling
//   the page through, no element in <main> may still be at opacity 0.
// - The Control chapter lies or is dead: each answer (Approve, Decline, Always
//   allow) must give its outcome; Full access must run without asking, go
//   amber and disable the policy; Review must show the reviewer's verdicts;
//   Trust must run under the machine's policy.
// - The schedule dial doesn't drive the chat: at 13:00 there is no "Call Sam."
//   message, at 15:00 there is, and taking the dial pauses the day.
// - The mascot is only a picture: poking him must tip the hat and get a line
//   out of him, his eyes must follow the pointer, and the closing one must say
//   hello when it scrolls into view.
// - A wrong URL shows a bare error: the 404 page must be Perry's own.
// - Copy copies the wrong thing: it must hand over the clone and setup commands.
// - A section lays out wider than the screen: no horizontal overflow at 1440,
//   1280, 768 or 375px.
// - Text is too faint on the dark canvas: every visible text node must meet
//   WCAG AA (4.5:1, 3:1 for large text) against what is really behind it.
// - An in-page link points nowhere: every href="#id" must have its target.
// - Anything throws, or React reports a hydration mismatch: no page errors.
// Also recorded, not judged: the LCP time and the JavaScript the page loads.
const outDir = resolve(process.argv[2] ?? "artifacts/landing");
const siteDir = resolve("site");
mkdirSync(outDir, { recursive: true });

const run = (command: string, args: string[]) => new Promise<void>((done, fail) => {
  const child = spawn(command, args, { cwd: siteDir, stdio: "inherit", shell: true });
  child.on("exit", (code) => (code === 0 ? done() : fail(new Error(`${command} ${args.join(" ")} exited ${code}`))));
});

await run("pnpm", ["build"]);
const port = 4400 + Math.floor(Math.random() * 400);
const base = `http://127.0.0.1:${port}`;
const server = spawn("pnpm", ["exec", "next", "start", "-p", String(port), "-H", "127.0.0.1"], { cwd: siteDir, stdio: "ignore", shell: true });
for (let i = 0; i < 100; i++) {
  try { if ((await fetch(base)).ok) break; } catch {}
  await sleep(200);
}

const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", [
  "--headless=new", "--remote-debugging-port=9334", `--user-data-dir=${join(tmpdir(), "perry-landing-profile")}`,
  "--hide-scrollbars", "about:blank",
], { stdio: "ignore" });
let targets: Array<{ type: string; webSocketDebuggerUrl: string }> = [];
for (let i = 0; i < 50 && !targets.some((target) => target.type === "page"); i++) {
  try { targets = await (await fetch("http://127.0.0.1:9334/json/list")).json() as typeof targets; } catch {}
  await sleep(200);
}
const page = targets.find((target) => target.type === "page");
if (!page) throw new Error("Chrome did not open a page.");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((ready) => ws.addEventListener("open", ready, { once: true }));

let nextId = 0;
const waiting = new Map<number, (message: any) => void>();
const errors: string[] = [];
const requests: string[] = [];
ws.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id && waiting.has(message.id)) { waiting.get(message.id)!(message); waiting.delete(message.id); }
  if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
  if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
    errors.push(message.params.args.map((a: any) => a.value ?? a.description).join(" "));
  }
  if (message.method === "Network.requestWillBeSent") requests.push(message.params.request.url);
});
const send = (method: string, params: object = {}): Promise<any> => new Promise((done, fail) => {
  const id = ++nextId;
  waiting.set(id, (message) => message.error ? fail(new Error(`${method}: ${message.error.message}`)) : done(message.result));
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression: string): Promise<any> => {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
};

const checks: Array<{ name: string; pass: boolean; detail?: unknown }> = [];
const check = (name: string, pass: boolean, detail?: unknown) => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "ok  " : "FAIL"} ${name}${pass ? "" : ` ${JSON.stringify(detail)}`}`);
};
const shot = async (name: string, fullPage = false) => {
  const params: any = { format: "png" };
  if (fullPage) {
    const { cssContentSize } = await send("Page.getLayoutMetrics");
    params.captureBeyondViewport = true;
    params.clip = { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height, scale: 1 };
  }
  const { data } = await send("Page.captureScreenshot", params);
  writeFileSync(join(outDir, `${name}.png`), Buffer.from(data, "base64"));
};
const viewport = (width: number, height: number) =>
  send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
const motion = (value: "reduce" | "no-preference") =>
  send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value }] });
const load = async () => {
  await send("Page.navigate", { url: base });
  await evaluate(`new Promise((done) => document.readyState === "complete" ? done(true) : addEventListener("load", () => done(true)))`);
  await evaluate(`document.fonts.ready.then(() => true)`);
  await sleep(600);
};
const until = async (expression: string, timeout = 20000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await evaluate(expression)) return true;
    await sleep(100);
  }
  return false;
};
/** Scroll the whole page through, so every reveal fires, and come back up. */
const scrollThrough = async () => {
  const height = await evaluate(`document.documentElement.scrollHeight`);
  for (let y = 0; y < height; y += 400) { await evaluate(`scrollTo({ top: ${y}, behavior: "instant" }); true`); await sleep(120); }
  await sleep(900);
};
const click = (selector: string) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: "center", behavior: "instant" }); el.click(); return true; })()`);
const text = (selector: string) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ""`);

// Text against what is really behind it.
const CONTRAST = `(() => {
  // rgb() and rgba() come in 0-255; color-mix() and some alpha colours compute to color(srgb ...) in 0-1.
  const parse = (c) => {
    const m = c.match(/[\\d.]+/g).map(Number);
    const k = c.startsWith("color(") ? 255 : 1;
    return { r: m[0] * k, g: m[1] * k, b: m[2] * k, a: m[3] ?? 1 };
  };
  const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
  // What is behind a text node is whatever is painted under it, sibling layers (like a sliding pill) included,
  // so read the element stack at the text's centre and blend every background from the bottom up to it.
  const background = (el, node) => {
    el.scrollIntoView({ block: "center", behavior: "instant" });
    const range = document.createRange();
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    const stack = document.elementsFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const at = stack.findIndex((e) => e === el || el.contains(e));
    const below = (at >= 0 ? stack.slice(at) : [...(function* () { for (let n = el; n; n = n.parentElement) yield n; })()]).reverse();
    return below.reduce((under, e) => over(parse(getComputedStyle(e).backgroundColor), under), { r: 8, g: 9, b: 10, a: 1 });
  };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const failures = [];
  let seen = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node.parentElement;
    if (!node.textContent.trim() || !el.getClientRects().length || el.closest(".sr-only, [aria-hidden=true], nextjs-portal")) continue;
    // Headlines are painted by a white-to-half-white gradient; judge them by its faintest end.
    const clipped = el.closest(".headline-gradient");
    const style = getComputedStyle(el);
    if (style.visibility === "hidden") continue;
    const bg = background(el, node);
    const fg = clipped ? over({ r: 255, g: 255, b: 255, a: 0.55 }, bg) : over(parse(style.color), bg);
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    const ratio = (a + 0.05) / (b + 0.05);
    const size = parseFloat(style.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
    seen++;
    if (ratio < (large ? 3 : 4.5)) failures.push({ text: node.textContent.trim().slice(0, 40), ratio: Math.round(ratio * 100) / 100, size });
  }
  return { seen, failures };
})()`;
const OVERFLOW = `document.documentElement.scrollWidth - document.documentElement.clientWidth`;
const HIDDEN = `[...document.querySelectorAll("main *")].filter((el) => el.getClientRects().length && getComputedStyle(el).opacity === "0" && !el.closest("[aria-hidden=true]")).map((el) => el.tagName + "." + String(el.className).slice(0, 40)).slice(0, 8)`;
const STEP = `Number(document.querySelector("[data-end]").dataset.step)`;
const END = `Number(document.querySelector("[data-end]").dataset.end)`;

await send("Runtime.enable");
await send("Page.enable");
await send("Network.enable");
await send("Emulation.setFocusEmulationEnabled", { enabled: true });

// ---------- Desktop, motion on ----------
await viewport(1440, 900);
await motion("no-preference");
await load();

const fonts = await evaluate(`(() => {
  const first = (el) => getComputedStyle(el).fontFamily.split(",")[0].replace(/["']/g, "").trim();
  const loaded = [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family.replace(/["']/g, ""));
  const sans = first(document.body), mono = first(document.querySelector(".font-mono"));
  return { sans, mono, loaded: [...new Set(loaded)] };
})()`);
check("the body's font (Inter Tight) is loaded from the site", fonts.loaded.includes(fonts.sans), fonts);
check("the terminal's font (JetBrains Mono) is loaded from the site", fonts.loaded.includes(fonts.mono), fonts);

// Performance, recorded.
const perf = await evaluate(`new Promise((done) => {
  new PerformanceObserver((list) => {
    const last = list.getEntries().at(-1);
    const js = performance.getEntriesByType("resource").filter((r) => r.name.endsWith(".js")).reduce((sum, r) => sum + r.transferSize, 0);
    done({ lcpMs: Math.round(last.startTime), lcpElement: last.element?.tagName + "." + String(last.element?.className ?? "").slice(0, 30), jsKb: Math.round(js / 1024) });
  }).observe({ type: "largest-contentful-paint", buffered: true });
})`);
console.log(`     LCP ${perf.lcpMs} ms (${perf.lcpElement}), JavaScript ${perf.jsKb} kB`);

await shot("hero-0-start");
check("hero: the scene reaches Perry's approval request", await until(`${STEP} >= 5 && document.body.innerText.includes("Perry wants to run")`));
await shot("hero-1-approval");
check("hero: approved on the phone, and the terminal runs it", await until(`${STEP} >= 8 && document.querySelector("[data-end]").innerText.includes("Compiled successfully")`));
check("hero: the scene ends with Perry's reply", await until(`${STEP} === ${END} && document.querySelector("[data-end]").innerText.includes("Fixed.")`));
await shot("hero-2-fixed");
check("hero: the scene starts over", await until(`${STEP} < ${END}`, 8000));

const missing = await evaluate(`[...document.querySelectorAll('a[href^="#"]')].map((a) => a.getAttribute("href").slice(1)).filter((id) => !document.getElementById(id))`);
check("every in-page link has its target", missing.length === 0, missing);

await scrollThrough();
check("after scrolling through, nothing in <main> is left invisible", (await evaluate(HIDDEN)).length === 0, await evaluate(HIDDEN));
const contrast = await evaluate(CONTRAST);
check(`text contrast meets AA (${contrast.seen} text nodes)`, contrast.failures.length === 0, contrast.failures);
await evaluate(`scrollTo({ top: 0, behavior: "instant" }); true`);
await sleep(400);
await shot("desktop-full", true);

// Control: each answer, then the switches.
for (const [answer, outcome] of [["approve", "Pushed to main"], ["decline", "won't push"], ["always", "without asking"]] as const) {
  await click(`#control [data-answer="${answer}"]`);
  const shown = await until(`document.querySelector("#control").innerText.includes(${JSON.stringify(outcome)})`, 3000);
  check(`control: ${answer} gives its outcome`, shown, await text("#control"));
  await click(`#control button:not([aria-pressed]):not([data-answer])`); // "Ask again"
  check(`control: after ${answer}, it can be asked again`, await until(`!!document.querySelector('#control [data-answer="approve"]')`, 3000));
}
await click(`#control [aria-label="Policy"] button:nth-child(2)`);
check("control: Review shows the reviewer's verdicts, and asks about the push", await until(`document.querySelector("#control").innerText.includes("routine, ran it") && !!document.querySelector('#control [data-answer]')`, 3000));
await click(`#control [aria-label="Policy"] button:nth-child(3)`);
check("control: Trust runs the push under the machine's policy", await until(`document.querySelector("#control").innerText.includes("allowed by this machine's policy") && !document.querySelector('#control [data-answer]')`, 3000));
await click(`#control [aria-label="Access"] button:nth-child(2)`);
const full = await evaluate(`({
  ran: document.querySelector("#control").innerText.includes("ran without asking"),
  policyDisabled: [...document.querySelectorAll('#control [aria-label="Policy"] button')].every((b) => b.disabled),
  amber: getComputedStyle(document.querySelector('#control [aria-label="Access"] [aria-pressed="true"] span')).backgroundColor,
})`);
check("control: Full access runs without asking, goes amber and disables the policy", full.ran && full.policyDisabled && full.amber === "rgb(240, 180, 76)", full);
await sleep(500);
await shot("control-full-access");
await click(`#control [aria-label="Access"] button:nth-child(1)`);

// Schedule: the dial drives the chat.
const setTime = (minutes: number) => evaluate(`(() => {
  const input = document.querySelector('input[aria-label="Time of day"]');
  input.scrollIntoView({ block: "center", behavior: "instant" });
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "${minutes}");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
})()`);
await setTime(13 * 60);
await sleep(700);
const at13 = await text("#schedule");
await setTime(15 * 60);
await sleep(700);
const at15 = await text("#schedule");
check("schedule: no reminder yet at 13:00, and it has arrived by 15:00", !at13.includes("Call Sam.") && at15.includes("Call Sam."), { at13: at13.slice(0, 200) });
check("schedule: taking the dial pauses the day", (await evaluate(`document.querySelector('#schedule [aria-label="Play the day"]')?.getAttribute("aria-pressed")`)) === "true");
await shot("schedule");

// The mascot.
const PUPIL = `document.querySelector('button[aria-label^="Perry, the platypus"] svg circle').getAttribute("cx")`;
const centred = await evaluate(`(() => { const b = document.querySelector('button[aria-label^="Perry, the platypus"]'); b.scrollIntoView({ block: "center", behavior: "instant" }); return ${PUPIL}; })()`);
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1400, y: 450 });
await sleep(200);
const right = await evaluate(PUPIL);
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 450 });
await sleep(200);
const left = await evaluate(PUPIL);
check("mascot: his eyes follow the pointer", Number(right) > Number(left), { centred, right, left });
await click(`button[aria-label^="Perry, the platypus"]`);
check("mascot: poking him gets a line out of him", await until(`[...document.querySelectorAll('[role="status"]')].some((el) => el.textContent.includes("Tells no one"))`, 2000));
// The closing mascot says hello once per visit, and the scroll-through above has used it, so start a fresh visit.
await load();
check("mascot: the closing one says hello when it comes into view", await evaluate(`(async () => {
  document.querySelector("#cta-title").scrollIntoView({ block: "center", behavior: "instant" });
  for (let i = 0; i < 30; i++) {
    if ([...document.querySelectorAll('[role="status"]')].some((el) => el.textContent.includes("Ready when you are"))) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
})()`));

// Copy.
await evaluate(`const write = navigator.clipboard.writeText.bind(navigator.clipboard); navigator.clipboard.writeText = (t) => { window.copied = t; return write(t); }; true`);
await click(`[data-copy]`);
await sleep(200);
const copied = await evaluate(`window.copied`);
check("copy hands over the clone and setup commands", copied === "git clone https://github.com/TheM1N9/perry.git perry && cd perry\npnpm install\npnpm run setup", copied);

// Overflow at every width.
for (const [width, height] of [[1440, 900], [1280, 800], [768, 1024], [375, 812]] as const) {
  await viewport(width, height);
  await sleep(400);
  const overflow = await evaluate(OVERFLOW);
  check(`no horizontal overflow at ${width}px`, overflow <= 0, overflow);
}

// The 404 page.
await send("Page.navigate", { url: `${base}/nowhere` });
await sleep(1200);
check("404: Perry's own page, with the mascot", await until(`document.body.innerText.includes("This page went undercover") && !!document.querySelector('button[aria-label^="Perry, the platypus"]')`, 5000));

// ---------- Phone, reduced motion ----------
await viewport(390, 844);
await motion("reduce");
await load();
await evaluate(`document.querySelector("[data-end]").scrollIntoView({ block: "start", behavior: "instant" }); true`);
await sleep(300);
const before = await evaluate(STEP);
check("reduced motion: the hero's scene still plays once it is on screen", await until(`${STEP} > ${before} + 2`, 8000), { before, after: await evaluate(STEP) });
await scrollThrough();
check("reduced motion: nothing in <main> is left invisible", (await evaluate(HIDDEN)).length === 0, await evaluate(HIDDEN));
const phoneContrast = await evaluate(CONTRAST);
check("text contrast meets AA on a phone", phoneContrast.failures.length === 0, phoneContrast.failures);
await evaluate(`scrollTo({ top: 0, behavior: "instant" }); true`);
await sleep(400);
await shot("mobile-full", true);

const foreign = [...new Set(requests)].filter((url) => !url.startsWith(base) && !url.startsWith("data:"));
check("every request stays on the page's own origin", foreign.length === 0, foreign);
check("no page errors or hydration mismatches", errors.length === 0, errors);

const pass = checks.every((c) => c.pass);
writeFileSync(join(outDir, "result.json"), `${JSON.stringify({ pass, at: new Date().toISOString(), performance: perf, checks }, null, 2)}\n`);
console.log(pass ? "\nAll checks passed." : "\nSome checks failed.");

ws.close();
chrome.kill();
if (process.platform === "win32") spawn("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
else server.kill();
await sleep(500);
process.exit(pass ? 0 : 1);
