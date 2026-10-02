import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { perry, sleep } from "../engine-acp/harness";

// bun artifacts/brain/people-shots.ts <outDir> <before|after>
// Issue #218: Brain → People and Settings → People on an install shaped like the owner's, photographed, to compare a
// build from before the fix (run from a checkout of it) with one after. No runner and no engine: memories from before
// pages, with `about` naming several people (comma-separated, or one by one), on daily and core memories, and WhatsApp
// contacts, are seeded as an older Perry left them, and Perry is started again so it moves them into pages.

const [outDir, label = "after"] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/brain/people-shots.ts <outDir> <before|after>");
mkdirSync(outDir, { recursive: true });
const p = await perry({ name: `people-${label}`, outDir, engine: null, runnerEnv: () => ({}) });
const { KEY, call, until, sql, rows } = p;
const DAY = 86_400_000;
const now = Date.now();
const day = (at: number) => new Date(at).toISOString().slice(0, 10);
function seed(table: string, doc: Record<string, unknown>): string {
  const id = `seed${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
  sql(`INSERT INTO "_ids" (id, tbl) VALUES (?, ?)`, [id, table]);
  sql(`INSERT INTO "doc_${table}" (_id, _creationTime, doc) VALUES (?, ?, ?)`, [id, Date.now(), JSON.stringify(doc)]);
  return id;
}
const memory = (doc: Record<string, unknown>) => ({ tags: [], source: "telegram:4242", createdAt: now - DAY * 30, origin: "owner", ...doc });
const startServer = async () => {
  const server = p.start("server");
  await until(() => fetch(`${p.BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 120);
  return server;
};
try {
  let server = await startServer();
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
  await call("contacts:learn", { items: [
    { channel: "whatsapp", externalId: "15550003001@s.whatsapp.net", kind: "person", name: "Juhi" },
    { channel: "whatsapp", externalId: "15550003002@s.whatsapp.net", kind: "person", name: "Vivek" },
    { channel: "whatsapp", externalId: "120363000000000001@g.us", kind: "group", name: "Cricket" },
  ] });
  seed("memories", memory({ text: "Vivek, Juhi and Aadil run the Sunday cricket game.", kind: "core", about: ["Vivek", "Juhi", "Aadil"] }));
  seed("memories", memory({ text: "Had dinner with Juhi, Aadil and Vivek.", kind: "daily", day: day(now - DAY * 2), createdAt: now - DAY * 2, about: ["Juhi,Aadil,Vivek"] }));
  seed("memories", memory({ text: "Called Manvi about the HackerRank test.", kind: "daily", day: day(now - DAY), createdAt: now - DAY, about: ["Manvi"] }));
  seed("memories", memory({ text: "Pranav and Ishita Shree came over.", kind: "daily", day: day(now - DAY * 4), createdAt: now - DAY * 4, about: ["Pranav, Ishita Shree"] }));
  seed("memories", memory({ text: "Manvi is the owner's sister.", kind: "core", about: ["Manvi"] }));
  p.stop(server);
  await sleep(2_000);
  server = await startServer();
  const people = rows("notes").filter((row) => row.kind === "person").map((row) => row.title).sort();
  p.check("seeded", true, { people });

  const browser = await p.openBrowser();
  const { evaluate, send } = browser;
  const shot = async (name: string) => writeFileSync(join(outDir, `${label}-${name}.png`), Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));
  const waitFor = (test: string, ms = 30_000) => evaluate(`new Promise((resolve, reject) => { const start = Date.now(); const tick = () => { let ok = false; try { ok = Boolean(${test}); } catch {} ok ? resolve(true) : Date.now() - start > ${ms} ? reject(new Error("timed out")) : setTimeout(tick, 150); }; tick(); })`);
  await evaluate(`localStorage.setItem("perry.theme", "light"); true`);
  // Brain on the new build; on a build from before Brain was one entry, the Memory page.
  await send("Page.navigate", { url: `${p.BASE}/memory` });
  await waitFor(`document.querySelector('section[aria-label="Memory pages"]')`);
  await evaluate(`(() => { const heading = [...document.querySelectorAll("h2")].find((item) => item.innerText.trim() === "People"); heading?.scrollIntoView({ block: "start" }); window.scrollBy(0, -80); return true; })()`);
  await sleep(500);
  await shot("brain-people");
  const vivek = rows("notes").find((row) => row.kind === "person" && row.person === "vivek");
  if (vivek) {
    await send("Page.navigate", { url: `${p.BASE}/notes/${vivek._id}` });
    await waitFor(`document.querySelector("[data-note-editor]")`);
    await sleep(1_500);
    await shot("vivek");
  }
  const juhi = rows("notes").find((row) => row.kind === "person" && row.person === "juhi");
  if (juhi) {
    await send("Page.navigate", { url: `${p.BASE}/notes/${juhi._id}` });
    await waitFor(`document.querySelector("[data-note-editor]")`);
    await sleep(1_500);
    await shot("juhi");
  }
  await send("Page.navigate", { url: `${p.BASE}/settings/people` });
  await waitFor(`document.body.innerText.includes("Juhi")`);
  await sleep(1_000);
  await shot("settings-people");
  p.check("noPageErrors", browser.errors.length === 0, browser.errors);
} catch (error) {
  p.notes.stoppedAt = String(error instanceof Error ? error.stack ?? error.message : error);
  p.check("completed", false);
}
process.exit(await p.finish() ? 0 : 1);
