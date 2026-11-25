import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { perry } from "../engine-acp/harness";
import { SETTINGS_SECTIONS } from "../../lib/settings";

const outDir = resolve(process.argv[2] ?? "node_modules/.cache/settings-navigation");
const scratch = mkdtempSync(join(tmpdir(), "perry-settings-navigation-"));
const preload = join(scratch, "embedding.mjs");
writeFileSync(preload, `globalThis.__perryEmbedders = new Map([["settings-fixture", Promise.resolve(async texts => texts.map(() => [1,0]))]]); globalThis.__perryEmbeddersReady = new Set(["settings-fixture"]); const nativeFetch=globalThis.fetch; globalThis.fetch=(input,...args)=>{const url=typeof input==='string'?input:input.url??String(input); if(!/^https?:\\/\\/(127\\.0\\.0\\.1|localhost)(:|\\/)/.test(url)) throw Error('External network disabled in settings fixture'); return nativeFetch(input,...args);};`);
const app = await perry({ name: "settings-navigation", outDir, engine: "codex", runnerEnv: home => ({ CODEX_HOME: join(home, "empty-codex") }),
  env: { PERRY_EMBED_MODEL: "settings-fixture", NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preload).href}` } });
app.start("server");
try {
  await app.until(() => fetch(`${app.BASE}/api/backend/http/health`).then(r => r.ok, () => false), "production server", 60);
  await app.call("dashboard:skipOnboarding", { key: app.KEY });
  const browser = await app.openBrowser();
  for (const mode of [{ name: "desktop-light", width: 1280, height: 900, theme: "light" }, { name: "phone-dark", width: 390, height: 844, theme: "dark" }]) {
    await browser.send("Emulation.setDeviceMetricsOverride", { width: mode.width, height: mode.height, deviceScaleFactor: 1, mobile: false });
    await browser.evaluate(`localStorage.setItem('perry.theme', ${JSON.stringify(mode.theme)}); true`);
    await browser.send("Page.navigate", { url: `${app.BASE}/settings/general` });
    await app.until(() => browser.evaluate(`Boolean(document.querySelector('section[aria-label="Appearance"]'))`), "general settings", 30);
    for (const section of SETTINGS_SECTIONS) {
      try {
        if (mode.width < 1024) {
          await browser.evaluate(`document.querySelector('[aria-label="Settings section"]').click(); true`);
          await app.until(() => browser.evaluate(`Boolean([...document.querySelectorAll('[role=option]')].find(el=>el.textContent.trim()===${JSON.stringify(section.label)}))`), `${section.label} option`, 10);
          await browser.evaluate(`[...document.querySelectorAll('[role=option]')].find(el=>el.textContent.trim()===${JSON.stringify(section.label)}).click(); true`);
        } else {
          await browser.evaluate(`document.querySelector('nav[aria-label="Settings"] a[href="/settings/${section.slug}"]').click(); true`);
        }
        await app.until(() => browser.evaluate(`location.pathname === '/settings/${section.slug}' && Boolean(document.querySelector('section[aria-label]')) && !document.querySelector('[data-slot=skeleton]')`), `${section.label} settled`, 15);
        await browser.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
        const state = await browser.evaluate(`(() => ({ path: location.pathname, width: innerWidth, scrollWidth: document.documentElement.scrollWidth, theme: document.documentElement.className, selected: ${mode.width < 1024 ? "document.querySelector('[aria-label=\"Settings section\"] [data-slot=select-value]')?.textContent.trim()" : "document.querySelector('nav[aria-label=\"Settings\"] a[aria-current=page]')?.textContent.trim()"}, text: document.querySelector('main')?.innerText.slice(-600) }))()`) as { path: string; width: number; scrollWidth: number; theme: string; selected?: string; text?: string };
        app.check(`${mode.name}: ${section.slug}`, state.selected === section.label && state.scrollWidth <= state.width + 1 && state.theme.includes(mode.theme) && Boolean(state.text?.trim()), state);
      } catch (error) { app.check(`${mode.name}: ${section.slug}`, false, String(error)); }
    }
  }
  app.check("no uncaught browser errors", browser.errors.length === 0, browser.errors);
} catch (error) { app.check("journey completed", false, String(error)); }
finally {
  const passed = await app.finish();
  try { rmSync(scratch, { recursive: true, force: true }); } catch { console.error(`Fixture preload remains at ${scratch}`); }
  process.exitCode = passed ? 0 : 1;
}
