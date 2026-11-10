import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FAKE_AGENT, perry, sleep } from "../engine-acp/harness";

// bun artifacts/file-links/run.ts <outDir>
// A reply's link to a file on this computer opens the file, not Perry again.
// Before, a path like /Users/you/notes.md became http://localhost:7377/Users/you/notes.md,
// Perry's "not found" page in a new tab, and a file:// link was emptied to "",
// which opened Perry itself.
//
// No model runs: the engine is the fake ACP agent playing Grok Build, its EDIT
// prompt writing one file as an edit step (which registers it for the chat,
// codex.ts linkFiles) and then replying word for word. Everything else is real:
// a fresh Perry from the production build (`pnpm build` first), its runner, and
// the chat in headless Chrome.
//
// Ways it could fail, written down before the checks:
//   1. A link to the file, by absolute path, opens anything but the file.
//   2. The same file named other ways (file://, relative, ~-less tail, with a
//      ":12" line) is not found, or is found as another file.
//   3. A path to a file the chat never touched is still a link, and goes to Perry
//      (or worse, is served: only the chat's own files may be).
//   4. Web links stop opening in a new tab, or one of Perry's pages (/todos) leaves
//      the app for a new tab or turns into a file.
//   5. A link anywhere in the reply points back at Perry's origin and is not one of its pages.
//   6. The file link serves the wrong bytes, or serves them as a page that can run.
//   7. The page throws.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/file-links/run.ts <outDir>");
let fakeHome = "";
const p = await perry({
  name: "file-links",
  outDir,
  runnerEnv: (home) => {
    fakeHome = join(home, "fake-grok");
    mkdirSync(fakeHome, { recursive: true });
    writeFileSync(join(fakeHome, "grok-signed-in"), "yes");
    mkdirSync(join(home, "no-codex"), { recursive: true });
    mkdirSync(join(home, "no-claude"), { recursive: true });
    return { PERRY_GROK_COMMAND: `${process.execPath} ${FAKE_AGENT} --profile grok`, FAKE_ACP_HOME: fakeHome, CODEX_HOME: join(home, "no-codex"), CLAUDE_CONFIG_DIR: join(home, "no-claude") };
  },
});
const { KEY, BASE, call, check, notes, until } = p;
const dir = join(p.home, "work", "report");
mkdirSync(dir, { recursive: true });
const FILE = join(dir, "summary.md");
const TEXT = "# Summary\nThe numbers went up.\n";
const OUTSIDE = join(p.home, "never-touched.txt");
writeFileSync(OUTSIDE, "not this chat's\n");
const REPLY = [
  "I wrote it:",
  "",
  `- absolute: [summary.md](${FILE})`,
  `- file url: [as file url](file://${FILE})`,
  `- relative: [relative](report/summary.md)`,
  `- with a line: [line 2](${FILE}:2)`,
  `- elsewhere: [never touched](${OUTSIDE})`,
  `- web: [example](https://example.com/)`,
  `- page: [your to-dos](/todos)`,
  "",
].join("\n");

