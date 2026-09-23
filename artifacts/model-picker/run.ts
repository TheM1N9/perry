import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openChat, sleep } from "../browser";

const [, , outDir, dashboardKey] = process.argv;
const base = "http://localhost:3005";
mkdirSync(outDir, { recursive: true });
const { evaluate, send, errors, close } = await openChat(base, dashboardKey);

// A draft chat: the picker's choice stays in the browser and nothing is sent or saved.
await evaluate(`document.querySelector('.chat-header-new').click(); true`);
const before = await evaluate(`new Promise((resolve, reject) => {
  const start = Date.now();
  const tick = () => {
    const select = document.querySelector('select.chat-model');
    const groups = select ? [...select.querySelectorAll('optgroup')] : [];
    const gateway = groups.find((group) => group.label === 'AI Gateway');
    if (gateway && gateway.children.length > 1) return resolve({
      selected: select.value,
      title: select.title,
      insidePromptBox: !!select.closest('.chat-composer-box'),
      groups: groups.map((group) => ({ label: group.label, count: group.children.length, first: [...group.children].slice(0, 3).map((option) => ({ value: option.value, text: option.textContent })) })),
    });
    if (Date.now() - start > 30000) return reject(new Error('gateway models never loaded'));
    setTimeout(tick, 250);
  };
  tick();
})`);

const target = await evaluate(`(() => {
  const option = [...document.querySelectorAll('select.chat-model optgroup[label="AI Gateway"] option')].find((item) => item.value.startsWith('gateway:openai/')) ?? document.querySelector('select.chat-model optgroup[label="AI Gateway"] option:last-child');
  return option.value;
})()`);
const after = await evaluate(`(async () => {
  const select = document.querySelector('select.chat-model');
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(target)});
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 500));
  return { selected: select.value, title: select.title, draft: !location.pathname.startsWith('/chat/') };
})()`);

const composer = await evaluate(`(() => { const r = document.querySelector('.chat-composer-wrap').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
const shot = await send("Page.captureScreenshot", { format: "png", clip: { x: composer.x - 16, y: composer.y - 16, width: composer.width + 32, height: composer.height + 32, scale: 1 } });
writeFileSync(join(outDir, "composer-model-picker.png"), Buffer.from(shot.data, "base64"));

type Group = { label: string; count: number };
const codex = (before.groups as Group[]).find((group) => group.label === "Codex subscription");
const gateway = (before.groups as Group[]).find((group) => group.label === "AI Gateway");
const pass = before.insidePromptBox && codex !== undefined && codex.count >= 1 && gateway !== undefined && gateway.count > 1
  && before.selected.startsWith("codex:") && after.selected === target && after.title.startsWith("AI Gateway") && after.draft
  && errors.length === 0;
const result = { ranAt: new Date().toISOString(), url: `${base}/chat`, before, picked: target, after, pageErrors: errors, nothingSent: true, pass };
writeFileSync(join(outDir, "result.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
close();
process.exit(pass ? 0 : 1);
