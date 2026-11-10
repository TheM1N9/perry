// Full production UI/API journey; synthetic approval requests, no engine runs.
import { join, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { perry } from '../engine-acp/harness';
const out = resolve(process.argv[2] ?? 'artifacts/tool-approval-routing/app-results');
mkdirSync(out, { recursive: true });
const p = await perry({ name: 'tool-confirmations', outDir: out, engine: null,
  runnerEnv: home => {
    const codex = join(home, 'empty-codex'), claude = join(home, 'empty-claude');
    mkdirSync(codex, { recursive: true }); mkdirSync(claude, { recursive: true });
    return { CODEX_HOME: codex, CLAUDE_CONFIG_DIR: claude };
  },
});
let passed = false;
try {
  p.start('server');
  await p.until(() => fetch(`${p.BASE}/api/backend/http/health`).then(r => r.ok, () => false), 'isolated server', 90);
  await p.call('dashboard:skipOnboarding', { key: p.KEY });
  const token = 'synthetic-ui-approval-runner';
  await p.call('runner:createToken', { token, name: 'Synthetic computer' });
  const id = await p.call<string>('dashboard:createChat', { key: p.KEY });
  await p.openBrowser(); const browser = p.browser()!;
  await browser.send('Page.navigate', { url: `${p.BASE}/chat/${id}` });
  await p.until(() => browser.evaluate(`Boolean(document.querySelector('input[type=file]'))`), 'chat composer');
  const make = () => p.call<{ id: string; next: string }>('approvals:request', {
    token, kind: 'tool', title: 'Confirm request from synthetic-github', detail: 'Create the fixture issue in the synthetic repository?', conversationId: id,
  });
  const card = `document.querySelector('article[aria-label="Synthetic computer wants to confirm a tool request"]')`;
  const requested = await make();
  await p.until(() => browser.evaluate(`Boolean(${card})`), 'tool confirmation card');
  p.check('pendingCardHasRequest', await browser.evaluate(`${card}.innerText.includes('synthetic-github') && ${card}.innerText.includes('fixture issue')`));
  p.check('noAlwaysAllow', await browser.evaluate(`![...${card}.querySelectorAll('button')].some(b => b.textContent.includes('Always allow'))`));
  p.check('requestStillPendingBeforeClick', await p.call('approvals:decision', { token, id: requested.id }) === 'pending');
  const screenshot = await browser.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(out, 'tool-confirmation-desktop.png'), Buffer.from(screenshot.data, 'base64'));
  // Use native focus and keyboard activation for the first approval.
  p.notes.keyboardFocus = await browser.evaluate(`(() => { const button = [...${card}.querySelectorAll('button')].find(b => b.textContent.trim() === 'Approve'); button.focus(); return { focused: document.activeElement === button, tag: button.tagName, disabled: button.disabled }; })()`);
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13 });
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await p.until(async () => await p.call('approvals:decision', { token, id: requested.id }) === 'approved', 'keyboard approval');
  p.check('keyboardApprovalReachedBackend', true);
  await p.until(() => browser.evaluate(`!${card}`), 'answered card removed');
  const declined = await make(); await p.until(() => browser.evaluate(`Boolean(${card})`), 'second card');
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  const mobile = await browser.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(out, 'tool-confirmation-mobile.png'), Buffer.from(mobile.data, 'base64'));
  p.check('mobileControlsVisible', await browser.evaluate(`(() => { const box = ${card}.getBoundingClientRect(); return box.width <= 390 && [...${card}.querySelectorAll('button')].every(b => { const r=b.getBoundingClientRect(); return r.width > 40 && r.height >= 30; }); })()`));
  await browser.evaluate(`[...${card}.querySelectorAll('button')].find(b => b.textContent.trim() === 'Decline').click(); true`);
  await p.until(async () => await p.call('approvals:decision', { token, id: declined.id }) === 'declined', 'decline reached backend');
  p.check('declineReachedBackend', true);
  await p.until(() => browser.evaluate(`!${card}`), 'declined card removed');
  p.check('noBrowserErrors', browser.errors.length === 0, browser.errors);
  p.check('noModelTurns', p.rows('codexTurns').length === 0);
  passed = Object.values(p.checks).every(Boolean);
} catch (error) { p.check('completed', false, String(error)); }
finally { passed = await p.finish({ scope: 'UI/API with synthetic approvals; no engine or account action' }) && passed; }
if (!passed) process.exitCode = 1;