type Browser = NonNullable<ReturnType<typeof p.browser>>;
let ok = false;
try {
  p.start("server");
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
  p.start("runner");
  await until(async () => (await call<Array<{ online: boolean; engines: Array<{ kind: string; signedIn: boolean }> }>>("engines:list", { key: KEY }))
    .some((item) => item.online && item.engines.some((engine) => engine.kind === "grok" && engine.signedIn)), "the runner with Grok signed in", 120);
  await call("dashboard:setDefaultAccess", { key: KEY, access: "full" });
  const chat = await call<string>("dashboard:createChat", { key: KEY });
  await call("dashboard:setChatModel", { key: KEY, id: chat, model: "grok-fake-fast", engine: "grok" });

  const b = await p.openBrowser() as Browser;
  const { evaluate, send } = b;
  const waitFor = (test: string, what: string, seconds = 30) => until(() => evaluate(`Boolean(${test})`), what, seconds);
  await send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `${BASE}/chat/${chat}` });
  await waitFor(`document.querySelector("#composer")`, "the chat to open");
  await call("dashboard:sendChat", { key: KEY, id: chat, text: `EDIT ${JSON.stringify({ path: FILE, text: TEXT, reply: REPLY })}` });
  await waitFor(`!document.querySelector("[data-thinking], [data-streaming]") && [...document.querySelectorAll('[data-role="assistant"] a')].some((a) => a.textContent === "example")`, "the reply", 90);
  // The chat's files arrive in their own query; the links follow.
  await waitFor(`document.querySelectorAll('[data-role="assistant"] [data-file-link]').length >= 4`, "the file links", 20).catch(() => {});
  await sleep(500);

  const links = await evaluate(`(() => {
    const reply = [...document.querySelectorAll('[data-role="assistant"]')].at(-1);
    const named = (text) => [...reply.querySelectorAll("a, [data-file-path]")].find((el) => el.textContent.trim() === text);
    return Object.fromEntries(["summary.md", "as file url", "relative", "line 2", "never touched", "example", "your to-dos"].map((text) => {
      const el = named(text);
      return [text, el ? { tag: el.tagName, href: el.getAttribute("href"), target: el.getAttribute("target"), file: el.hasAttribute("data-file-link"), path: el.hasAttribute("data-file-path") } : null];
    }));
  })()`) as Record<string, { tag: string; href: string | null; target: string | null; file: boolean; path: boolean } | null>;
  notes.links = links;
  const fileUrl = links["summary.md"]?.href ?? "";
  check("absolutePathOpensTheFile", Boolean(links["summary.md"]?.file && /^\/api\/media\/\w+\?preview$/.test(fileUrl) && links["summary.md"]?.target === "_blank"), links["summary.md"]);
  check("otherWaysToNameIt", ["as file url", "relative", "line 2"].every((name) => links[name]?.file && links[name]?.href === fileUrl), ["as file url", "relative", "line 2"].map((name) => links[name]));
  check("untouchedFileNotALink", links["never touched"]?.tag === "SPAN" && links["never touched"].path && links["never touched"].href === null, links["never touched"]);
  check("webLinkNewTab", links.example?.href === "https://example.com/" && links.example.target === "_blank", links.example);
  check("perryPageStaysInApp", links["your to-dos"]?.href === "/todos" && links["your to-dos"].target === null && !links["your to-dos"].file, links["your to-dos"]);

  // Nothing in the reply leads back to Perry but its pages and the media server.
  const strays = await evaluate(`[...[...document.querySelectorAll('[data-role="assistant"]')].at(-1).querySelectorAll("a[href]")]
    .map((a) => a.href).filter((href) => href.startsWith(location.origin) && !/^\\/(todos|api\\/media\\/)/.test(new URL(href).pathname))`) as string[];
  check("noLinkBackToPerry", strays.length === 0, strays);

  // What the link serves: the file's own words, as text that cannot run.
  const served = await evaluate(`fetch(${JSON.stringify(fileUrl)}).then(async (r) => ({ status: r.status, type: r.headers.get("content-type"), body: await r.text() }))`) as { status: number; type: string; body: string };
  notes.served = served;
  check("servesTheFile", served.status === 200 && served.body === TEXT && /^text\/plain/.test(served.type ?? ""), served);
  // A path the chat never touched is not served by guessing its id either: the media server only knows registered rows.
  const files = await call<Array<{ path: string }>>("dashboard:getChatFiles", { key: KEY, id: chat });
  check("onlyTheChatsFiles", files.length === 1 && files[0]!.path === FILE, files);

  const image = await send("Page.captureScreenshot", { format: "png" }) as { data: string };
  writeFileSync(join(outDir, "links.png"), Buffer.from(image.data, "base64"));
  check("noPageErrors", b.errors.length === 0, b.errors);
  ok = true;
} catch (error) {
  notes.stoppedAt = String(error);
  check("completed", false);
} finally {
  notes.fakeLog = p.fakeLog(fakeHome).filter((entry) => entry.finished).slice(-3);
}
const passed = await p.finish({ ok });
process.exit(passed ? 0 : 1);
