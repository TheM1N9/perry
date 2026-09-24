import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openChat, sleep } from "../browser";

// bun artifacts/ui-polish/run.ts <outDir> <dashboardKey> [base]
// Needs `next dev` (default http://localhost:3005). Read-only: it navigates,
// opens and closes dialogs, and never sends a message or changes a setting.
//
// Ways the redesign could fail, and what this checks for each:
// - A workspace section has no URL of its own, or the URL and the page drift:
//   every nav click must land on /<section> with that section's heading.
// - The active nav item isn't marked: exactly one link has aria-current="page",
//   and it is the one for the page shown.
// - Back and forward don't move between sections: history.back() must return
//   to the previous section's URL and heading.
// - A deep link or refresh loses the section: loading /memory directly must
//   open Memory, and an unknown path must 404 instead of rendering the app.
// - A page lays out wider than the screen: no horizontal overflow on any
//   section at 1280px or 375px.
// - Search isn't a real modal: Ctrl+K must open a <dialog> in the top layer,
//   Escape must close it and put focus back where it was.
// - The mobile drawer traps nothing, or never closes: it must open from the
//   menu button, make the page behind it inert, and close on Escape.
// - A wrong dashboard key is saved and the app breaks: the gate must refuse
//   it inline, mark the field invalid, and keep nothing in localStorage.
// - Anything throws in the page: no page errors.
const [, , outDir, dashboardKey, base = "http://localhost:3005"] = process.argv;
mkdirSync(outDir, { recursive: true });

const SECTIONS = [
  { id: "work", label: "Work" }, { id: "computer", label: "Computer" }, { id: "connectors", label: "Connectors" },
  { id: "memory", label: "Memory" }, { id: "activity", label: "Activity" }, { id: "settings", label: "Settings" },
  { id: "keys", label: "Keys" }, { id: "setup", label: "Setup" },
];

