import { mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { FAKE_AGENT, perry, sleep } from "../engine-acp/harness";

// bun artifacts/brain-ui/shots.ts <outDir> <label>
// Brain and a project's page, light and dark, on a fresh Perry from the production build
// (`pnpm build` first) with the same seed each time, so a build from before a change and one
// from after it can be put side by side (<label> is "before" or "after"). No runner starts;
// Codex and Claude Code are signed out in folders of their own and Grok is the fake agent, so
// nothing reaches a real model. This computer's name is masked as THIS-PC in every picture.
// It fails if either page throws, or does not show.

const [outDir, label = "after"] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/brain-ui/shots.ts <outDir> <before|after>");
const p = await perry({
  name: "brain-ui",
  outDir,
  runnerEnv: (home) => {
    const fakeHome = join(home, "fake-grok");
    const codexHome = join(home, "codex-signed-out");
    const claudeHome = join(home, "claude-signed-out");
    for (const dir of [fakeHome, codexHome, claudeHome]) mkdirSync(dir, { recursive: true });
    return { PERRY_GROK_COMMAND: `${process.execPath} ${FAKE_AGENT} --profile grok`, FAKE_ACP_HOME: fakeHome, CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome, ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "" };
  },
});
const { KEY, call, check, until } = p;

try {
  p.start("server");
  await until(() => fetch(`${p.BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 120);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});

  // The same seed every time: everyone's memory and pages, and a project with its own.
  await call("persona:writeUser", { text: "# About Alex\n\n- Lives in Pune.\n- Likes short answers.\n", by: "owner" });
  await call("memories:add", { text: "Prefers trains to flights for trips under six hours.", tags: [], source: "e2e", kind: "core", origin: "owner" });
  await call("memories:add", { text: "Booked passport photos for Saturday at 11:00.", tags: [], source: "e2e", kind: "daily", origin: "owner" });
  await call("notes:create", { key: KEY, title: "Reading list", content: "- The Overstory\n- Piranesi" });
  const project = await call<string>("projects:create", { key: KEY, name: "Hackonomics scripts", instructions: "Scripts for the Hackonomics YouTube channel.\nShort punchy sentences, no jargon.\nEnd every script with one question for the comments." });
  await call("memories:add", { text: "Every Hackonomics outro ends with the channel's catchphrase.", tags: [], source: "e2e", kind: "core", origin: "owner", projectId: project });
  await call("memories:add", { text: "The sponsor for October is a budgeting app.", tags: [], source: "e2e", kind: "core", origin: "tool", projectId: project });
  await call("memories:add", { text: "Recorded the intro for episode 11.", tags: [], source: "e2e", kind: "daily", origin: "owner", projectId: project });
  await call("notes:create", { key: KEY, title: "Episode 12 plan", content: "Open on the sponsor read.", projectId: project });
  const style = await call<string>("notes:create", { key: KEY, title: "House style", content: "No jargon, ever.", projectId: project });
  await call("pages:pin", { key: KEY, id: style, pinned: true });
  const chat = await call<string>("dashboard:createChat", { key: KEY, projectId: project });
  await call("dashboard:renameChat", { key: KEY, id: chat, title: "Compound interest episode" });

  const browser = await p.openBrowser();
  const { evaluate, send } = browser;
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1100, deviceScaleFactor: 1, mobile: false });
  const waitFor = (test: string, what: string) => until(() => evaluate(`Boolean(${test})`), what, 30);
  const machine = hostname();
  const shot = async (name: string) => {
    if (machine.length > 1) await evaluate(`(() => { const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); for (let node; (node = walk.nextNode());) node.nodeValue = node.nodeValue.split(${JSON.stringify(machine)}).join("THIS-PC"); return true; })()`);
    writeFileSync(join(outDir, `${label}-${name}.png`), Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));
  };
  const shown: Record<string, boolean> = {};
  for (const scheme of ["light", "dark"] as const) {
    await evaluate(`localStorage.setItem("perry.theme", ${JSON.stringify(scheme)}); true`);
    for (const [name, path, words] of [["brain", "/brain", "Reading list"], ["project", `/projects/${project}`, "Compound interest episode"]] as const) {
      await send("Page.navigate", { url: `${p.BASE}${path}` });
      shown[`${name}-${scheme}`] = await waitFor(`document.documentElement.classList.contains("dark") === ${scheme === "dark"} && document.querySelector("main")?.innerText.includes(${JSON.stringify(words)})`, `${name}, ${scheme}`).then(() => true, () => false);
      await sleep(800);
      await shot(`${name}-${scheme}`);
    }
  }
  check("bothPagesShow", Object.values(shown).every(Boolean), shown);
  check("noPageErrors", browser.errors.length === 0, browser.errors);
} catch (error) {
  p.notes.stoppedAt = String(error instanceof Error ? error.stack ?? error.message : error);
  check("completed", false);
}
process.exit(await p.finish({ label }) ? 0 : 1);
