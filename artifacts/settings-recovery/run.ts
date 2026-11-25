import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { perry } from "../engine-acp/harness";

const outDir = resolve(process.argv[2] ?? "node_modules/.cache/settings-recovery");
mkdirSync(outDir, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "perry-settings-provider-"));
const preload = join(scratch, "embedding.mjs");
writeFileSync(preload, `globalThis.__perryEmbedders = new Map([["settings-fixture", Promise.resolve(async texts => texts.map(() => [1,0]))]]); globalThis.__perryEmbeddersReady = new Set(["settings-fixture"]); const nativeFetch=globalThis.fetch; globalThis.fetch=(input,...args)=>{const url=typeof input==='string'?input:input.url??String(input); if(!/^https?:\\/\\/(127\\.0\\.0\\.1|localhost)(:|\\/)/.test(url)) throw Error('External network disabled in settings fixture'); return nativeFetch(input,...args);};`);
const app = await perry({ name: "settings-recovery", outDir, engine: "codex", runnerEnv: home => ({ CODEX_HOME: join(home, "empty-codex") }),
  env: { PERRY_EMBED_MODEL: "settings-fixture", NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preload).href}` } });
const checks: Record<string, boolean> = {};
const evidence: Record<string, unknown> = {};
const check = (name: string, ok: boolean, detail?: unknown) => { checks[name] = ok; if (detail !== undefined) evidence[name] = detail; console.log(`${ok ? "ok" : "FAIL"} ${name}`); };
const server = app.start("server");
let browser: Awaited<ReturnType<typeof app.openBrowser>> | undefined;
const selector = (label: string) => `[aria-label="${label}"]`;
try {
  await app.until(() => fetch(`${app.BASE}/api/backend/http/health`).then(r => r.ok, () => false), "production server", 60);
  await app.call("dashboard:skipOnboarding", { key: app.KEY });
  await app.call("dashboard:setManners", { key: app.KEY, quietHours: { start: "22:00", end: "07:00" }, dailyLimit: 5 });
  browser = await app.openBrowser();
  await browser.send("Page.navigate", { url: `${app.BASE}/settings/notifications` });
  await app.until(() => browser!.evaluate(`document.querySelector(${JSON.stringify(selector("Quiet until: hours"))})?.value === '07'`), "quiet-hours controls", 30);
  const type = async (label: string, value: string) => {
    await browser!.evaluate(`document.querySelector(${JSON.stringify(selector(label))}).focus(); true`);
    await browser!.send("Input.insertText", { text: value });
  };
  await browser.evaluate(`(() => { const native=window.fetch; window.__holdManners=true; window.fetch=async function(input,init){const path=init?.body&&JSON.parse(init.body).path; const response=await native.apply(this,arguments); if(path==='dashboard:getManners'&&window.__holdManners){window.__holdManners=false; const body=await response.clone().json(); window.__heldManners=body.value; return new Promise(resolve=>{window.__releaseManners=()=>{window.fetch=native;resolve(response);};});} return response;}; return true; })()`);
  await type("Quiet from: hours", "21");
  await browser.evaluate(`document.querySelector(${JSON.stringify(selector("Quiet until: hours"))}).focus(); true`);
  await app.until(() => browser!.evaluate(`Boolean(window.__heldManners)`), "held confirmed save response", 20);
  await browser.send("Input.insertText", { text: "08" });
  check("newer quiet end is visible before acknowledgement", await browser.evaluate(`document.querySelector(${JSON.stringify(selector("Quiet until: hours"))}).value === '08'`) as boolean);
  evidence.held = await browser.evaluate(`window.__heldManners`);
  await browser.evaluate(`window.__releaseManners(); true`);
  await app.until(() => browser!.evaluate(`document.body.innerText.includes('Quiet from 21:00')`), "first save completion", 20);
  await browser.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  const end = await browser.evaluate(`document.querySelector(${JSON.stringify(selector("Quiet until: hours"))}).value`);
  check("earlier save preserves newer quiet end", end === "08", { expected: "08", actual: end });
  await browser.evaluate(`document.activeElement.blur(); true`);
  await app.until(async () => (await app.call<{ quietHours?: { end: string } }>("dashboard:getManners", { key: app.KEY })).quietHours?.end === "08:00", "newer end saved on blur", 12).catch(() => {});
  const manners = await app.call<{ quietHours?: { start: string; end: string }; dailyLimit?: number }>("dashboard:getManners", { key: app.KEY });
  check("both times and daily limit persist", manners.quietHours?.start === "21:00" && manners.quietHours.end === "08:00" && manners.dailyLimit === 5, manners);
  await app.call("dashboard:setManners", { key: app.KEY, quietHours: { start: "22:00", end: "07:00" }, dailyLimit: 5 });
  await app.until(() => browser!.evaluate(`document.querySelector(${JSON.stringify(selector("Quiet from: hours"))}).value === '22'`), "reset confirmed settings", 15);
  await browser.evaluate(`(() => { const native=window.fetch; window.__heldLimit=null; window.fetch=async function(input,init){const path=init?.body&&JSON.parse(init.body).path; const response=await native.apply(this,arguments); if(path==='dashboard:getManners'&&!window.__heldLimit){const body=await response.clone().json(); if(body.value?.dailyLimit===8){window.__heldLimit=body.value; return new Promise(resolve=>{window.__releaseLimit=()=>{window.fetch=native;resolve(response);};});}} return response;}; return true; })()`);
  await browser.evaluate(`document.querySelector('[aria-label="Daily limit"]').click(); true`);
  await app.until(() => browser!.evaluate(`[...document.querySelectorAll('[role=option]')].some(el=>el.textContent.includes('8 a day'))`), "daily limit options", 10);
  await browser.evaluate(`[...document.querySelectorAll('[role=option]')].find(el=>el.textContent.includes('8 a day')).click(); true`);
  await app.until(() => browser!.evaluate(`Boolean(window.__heldLimit)`), "held updated daily limit", 20);
  await type("Quiet from: hours", "21");
  await browser.evaluate(`document.querySelector(${JSON.stringify(selector("Quiet until: hours"))}).focus(); true`);
  await app.until(async () => (await app.call<{ quietHours?: { start: string } }>("dashboard:getManners", { key: app.KEY })).quietHours?.start === "21:00", "quiet hours committed during limit acknowledgement", 15);
  const concurrent = await app.call<{ dailyLimit?: number }>("dashboard:getManners", { key: app.KEY });
  check("quiet save cannot revert a pending daily limit choice", concurrent.dailyLimit === 8, { expected: 8, actual: concurrent.dailyLimit });
  await browser.evaluate(`window.__releaseLimit(); true`);
  await app.call("dashboard:setManners", { key: app.KEY, quietHours: { start: "22:00", end: "07:00" }, dailyLimit: 5 });
  await app.until(() => browser!.evaluate(`document.querySelector(${JSON.stringify(selector("Quiet from: hours"))}).value === '22'`), "reset before failed save", 15);
  await browser.evaluate(`(() => {const native=window.fetch;window.fetch=function(input,init){if(init?.body&&JSON.parse(init.body).path==='dashboard:setManners'){window.fetch=native;return Promise.resolve(new Response(JSON.stringify({error:'Settings temporarily unavailable'}),{status:503,headers:{'content-type':'application/json'}}));}return native.apply(this,arguments);};return true;})()`);
  await type("Quiet from: hours", "23");
  await browser.evaluate(`document.querySelector(${JSON.stringify(selector("Quiet until: hours"))}).focus(); true`);
  await app.until(() => browser!.evaluate(`document.body.innerText.includes('Settings temporarily unavailable')`), "save failure feedback", 15);
  await app.call("dashboard:setManners", { key: app.KEY, quietHours: { start: "22:00", end: "07:00" }, dailyLimit: 8 });
  await app.until(() => browser!.evaluate(`document.querySelector('[aria-label="Daily limit"]').textContent.includes('8 a day')`), "unrelated remote setting refresh", 15);
  await browser.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  const failedDraft = await browser.evaluate(`document.querySelector(${JSON.stringify(selector("Quiet from: hours"))}).value`);
  check("failed quiet draft survives unrelated setting refresh", failedDraft === "23", { expected: "23", actual: failedDraft });
  await browser.evaluate(`document.querySelector(${JSON.stringify(selector("Quiet from: hours"))}).focus(); true`);
  await browser.evaluate(`document.activeElement.blur(); true`);
  await app.until(async () => (await app.call<{ quietHours?: { start: string } }>("dashboard:getManners", { key: app.KEY })).quietHours?.start === "23:00", "failed quiet draft saved on retry", 8).catch(() => {});
  const retried = await app.call<{ quietHours?: { start: string }; dailyLimit?: number }>("dashboard:getManners", { key: app.KEY });
  check("retry commits the visible failed draft", retried.quietHours?.start === "23:00" && retried.dailyLimit === 8, retried);
  await app.call("dashboard:setManners", { key: app.KEY, setting: "quietHours" });
  const quietOff = await app.call<{ quietHours?: unknown; dailyLimit?: number }>("dashboard:getManners", { key: app.KEY });
  check("turning quiet hours off preserves the daily limit", !quietOff.quietHours && quietOff.dailyLimit === 8, quietOff);
  await app.call("dashboard:setManners", { key: app.KEY, setting: "quietHours", quietHours: { start: "21:00", end: "08:00" } });
  await app.call("dashboard:setManners", { key: app.KEY, setting: "dailyLimit" });
  const limitOff = await app.call<{ quietHours?: { start: string }; dailyLimit?: number }>("dashboard:getManners", { key: app.KEY });
  check("turning the daily limit off preserves quiet hours", limitOff.quietHours?.start === "21:00" && limitOff.dailyLimit === undefined, limitOff);
  for (const invalid of [
    { name: "same quiet times", args: { setting: "quietHours", quietHours: { start: "08:00", end: "08:00" } }, expected: "different times" },
    { name: "invalid quiet clock", args: { setting: "quietHours", quietHours: { start: "24:00", end: "08:00" } }, expected: "two times" },
    { name: "fractional daily limit", args: { setting: "dailyLimit", dailyLimit: 1.5 }, expected: "whole number" },
    { name: "mixed partial update", args: { setting: "quietHours", dailyLimit: 8 }, expected: "separately" },
  ]) {
    const response = await fetch(`${app.BASE}/api/backend/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "dashboard:setManners", args: { key: app.KEY, ...invalid.args } }) });
    const body = await response.json() as { error?: string };
    check(`${invalid.name} returns repair guidance`, response.status === 400 && Boolean(body.error?.includes(invalid.expected)), { status: response.status, ...body });
  }
  const afterInvalid = await app.call<{ quietHours?: { start: string }; dailyLimit?: number }>("dashboard:getManners", { key: app.KEY });
  check("invalid updates leave confirmed settings intact", afterInvalid.quietHours?.start === "21:00" && afterInvalid.dailyLimit === undefined, afterInvalid);
  await app.call("dashboard:setManners", { key: app.KEY });
  const legacyClear = await app.call<{ quietHours?: unknown; dailyLimit?: number }>("dashboard:getManners", { key: app.KEY });
  check("legacy replacement still clears both settings", legacyClear.quietHours === undefined && legacyClear.dailyLimit === undefined, legacyClear);
  check("no browser errors", browser.errors.length === 0, browser.errors);
  if (Object.values(checks).some(value => !value)) {
    const shot = await browser.send("Page.captureScreenshot", { format: "png" }) as { data: string };
    writeFileSync(join(outDir, "failure.png"), Buffer.from(shot.data, "base64"));
  }
} catch (error) { evidence.error = String(error); checks.completed = false; }
finally {
  browser?.close();
  app.stop(server);
  for (const target of [app.home, scratch]) { try { rmSync(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { evidence.cleanup = target; } }
  const result = { passed: Object.keys(checks).length > 0 && Object.values(checks).every(Boolean), checks, evidence };
  writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
  process.exitCode = result.passed ? 0 : 1;
}