const { evaluate, send, errors, close } = await openChat(base, dashboardKey);
const checks: Array<{ name: string; pass: boolean; detail?: unknown }> = [];
const check = (name: string, pass: boolean, detail?: unknown) => { checks.push({ name, pass, detail }); console.log(`${pass ? "ok  " : "FAIL"} ${name}${pass ? "" : ` ${JSON.stringify(detail)}`}`); };
const shot = async (name: string) => {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(outDir, `${name}.png`), Buffer.from(data, "base64"));
};
const waitFor = (expression: string, timeout = 20000) => evaluate(`new Promise((resolve, reject) => {
  const start = Date.now();
  const tick = () => { const value = ${expression}; if (value) return resolve(true); if (Date.now() - start > ${timeout}) return reject(new Error(${JSON.stringify(`timed out: ${expression}`)})); setTimeout(tick, 150); };
  tick();
})`);
const viewport = (width: number, height: number, mobile: boolean) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
const scheme = (value: "dark" | "light") => send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] });
const state = () => evaluate(`({
  path: location.pathname,
  heading: document.querySelector('.page-head h1')?.textContent ?? null,
  current: [...document.querySelectorAll('a[aria-current="page"].nav-item')].map((a) => a.textContent.trim()),
  overflow: Math.max(document.documentElement.scrollWidth - innerWidth, ...[...document.querySelectorAll('.workspace-scroll, .chat-scroll')].map((el) => el.scrollWidth - el.clientWidth)),
})`) as Promise<{ path: string; heading: string | null; current: string[]; overflow: number }>;
const key = (keyName: string, code: string, modifiers = 0) => send("Input.dispatchKeyEvent", { type: "keyDown", key: keyName, code, modifiers, windowsVirtualKeyCode: keyName === "Escape" ? 27 : keyName.toUpperCase().charCodeAt(0) })
  .then(() => send("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code, modifiers }));

try {
  for (const mode of ["dark", "light"] as const) {
    await scheme(mode);
    await viewport(1280, 800, false);
    await evaluate(`document.querySelector('nav[aria-label="Main"] a[href="/chat"]').click(); true`);
    await waitFor(`location.pathname.startsWith('/chat') && document.querySelector('.chat-composer-box')`);
    await sleep(800);
    await shot(`chat-desktop-${mode}`);
    const chat = await state();
    check(`${mode}: chat marks Chat as current`, chat.current.length === 1 && chat.current[0] === "Chat", chat);

    for (const section of SECTIONS) {
      await evaluate(`document.querySelector('.sidebar a.nav-item[href="/${section.id}"]').click(); true`);
      await waitFor(`location.pathname === '/${section.id}' && document.querySelector('.page-head h1')?.textContent === ${JSON.stringify(section.label)}`);
      await sleep(mode === "dark" ? 1500 : 600);
      const page = await state();
      check(`${mode}: ${section.id} has its own URL, heading, and current nav item`, page.current.length === 1 && page.current[0].startsWith(section.label), page);
      check(`${mode}: ${section.id} fits 1280px`, page.overflow <= 0, page.overflow);
      if (mode === "dark" || section.id === "work" || section.id === "memory") await shot(`${section.id}-desktop-${mode}`);
    }
  }

  await scheme("dark");
  await evaluate(`history.back(); true`);
  await waitFor(`location.pathname === '/keys' && document.querySelector('.page-head h1')?.textContent === 'Keys'`);
  check("back returns to the previous section", true);
  await evaluate(`history.forward(); true`);
  await waitFor(`location.pathname === '/setup' && document.querySelector('.page-head h1')?.textContent === 'Setup'`);
  check("forward returns to the next section", true);

  await send("Page.navigate", { url: `${base}/memory` });
  await waitFor(`document.querySelector('.page-head h1')?.textContent === 'Memory'`, 30000);
  check("deep link to /memory opens Memory", (await state()).path === "/memory");
  const missing = await evaluate(`fetch('/not-a-section').then((response) => response.status)`);
  check("an unknown path is a 404", missing === 404, missing);

  // Search is a native modal dialog that gives focus back when it closes.
  await evaluate(`document.querySelector('nav[aria-label="Main"] a[href="/chat"]').click(); true`);
  await waitFor(`document.querySelector('.chat-search-trigger')`);
  await sleep(600);
  await evaluate(`document.querySelector('.chat-search-trigger').focus(); true`);
  // Headless Chrome keeps Ctrl+K for itself, so the shortcut is sent to the page directly.
  await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, bubbles: true, cancelable: true })); true`);
  await waitFor(`document.querySelector('dialog.search-dialog[open]')`);
  const modal = await evaluate(`({ modal: document.querySelector('dialog.search-dialog').matches(':modal'), focused: document.activeElement?.getAttribute('aria-label') })`);
  check("Ctrl+K opens search as a modal with the field focused", modal.modal && modal.focused === "Search chats", modal);
  await sleep(300);
  await shot("search-desktop-dark");
  await key("Escape", "Escape");
  await waitFor(`!document.querySelector('dialog.search-dialog')`);
  const restored = await evaluate(`document.activeElement?.classList.contains('chat-search-trigger') ?? false`);
  check("Escape closes search and restores focus", restored, restored);

  // Mobile: the drawer opens, holds the page inert, and closes on Escape.
  await viewport(375, 812, true);
  await sleep(600);
  await shot("chat-mobile-dark");
  const chatMobile = await state();
  check("chat fits 375px", chatMobile.overflow <= 0, chatMobile.overflow);
  await evaluate(`document.querySelector('.mobile-menu').click(); true`);
  await waitFor(`document.querySelector('.sidebar.open')`);
  await sleep(300);
  const drawer = await evaluate(`({ inert: document.querySelector('main').inert, focusInside: document.querySelector('.sidebar').contains(document.activeElement) })`);
  check("mobile drawer makes the page inert and takes focus", drawer.inert && drawer.focusInside, drawer);
  await shot("drawer-mobile-dark");
  await key("Escape", "Escape");
  await waitFor(`!document.querySelector('.sidebar.open')`);
  check("Escape closes the mobile drawer", true);
  for (const id of ["work", "computer", "memory", "activity", "keys"]) {
    await evaluate(`history.pushState(null, '', '/${id}'); dispatchEvent(new PopStateEvent('popstate')); true`);
    await waitFor(`document.querySelector('.page-head h1')?.textContent?.toLowerCase() === '${id}'`);
    await sleep(900);
    const page = await state();
    check(`${id} fits 375px`, page.overflow <= 0, page.overflow);
    await shot(`${id}-mobile-dark`);
  }
  await scheme("light");
  await sleep(300);
  await shot("keys-mobile-light");

  // The narrowest phone still fits.
  await viewport(320, 640, true);
  for (const id of ["work", "memory"]) {
    await evaluate(`history.pushState(null, '', '/${id}'); dispatchEvent(new PopStateEvent('popstate')); true`);
    await waitFor(`document.querySelector('.page-head h1')?.textContent?.toLowerCase() === '${id}'`);
    await sleep(700);
    const page = await state();
    check(`${id} fits 320px`, page.overflow <= 0, page.overflow);
  }

  // Locking returns to the gate, which checks a key before keeping it.
  await viewport(1280, 800, false);
  await scheme("dark");
  await evaluate(`document.querySelector('button[aria-label="Lock dashboard"]').click(); true`);
  await waitFor(`document.querySelector('#dashboard-key')`);
  await evaluate(`(() => {
    const input = document.querySelector('#dashboard-key');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'not-the-key');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await evaluate(`document.querySelector('.gate button[type=submit]').click(); true`);
  await waitFor(`document.querySelector('#dashboard-key-error')`);
  const gate = await evaluate(`({ error: document.querySelector('#dashboard-key-error').textContent, invalid: document.querySelector('#dashboard-key').getAttribute('aria-invalid'), stored: localStorage.getItem('perry.dashboard.key') })`);
  check("a wrong key is refused with an inline error and never stored", gate.invalid === "true" && /doesn't match/.test(gate.error) && gate.stored === null, gate);
  await shot("gate-invalid-dark");
  await evaluate(`localStorage.setItem('perry.dashboard.key', ${JSON.stringify(dashboardKey)}); true`);
} catch (error) {
  check("run finished", false, String(error));
  await shot("failure").catch(() => {});
}

check("no page errors", errors.length === 0, errors);
const pass = checks.every((item) => item.pass);
writeFileSync(join(outDir, "result.json"), JSON.stringify({ ranAt: new Date().toISOString(), base, pass, checks, errors }, null, 2));
close();
console.log(pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
